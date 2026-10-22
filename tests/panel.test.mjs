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

test('opening a process without a visible page receipt is reported as failure', async () => {
  const panel=statusPanel({url:()=> 'unused',state:'unused',findWindow:async()=>({exists:false}),launch:async()=>{},timeoutMs:20});
  await assert.rejects(panel.ensure(),/did not acknowledge rendering/);assert.equal(panel.status().visible,false);
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
  assert.equal(launches,0);assert.equal(panel.status().reuses,1);assert.equal(panel.status().connected,true);
});

test('unresponsive existing window fails closed instead of spawning duplicates on every retry', async () => {
  let launches=0;
  const panel=statusPanel({url:()=> 'unused',state:'unused',timeoutMs:15,
    findWindow:async()=>({exists:true,originMatches:true}),launch:async()=>{launches++}});
  await assert.rejects(panel.ensure(),/existing status window is not responding/);
  await assert.rejects(panel.ensure(),/no duplicate window/);
  assert.equal(launches,0);
});

test('supervisor restart adopts OS ownership; confirmed close permits one fresh window', async () => {
  let exists=true;let launches=0;let panel;
  panel=statusPanel({url:()=> 'unused',state:'unused',timeoutMs:30,findWindow:async()=>({exists,originMatches:true}),
    launch:async()=>{launches++;exists=true;setTimeout(()=>panel.heartbeat({clientId:'new',windowMode:true,visible:true,jobs:[]}),3)}});
  await assert.rejects(panel.ensure(),/existing status window/);assert.equal(launches,0);
  exists=false;
  await Promise.all([panel.ensure(),panel.ensure()]);assert.equal(launches,1);
});

test('unknown OS state or stale service address never opens an extra window', async () => {
  let launches=0;
  const stale=statusPanel({url:()=> 'unused',state:'unused',findWindow:async()=>({exists:true,originMatches:false}),launch:async()=>{launches++}});
  await assert.rejects(stale.ensure(),/old service address/);
  const unknown=statusPanel({url:()=> 'unused',state:'unused',findWindow:async()=>{throw new Error('process query failed')},launch:async()=>{launches++}});
  await assert.rejects(unknown.ensure(),/process query failed/);assert.equal(launches,0);
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
