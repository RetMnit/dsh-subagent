import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {runtimeRecords,conversationId} from '../server/records.mjs';
import {requestStore} from '../server/requests.mjs';
import {groupSubagents} from '../server/subagents.mjs';

const temporary=()=>fs.mkdtempSync(path.join(os.tmpdir(),'codex-dsh-records-test-'));
const remove=state=>{assert.ok(path.resolve(state).startsWith(path.resolve(os.tmpdir())+path.sep)&&path.basename(state).startsWith('codex-dsh-records-test-'));fs.rmSync(state,{recursive:true,force:true})};
const now=Date.now();
const makeJob=(conversationId,status='completed',age=0)=>({jobId:'job-'+randomUUID(),requestId:randomUUID(),conversationId,mode:'desktop',status,createdAt:new Date(now-age).toISOString(),finishedAt:new Date(now-age).toISOString()});

test('resume preparation updates the same subagent immediately, restores its target after restart, and rejects stale progress',()=>{
  const state=temporary();try{
    const configs={resolve:params=>params};let requests=requestStore(state,configs);
    const selected=requests.resolve({conversationId:'chat-A',requestId:'resume',prompt:'continue',userAuthorized:true,mode:'desktop',sessionId:'original'},'resume');
    requests=requestStore(state,configs);assert.equal(requests.targetOf(selected.requestId).sessionId,'original');
    const old={...makeJob('chat-A','completed',1000),sessionId:'original',result:'old'};
    const jobs=new Map([[old.jobId,old]]);const records=runtimeRecords(state,jobs,requests);
    const preparing={jobId:'job-new',requestId:selected.requestId,mode:'desktop',status:'starting',createdAt:new Date(now).toISOString(),updatedAt:new Date(now).toISOString()};
    records.remember(preparing);let agents=groupSubagents([...jobs.values()]);assert.equal(agents.length,1);assert.equal(agents[0].status,'starting');assert.equal(agents[0].result,undefined);
    const running={...preparing,status:'running',updatedAt:new Date(now+1).toISOString()};records.remember(running);records.remember(preparing);
    records.remember({...preparing,updatedAt:running.updatedAt});
    assert.equal(jobs.get('job-new').status,'running');
    records.remember({...running,status:'completed',result:'new',updatedAt:new Date(now+2).toISOString()});records.remember({...running,updatedAt:new Date(now+3).toISOString()});
    agents=groupSubagents([...jobs.values()]);assert.equal(agents.length,1);assert.equal(agents[0].status,'completed');assert.equal(agents[0].result,'new');
    requests.forget(selected.requestId);assert.equal(requests.targetOf(selected.requestId),undefined);
  }finally{remove(state)}
});

test('retention keeps 100 completed records per conversation, removes records older than 30 days, and never touches sessions/config/projects or active jobs',()=>{
  const state=temporary();
  try{
    const jobs=new Map();const forgotten=[];const dir=path.join(state,'companion/desktop');fs.mkdirSync(dir,{recursive:true});
    const protectedFiles=['config.json','configurations.json','sessions/original.jsonl','storages/model.json','project/game.cs'];
    for(const name of protectedFiles){const file=path.join(state,name);fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,'keep exactly')}
    for(let i=0;i<105;i++){const job=makeJob('chat-A','completed',i*1000);jobs.set(job.jobId,job);fs.writeFileSync(path.join(dir,job.jobId+'.json'),JSON.stringify(job))}
    for(const status of ['running','starting','waiting-user','waiting-approval']){const job=makeJob('chat-A',status,40*86400000);jobs.set(job.jobId,job);fs.writeFileSync(path.join(dir,job.jobId+'.json'),JSON.stringify(job))}
    const old=makeJob('chat-B','completed',31*86400000),other=makeJob('chat-B');jobs.set(old.jobId,old);jobs.set(other.jobId,other);
    fs.writeFileSync(path.join(dir,old.jobId+'.json'),JSON.stringify(old));
    const records=runtimeRecords(state,jobs,{forget:id=>forgotten.push(id)},()=>now);
    const report=records.cleanup();assert.equal(report.removed,6);assert.equal(forgotten.length,6);
    assert.equal([...jobs.values()].filter(job=>job.conversationId==='chat-A'&&job.status==='completed').length,100);
    assert.equal([...jobs.values()].filter(job=>['running','starting','waiting-user','waiting-approval'].includes(job.status)).length,4);
    assert.ok(jobs.has(other.jobId));assert.equal(records.accepts(old),false);assert.ok(!fs.existsSync(path.join(dir,old.jobId+'.json')));
    for(const name of protectedFiles)assert.equal(fs.readFileSync(path.join(state,name),'utf8'),'keep exactly');
    const restarted=runtimeRecords(state,jobs,{forget(){}},()=>now);assert.equal(restarted.accepts(old),false);
    assert.equal(restarted.cleanup().removed,0);
  }finally{remove(state)}
});

