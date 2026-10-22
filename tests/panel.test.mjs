import test from 'node:test';
import assert from 'node:assert/strict';
import {statusPanel, matchStatusWindows, panelProfile} from '../server/panel.mjs';

test('automatic panel opens once for concurrent starts and acknowledges every rendered task', async () => {
  let launches=0;let panel;
  panel=statusPanel({url:()=> 'http://127.0.0.1/#private',state:'unused',findWindow:async()=>({exists:false}),launch:async()=>{launches++;setTimeout(()=>panel.heartbeat({clientId:'window',visible:true,jobs:[]}),10)},timeoutMs:300});
  await Promise.all([panel.ensure(),panel.ensure()]);assert.equal(launches,1);assert.equal(panel.status().visible,true);
  const rendered=panel.rendered(['one','two'],200);
  panel.heartbeat({clientId:'window',visible:true,jobs:[{jobId:'one',status:'running'},{jobId:'two',status:'completed',hasResult:true}]});
  assert.equal((await rendered).jobsRendered,true);assert.equal(panel.status().renderedJobs.length,2);
  await panel.ensure();assert.equal(launches,1);
  panel.heartbeat({clientId:'window',visible:false,windowMode:true,jobs:[]});await panel.ensure();assert.equal(launches,1);
  panel.heartbeat({clientId:'window',closed:true,jobs:[]});assert.equal(panel.status().connected,false);
  await panel.ensure();assert.equal(launches,2);assert.equal(panel.status().visible,true);
});

test('launch without a page receipt reports pending display rather than blocking execution', async () => {
  const panel=statusPanel({url:()=> 'unused',state:'unused',findWindow:async()=>({exists:false}),launch:async()=>{},timeoutMs:20});
  const status=await panel.ensure();assert.equal(status.visible,false);assert.equal(status.display,'pending');
  assert.equal(status.connected,false);assert.equal(status.windowPresent,null);
});

test('expired heartbeat with an existing OS window reconnects without a second launch', async () => {
  let time=0;let launches=0;let panel;
  panel=statusPanel({url:()=> 'unused',state:'unused',clock:()=>time,timeoutMs:100,
    launch:async()=>{launches++},findWindow:async()=>{
      setTimeout(()=>panel.heartbeat({clientId:'existing',windowMode:true,visible:false,jobs:[]}),5);
      return {exists:true,originMatches:true};
    }});
  panel.heartbeat({clientId:'existing',windowMode:true,visible:true,jobs:[]});
  time=10000;
  assert.equal(panel.status().connected,false);
  await Promise.all([panel.ensure(),panel.ensure()]);
  assert.equal(launches,0);assert.equal(panel.status().reuses,1);assert.equal(panel.status().connected,false);
  await new Promise(resolve=>setTimeout(resolve,10));assert.equal(panel.status().connected,true);
});

test('frozen owned window immediately allows new work without forged rendering or duplicate launches', async () => {
  let launches=0;let refreshes=0;let time=0;
  const panel=statusPanel({url:()=> 'unused',state:'unused',timeoutMs:15000,clock:()=>time,
    findWindow:async()=>({exists:true,originMatches:true}),launch:async()=>{launches++},refresh:()=>{refreshes++}});
  panel.heartbeat({clientId:'frozen',windowMode:true,visible:false,jobs:[{jobId:'old',status:'completed'}]});
  time=600000; // No timer/heartbeat/render receipt for ten minutes.
  const watchdog=setTimeout(()=>assert.fail('must not wait for a frozen browser'),500);
  try {
    const status=await panel.ensure();
    assert.equal(status.display,'background');assert.equal(status.windowPresent,true);
    assert.equal(status.connected,false);assert.equal(status.visible,false);assert.equal(status.lastReceiptAt,0);
    assert.equal(status.lastError,undefined);
    const rendered=await panel.rendered(['new-job']);
    assert.equal(rendered.jobsRendered,false);assert.equal(rendered.renderPending,true);assert.deepEqual(rendered.renderedJobs,[]);
    await panel.ensure();assert.equal(launches,0);assert.equal(refreshes,3);
    panel.heartbeat({clientId:'frozen',windowMode:true,visible:true,jobs:[{jobId:'new-job',status:'completed',hasResult:true}]});
    assert.equal((await panel.rendered(['new-job'])).jobsRendered,true);
    assert.equal(panel.status().display,'live');
  } finally {clearTimeout(watchdog)}
});

test('supervisor restart adopts OS ownership; confirmed close permits one fresh window', async () => {
  let exists=true;let launches=0;let panel;
  panel=statusPanel({url:()=> 'unused',state:'unused',timeoutMs:30,findWindow:async()=>({exists,originMatches:true}),
    launch:async()=>{launches++;exists=true;setTimeout(()=>panel.heartbeat({clientId:'new',windowMode:true,visible:true,jobs:[]}),3)}});
  assert.equal((await panel.ensure()).display,'background');assert.equal(launches,0);
  exists=false;
  await Promise.all([panel.ensure(),panel.ensure()]);assert.equal(launches,1);
});

test('display failures are explicit but do not throw or open duplicates', async () => {
  let launches=0;
  const stale=statusPanel({url:()=> 'unused',state:'unused',findWindow:async()=>({exists:true,originMatches:false}),launch:async()=>{launches++}});
  const staleStatus=await stale.ensure();assert.match(staleStatus.lastError,/old service address/);assert.equal(staleStatus.display,'unavailable');
  const unknown=statusPanel({url:()=> 'unused',state:'unused',findWindow:async()=>{throw new Error('process query failed')},launch:async()=>{launches++}});
  assert.match((await unknown.ensure()).lastError,/process query failed/);assert.equal(launches,0);
  const failedLaunch=statusPanel({url:()=> 'unused',state:'unused',findWindow:async()=>({exists:false}),launch:async()=>{throw new Error('Edge unavailable')}});
  assert.match((await failedLaunch.ensure()).lastError,/Edge unavailable/);
});

test('OS ownership is scoped by profile and conversation, with quoted paths and legacy adoption', () => {
  const state='C:/State With Spaces';const url='http://127.0.0.1:1234/?conversationId=chat-A#secret';
  const command=(profile,id='chat-A',port=1234)=>`edge.exe "--app=http://127.0.0.1:${port}/?conversationId=${id}&panelWindow=1#secret" "--user-data-dir=${profile}"`;
  const owned={pid:42,hasWindow:true,commandLine:command(panelProfile(url,state))};
  assert.equal(matchStatusWindows([owned],url,state).exists,true);
  assert.equal(matchStatusWindows([{...owned,commandLine:command(panelProfile(url,state),'chat-B')}],url,state).exists,false);
  assert.equal(matchStatusWindows([{...owned,commandLine:command('C:/other-profile')}],url,state).exists,false);
  assert.equal(matchStatusWindows([{...owned,commandLine:command(state+'/status-window-profile')}],url,state).exists,true);
  assert.equal(matchStatusWindows([{...owned,commandLine:command(panelProfile(url,state),'chat-A',5555)}],url,state).originMatches,false);
  assert.notEqual(panelProfile(url,state),panelProfile(url.replace('chat-A','chat-B'),state));
});
