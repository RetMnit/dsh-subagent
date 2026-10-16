import test from 'node:test';
import assert from 'node:assert/strict';
import {statusPanel} from '../server/panel.mjs';

test('automatic panel opens once for concurrent starts and acknowledges every rendered task', async () => {
  let launches=0;let panel;
  panel=statusPanel({url:()=> 'http://127.0.0.1/#private',state:'unused',launch:async()=>{launches++;setTimeout(()=>panel.heartbeat({clientId:'window',visible:true,jobs:[]}),10)},timeoutMs:300});
  await Promise.all([panel.ensure(),panel.ensure()]);assert.equal(launches,1);assert.equal(panel.status().visible,true);
  const rendered=panel.rendered(['one','two'],200);
  panel.heartbeat({clientId:'window',visible:true,jobs:[{jobId:'one',status:'running'},{jobId:'two',status:'completed',hasResult:true}]});
  assert.equal((await rendered).jobsRendered,true);assert.equal(panel.status().renderedJobs.length,2);
  await panel.ensure();assert.equal(launches,1);
  panel.heartbeat({clientId:'window',visible:false,windowMode:true,jobs:[]});await panel.ensure();assert.equal(launches,1);
  panel.heartbeat({clientId:'window',closed:true,jobs:[]});assert.equal(panel.status().connected,false);
  await panel.ensure();assert.equal(launches,2);assert.equal(panel.status().visible,true);
});

test('opening a process without a visible page receipt is reported as failure', async () => {
  const panel=statusPanel({url:()=> 'unused',state:'unused',launch:async()=>{},timeoutMs:20});
  await assert.rejects(panel.ensure(),/did not acknowledge rendering/);assert.equal(panel.status().visible,false);
});