test('record ownership survives restart and may be recovered from an accepted request without guessing legacy ownership',()=>{
  const state=temporary();try{
    const job=makeJob(undefined);const jobs=new Map([[job.jobId,job]]);
    let records=runtimeRecords(state,jobs,{forget(){}});assert.equal(records.owns(job,'chat-A'),false);
    records.assign(job,'chat-A');records=runtimeRecords(state,jobs,{forget(){}});
    assert.equal(records.decorate(job).conversationId,'chat-A');assert.equal(records.owns(job,'chat-B'),false);
    assert.throws(()=>records.assign(job,'chat-B'),/another Codex conversation/);
    const orphan=makeJob(undefined);const recovered=runtimeRecords(state,jobs,{forget(){},conversationOf:id=>id===orphan.requestId?'chat-B':undefined});assert.equal(recovered.decorate(orphan).conversationId,'chat-B');
    assert.throws(()=>conversationId({}),/current Codex thread/);
  }finally{remove(state)}
});

test('cleanup leaves a retry tombstone rather than executing a cleaned request again, and request IDs are isolated by conversation',()=>{
  const state=temporary();try{
    const config={resolve:params=>({requestId:params.requestId,prompt:params.prompt,mode:'desktop'})};let requests=requestStore(state,config);
    const params={conversationId:'chat-A',userAuthorized:true,requestId:'same',prompt:'hello'};
    const a=requests.resolve(params);const b=requests.resolve({...params,conversationId:'chat-B'});assert.notEqual(a.requestId,b.requestId);
    requests.forget(a.requestId);requests=requestStore(state,config);
    assert.throws(()=>requests.resolve(params),/already cleaned/);assert.equal(requests.resolve({...params,conversationId:'chat-B'}).prompt,'hello');
    const stored=JSON.parse(fs.readFileSync(path.join(state,'dispatch-requests.json'),'utf8'));const marker=Object.values(stored).find(entry=>entry.expired);assert.deepEqual(Object.keys(marker).sort(),['expired','signature']);
  }finally{remove(state)}
});

test('a stale mirror cannot clean an active provider record or a mismatched file',()=>{
  const state=temporary();try{
    const job=makeJob('chat-A','completed',40*86400000);const jobs=new Map([[job.jobId,job]]);const dir=path.join(state,'companion/desktop');fs.mkdirSync(dir,{recursive:true});const file=path.join(dir,job.jobId+'.json');
    fs.writeFileSync(file,JSON.stringify({...job,status:'running'}));const records=runtimeRecords(state,jobs,{forget(){throw new Error('must not forget')}} ,()=>now);
    assert.equal(records.cleanup().removed,0);assert.ok(jobs.has(job.jobId));
    fs.writeFileSync(file,JSON.stringify({...job,jobId:'another'}));assert.equal(records.cleanup().removed,0);assert.ok(fs.existsSync(file));
  }finally{remove(state)}
});
