import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { fakeConfig } from './fixtures.mjs';

test('one saved configuration starts a concurrent batch, shows every task, deduplicates retries and keeps resumed sessions exclusive', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(),'codex-dsh-supervisor-test-'));
  const base = fakeConfig(root); const token=randomUUID(); const sockets=new Set(); const servers=[]; const dispatched=[]; let dispatches=0;
  const pipes=Object.fromEntries(['desktop','headless'].map(mode=>[mode,process.platform==='win32'?'\\\\.\\pipe\\codex-dsh-supervisor-test-'+randomUUID():path.join(root,mode+'.sock')]));
  const providerJobs={desktop:[],headless:[]};
  for(const mode of ['desktop','headless']){
    const server=net.createServer(socket=>{
      sockets.add(socket);socket.on('close',()=>sockets.delete(socket));socket.setEncoding('utf8');let buffer='';
      socket.on('data',chunk=>{buffer+=chunk;let cut;while((cut=buffer.indexOf('\n'))>=0){const request=JSON.parse(buffer.slice(0,cut));buffer=buffer.slice(cut+1);void(async()=>{
        assert.equal(request.token,token);let result;
        if(request.method==='doctor')result={mode,protocolVersion:1,dshVersion:'0.2.0-rc.2',instanceId:mode,capabilities:['concurrent-sessions']};
        else if(request.method==='sessions')result=[];
        else if(request.method==='status')result=providerJobs[mode].find(job=>job.jobId===request.params.jobId);
        else if(request.method==='start'){
          dispatches++;await new Promise(resolve=>setTimeout(resolve,60));
          const prior=providerJobs[mode].find(job=>job.requestId===request.params.requestId);
          if(prior){dispatches--;result=prior}else{dispatched.push(request.params);const job={jobId:'fake-'+randomUUID(),sessionId:request.params.sessionId?undefined:randomUUID(),requestId:request.params.requestId,mode,status:request.params.sessionId?'starting':'running',createdAt:new Date().toISOString(),requested:{workspace:root},events:[]};providerJobs[mode].push(job);result=job}
        }else{await new Promise(resolve=>setTimeout(resolve,40));result={instanceId:mode,cursor:providerJobs[mode].length,jobs:providerJobs[mode]}}
        if(!socket.destroyed)socket.end(JSON.stringify({id:request.id,result})+'\n');
      })()}});socket.on('error',()=>{});
    });await new Promise(resolve=>server.listen(pipes[mode],resolve));servers.push(server);
  }
  fs.writeFileSync(path.join(root,'config.json'),JSON.stringify({...base,token,pipes,defaults:{...base.defaults,workspace:root}}));
  const child=spawn(process.execPath,[fileURLToPath(new URL('../server/supervisor.mjs',import.meta.url))],{env:{...process.env,CODEX_DSH_STATE_DIR:root},windowsHide:true,stdio:'ignore'});
  let heartbeat;
  try{
    const infoFile=path.join(root,'supervisor.json');for(let i=0;i<100&&!fs.existsSync(infoFile);i++)await new Promise(resolve=>setTimeout(resolve,10));
    assert.ok(fs.existsSync(infoFile));const info=JSON.parse(fs.readFileSync(infoFile));
    const call=async(method,params={})=>{const response=await fetch(info.url+'/api',{method:'POST',headers:{authorization:'Bearer '+token,'content-type':'application/json'},body:JSON.stringify({method,params:{conversationId:'chat-A',...params}})});return response.json()};
    const blocked=await call('start',{prompt:'fake only'});assert.match(blocked.error.message,/Explicit user permission/);assert.equal(dispatches,0);
    await call('panelHeartbeat',{clientId:'fake-window',visible:true,jobs:[]});
    heartbeat=setInterval(()=>void call('panelHeartbeat',{clientId:'fake-window',visible:true,jobs:Object.values(providerJobs).flat()}).catch(()=>{}),20);
    assert.equal((await call('configuration')).result.status,'missing');
    const missing=await call('resume',{userAuthorized:true,mode:'desktop',sessionId:'original',prompt:'continue',requestId:'first-resume'});assert.match(missing.error.message,/Save this Codex conversation/);assert.equal(dispatches,0);
    const entry=(await call('configure')).result;
    assert.equal(entry.status,'draft');
    assert.match(entry.url,/conversationId=chat-A/);
    const draft=await call('start',{userAuthorized:true,prompt:'fake only',requestId:'draft'});assert.match(draft.error.message,/Save this Codex conversation/);
    await call('saveConfiguration',{configurationId:entry.configurationId,values:{...entry.values,mode:'desktop',model:{provider:'fake',model:'chosen'}}});
    const tasks=[{prompt:'1',requestId:'one'},{prompt:'2',requestId:'two'}];
    assert.equal(dispatches,0);
    const batch=(await call('start_many',{userAuthorized:true,tasks})).result;
    assert.equal(batch.jobs.length,2);assert.equal(batch.errors.length,0);assert.equal(batch.panel.jobsRendered,true);assert.equal(dispatches,2);
    assert.notEqual(batch.jobs[0].sessionId,batch.jobs[1].sessionId);
    const again=(await call('start_many',{userAuthorized:true,tasks})).result;assert.equal(dispatches,2);assert.deepEqual(again.jobs.map(job=>job.jobId),batch.jobs.map(job=>job.jobId));
    assert.equal((await call('configuration')).result.revision,1);
    for(const job of providerJobs.desktop){job.status='completed';job.result=job.requestId.endsWith('one')?'1':'2';job.finishedAt=new Date().toISOString();await call('status',{jobId:job.jobId})}
    const resumed=await Promise.all(batch.jobs.map((job,index)=>call('resume',{userAuthorized:true,mode:'desktop',sessionId:job.sessionId,prompt:String(index+3),requestId:'resume-'+index})));
    assert.ok(resumed.every(reply=>reply.result?.jobId));
    for(const selected of dispatched.slice(2))for(const key of ['workspace','model','preset','permission'])assert.equal(selected[key],undefined);
    const grouped=(await call('list')).result;assert.equal(grouped.jobs.length,4);assert.equal(grouped.subagents.length,2);assert.ok(grouped.subagents.every(agent=>agent.turnCount===2));
    assert.ok(grouped.subagents.every(agent=>agent.status==='starting'&&agent.result===undefined));
    for(const job of providerJobs.desktop.filter(job=>job.status==='starting')){
      job.sessionId=dispatched.find(params=>params.requestId===job.requestId).sessionId;job.status='running';await call('status',{jobId:job.jobId});
    }
    assert.ok((await call('list')).result.subagents.every(agent=>agent.status==='running'));
    assert.equal((await call('configuration')).result.revision,1);assert.equal((await call('configure')).result.configurationId,entry.configurationId);
    const busy=await call('resume',{userAuthorized:true,mode:'desktop',sessionId:batch.jobs[0].sessionId,prompt:'busy',requestId:'busy-resume'});assert.match(busy.error.message,/active.*session/);
    assert.equal((await call('configuration',{conversationId:'chat-B'})).result.status,'missing');
    const unconfigured=await call('start',{conversationId:'chat-B',userAuthorized:true,prompt:'blocked',requestId:'blocked'});assert.match(unconfigured.error.message,/Save this Codex conversation/);assert.equal(dispatches,4);
    await call('panelHeartbeat',{conversationId:'chat-B',clientId:'window-B',visible:true,jobs:[]});
    const fresh=(await call('configure',{conversationId:'chat-B'})).result;
    const cross=await call('saveConfiguration',{conversationId:'chat-B',configurationId:entry.configurationId,values:entry.values});assert.match(cross.error.message,/Unknown configuration/);
    await call('saveConfiguration',{conversationId:'chat-B',configurationId:fresh.configurationId,values:{...fresh.values,mode:'desktop'}});
    const otherParams={conversationId:'chat-B',userAuthorized:true,prompt:'other chat',requestId:'one'};
    const otherPending=call('start',otherParams);
    const otherHeartbeat=setInterval(()=>void call('panelHeartbeat',{conversationId:'chat-B',clientId:'window-B',visible:true,jobs:Object.values(providerJobs).flat()}).catch(()=>{}),20);
    const other=(await otherPending).result;clearInterval(otherHeartbeat);assert.ok(other.jobId);
    assert.equal((await call('list',{conversationId:'chat-B'})).result.jobs.length,1);
    assert.ok((await call('list')).result.jobs.every(job=>job.jobId!==other.jobId));
    const forbidden=await call('status',{jobId:other.jobId});assert.match(forbidden.error.message,/Unknown jobId/);
    const reopened=(await call('open',{dashboard:true})).result;assert.match(reopened.url,/conversationId=chat-A/);assert.equal(dispatches,5);
    clearInterval(heartbeat);await new Promise(resolve=>setTimeout(resolve,30));
    await call('panelHeartbeat',{clientId:'fake-window',closed:true,jobs:[]});
    // Native close/reopen launch is covered with an injected launcher in panel.test.mjs.
    await call('panelHeartbeat',{clientId:'reopened-window',visible:true,jobs:providerJobs.desktop.filter(job=>job.jobId!==other.jobId)});
    assert.equal((await call('open',{dashboard:true})).result.conversationId,'chat-A');assert.equal(dispatches,5);
    assert.equal((await fetch(info.url+'/health')).status,401);
    const form=await fetch(info.url+'/?configure=example');assert.equal(form.status,200);assert.match(await form.text(),/保存配置/);
    const wrongOrigin=await fetch(info.url+'/api',{method:'POST',headers:{authorization:'Bearer '+token,'content-type':'application/json',origin:'https://example.com'},body:'{}'});assert.equal(wrongOrigin.status,403);
    const events=await fetch(info.url+'/events?conversationId=chat-A',{headers:{authorization:'Bearer '+token}});const reader=events.body.getReader();const first=await reader.read();
    const eventText=new TextDecoder().decode(first.value);assert.match(eventText,/fake-/);assert.ok(!eventText.includes(other.jobId));await reader.cancel();
    assert.equal((await fetch(info.url+'/events',{headers:{authorization:'Bearer '+token}})).status,400);
  }finally{
    clearInterval(heartbeat);
    child.kill();for(const socket of sockets)socket.destroy();for(const server of servers)server.close();await new Promise(resolve=>setTimeout(resolve,80));
    assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir())+path.sep)&&path.basename(root).startsWith('codex-dsh-supervisor-test-'));
    fs.rmSync(root,{recursive:true,force:true});
  }
});
