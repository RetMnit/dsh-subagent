import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { fakeConfig, fakeBridgeState } from './fixtures.mjs';

test('one saved configuration starts a concurrent batch, shows every task, deduplicates retries and keeps resumed sessions exclusive', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(),'codex-dsh-supervisor-test-'));
  const token=randomUUID(); const dispatched=[]; const bridgeCalls=[]; let dispatches=0, offline=false;
  const providerJobs={desktop:[],headless:[]};
  const server=http.createServer(async(request,response)=>{
    try{
      let body='';for await(const chunk of request)body+=chunk;const call=JSON.parse(body);bridgeCalls.push(call);
      const {mode,method,params}=call;let result;
      if(['start','prepare','list','status','events','cancel','open'].includes(method))assert.equal(params.client,'codex');
      if(method==='doctor'){if(offline)throw new Error('pipe offline');result={mode,protocolVersion:2,instanceId:mode,capabilities:['concurrent-sessions']};}
      else if(method==='sessions')result=[];
      else if(method==='status')result=providerJobs[mode].find(job=>job.jobId===params.jobId);
      else if(method==='cancel'){result=providerJobs[mode].find(job=>job.jobId===params.jobId);result.status='cancelled';}
      else if(method==='open')result={opened:true};
      else if(method==='start'){
        dispatches++;await new Promise(resolve=>setTimeout(resolve,60));
        const prior=providerJobs[mode].find(job=>job.requestId===params.requestId);
        if(prior){dispatches--;result=prior}else{
          dispatched.push(params);const job={jobId:'job-'+randomUUID(),client:params.client,meta:params.meta,sessionId:params.sessionId?undefined:'dsh-bridge-'+randomUUID(),requestId:params.requestId,mode,status:params.sessionId?'starting':'running',createdAt:new Date().toISOString(),requested:{workspace:root},events:[]};providerJobs[mode].push(job);result=job;
        }
      }else{await new Promise(resolve=>setTimeout(resolve,40));result={instanceId:mode,cursor:providerJobs[mode].length,jobs:providerJobs[mode]}}
      response.end(JSON.stringify({result}));
    }catch(error){response.end(JSON.stringify({error:{message:error.message}}))}
  });await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const endpoint='http://127.0.0.1:'+server.address().port;
  const base=fakeConfig(root,{endpoint});
  fs.writeFileSync(path.join(root,'config.json'),JSON.stringify({...base,token}));
  const child=spawn(process.execPath,[fileURLToPath(new URL('../server/supervisor.mjs',import.meta.url))],{env:{...process.env,CODEX_DSH_STATE_DIR:root,DSH_BRIDGE_STATE_DIR:fakeBridgeState(root)},windowsHide:true,stdio:'ignore'});
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
    const eventText=new TextDecoder().decode(first.value);assert.match(eventText,/job-/);assert.ok(!eventText.includes(other.jobId));await reader.cancel();
    assert.equal((await fetch(info.url+'/events',{headers:{authorization:'Bearer '+token}})).status,400);
    assert.ok(bridgeCalls.filter(call=>call.method==='events'||call.method==='status'||call.method==='list').every(call=>call.options.start===false));
    const doctor=(await call('doctor')).result;assert.equal(doctor.runtime.version,'fake-runtime');
    assert.equal((await call('cancel',{jobId:batch.jobs[0].jobId})).result.status,'cancelled');
    assert.equal((await call('open',{jobId:batch.jobs[0].jobId})).result.opened,true);
    for(const selected of dispatched){assert.equal(selected.client,'codex');assert.equal(selected.configurationId,undefined);assert.equal(selected.configurationRevision,undefined);assert.ok(selected.meta.configurationId);assert.equal(selected.meta.configurationRevision,1);assert.ok(selected.meta.conversationId);}
    const startupFailure={code:'dsh/compatibility',message:'shared bundle startup failed',details:{mode:'desktop'}};
    fakeConfig(root,{endpoint,startupFailures:{desktop:startupFailure}});offline=true;
    const offlineCallIndex=bridgeCalls.length;
    const diagnosis=(await call('doctor')).result;
    assert.deepEqual(diagnosis.providers.desktop,{connected:false,error:'pipe offline',startupFailure});
    assert.deepEqual(diagnosis.providers.headless,{connected:false,error:'pipe offline'});
    assert.ok(bridgeCalls.slice(offlineCallIndex).filter(call=>call.method==='doctor').every(call=>call.options.start===false));
    // A connected Host must not bypass the current installation preflight.
    fakeConfig(root, { endpoint, runtimeError: 'shared adapter code changed' });
    const changedRuntime = await call('sessions', { mode: 'desktop' });
    assert.match(changedRuntime.error.message, /adapter code changed/);
    assert.equal(dispatches, 5);
  }finally{
    clearInterval(heartbeat);
    child.kill();server.closeAllConnections();server.close();await new Promise(resolve=>setTimeout(resolve,80));
    assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir())+path.sep)&&path.basename(root).startsWith('codex-dsh-supervisor-test-'));
    fs.rmSync(root,{recursive:true,force:true});
  }
});
