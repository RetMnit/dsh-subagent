// Opt-in Windows development acceptance. Own isolated Edge profile, fake DSH
// IPC/model only. Never attaches to the user's browser or DSH sessions.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import {spawn, execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {fakeConfig} from './fixtures.mjs';
import {findStatusWindow, panelProfile} from '../server/panel.mjs';

if(process.platform!=='win32')throw new Error('Windows acceptance only');
const run=promisify(execFile), delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const root=fs.mkdtempSync(path.join(os.tmpdir(),'codex-dsh-background-test-'));
const state=path.join(root,'state');fs.mkdirSync(state);
const config=fakeConfig(state);const token=randomUUID();
const pipe='\\\\.\\pipe\\codex-dsh-background-test-'+randomUUID();
const jobs=[];const sockets=new Set();let starts=0;let supervisor;let browser;let cdp;
const conversationId='background-acceptance-'+randomUUID();
const server=net.createServer(socket=>{
  sockets.add(socket);socket.on('close',()=>sockets.delete(socket));socket.on('error',()=>{});
  socket.setEncoding('utf8');let buffer='';
  socket.on('data',chunk=>{buffer+=chunk;const cut=buffer.indexOf('\n');if(cut<0)return;
    const call=JSON.parse(buffer.slice(0,cut));void(async()=>{
      assert.equal(call.token,token);let result;
      if(call.method==='doctor')result={mode:'desktop',protocolVersion:1,instanceId:'fake-host',capabilities:['concurrent-sessions']};
      else if(call.method==='start'){
        result=jobs.find(job=>job.requestId===call.params.requestId);
        if(!result){starts++;result={jobId:randomUUID(),sessionId:call.params.sessionId||randomUUID(),requestId:call.params.requestId,
          mode:'desktop',status:'completed',createdAt:new Date().toISOString(),finishedAt:new Date().toISOString(),
          result:'fake-answer-'+starts,events:[],requested:{workspace:root}};jobs.push(result)}
      }else if(call.method==='status')result=jobs.find(job=>job.jobId===call.params.jobId);
      else if(call.method==='sessions')result=[];
      else {await delay(100);result={instanceId:'fake-host',cursor:jobs.length,jobs}}
      if(!socket.destroyed)socket.end(JSON.stringify({id:call.id,result})+'\n');
    })().catch(error=>{if(!socket.destroyed)socket.end(JSON.stringify({id:call.id,error:{message:error.message}})+'\n')});
  });
});
await new Promise(resolve=>server.listen(pipe,resolve));
fs.writeFileSync(path.join(state,'config.json'),JSON.stringify({...config,token,pipes:{desktop:pipe,headless:pipe+'-unused'},defaults:{workspace:root}}));
async function boot(){
  const before=fs.existsSync(path.join(state,'supervisor.json'))?JSON.parse(fs.readFileSync(path.join(state,'supervisor.json'))).instanceId:null;
  supervisor=spawn(process.execPath,[fileURLToPath(new URL('../server/supervisor.mjs',import.meta.url))],{
    env:{...process.env,CODEX_DSH_STATE_DIR:state},windowsHide:true,stdio:'ignore'});
  for(let i=0;i<200;i++){
    try{const info=JSON.parse(fs.readFileSync(path.join(state,'supervisor.json')));if(info.instanceId!==before)return info}catch{}
    await delay(25);
  }
  throw new Error('Isolated supervisor did not start');
}
let info;let dashboardUrl;let profile;
async function call(method,params={}){
  const response=await fetch(info.url+'/api',{method:'POST',headers:{authorization:'Bearer '+token,'content-type':'application/json'},
    body:JSON.stringify({method,params:{conversationId,...params}}),signal:AbortSignal.timeout(10000)});
  const reply=await response.json();if(reply.error)throw new Error(reply.error.message);return reply.result;
}
async function until(fn,label,timeout=10000){
  const end=Date.now()+timeout;while(Date.now()<end){const result=await fn();if(result)return result;await delay(100)}
  throw new Error('Timed out: '+label);
}
async function nativeWindow(command){
  // The profile is unique to this test; refuse to touch any other browser window.
  const script=`$ErrorActionPreference='Stop'
Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public static class BackgroundTestWindow { [DllImport("user32.dll")] public static extern bool ShowWindowAsync(IntPtr h,int n); [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h); }'
$items=@(Get-CimInstance Win32_Process -Filter "Name='msedge.exe'" | Where-Object { $_.CommandLine -like '*--app=*' -and $_.CommandLine.Contains($env:DSH_TEST_PROFILE) } | ForEach-Object { Get-Process -Id $_.ProcessId -ErrorAction SilentlyContinue } | Where-Object { $_.MainWindowHandle -ne 0 })
if($items.Count -ne 1){throw 'Expected exactly one owned test window'}
$item=$items[0]
if($env:DSH_TEST_ACTION -eq 'minimize'){[void][BackgroundTestWindow]::ShowWindowAsync($item.MainWindowHandle,6)}
if($env:DSH_TEST_ACTION -eq 'restore'){[void][BackgroundTestWindow]::ShowWindowAsync($item.MainWindowHandle,9)}
[pscustomobject]@{pid=$item.Id;minimized=[BackgroundTestWindow]::IsIconic($item.MainWindowHandle)} | ConvertTo-Json -Compress`;
  const {stdout}=await run('powershell.exe',['-NoProfile','-NonInteractive','-Command',script],{
    windowsHide:true,timeout:10000,env:{...process.env,DSH_TEST_PROFILE:profile,DSH_TEST_ACTION:command}});
  return JSON.parse(stdout.trim());
}
async function connectDebugger(){
  const port=await until(()=>{try{return Number(fs.readFileSync(path.join(profile,'DevToolsActivePort'),'utf8').split('\n')[0])}catch{}},'owned browser debug port');
  const targets=await (await fetch('http://127.0.0.1:'+port+'/json/list')).json();
  const target=targets.find(item=>item.type==='page'&&new URL(item.url).searchParams.get('conversationId')===conversationId);
  assert.ok(target,'Only the isolated test page may be inspected');
  const socket=new WebSocket(target.webSocketDebuggerUrl);await new Promise((resolve,reject)=>{socket.onopen=resolve;socket.onerror=reject});
  let next=0;const pending=new Map();
  socket.onmessage=event=>{const value=JSON.parse(event.data);if(value.id){const item=pending.get(value.id);if(item){pending.delete(value.id);clearTimeout(item.timer);value.error?item.reject(new Error(value.error.message)):item.resolve(value.result)}}};
  const request=(method,params={})=>new Promise((resolve,reject)=>{const id=++next;const timer=setTimeout(()=>{pending.delete(id);reject(new Error('CDP timeout: '+method))},5000);pending.set(id,{resolve,reject,timer});socket.send(JSON.stringify({id,method,params}))});
  return {request,close:()=>socket.close(),pause:()=>request('Page.setWebLifecycleState',{state:'frozen'}),resume:()=>request('Page.setWebLifecycleState',{state:'active'})};
}
const output={fakeModel:true,manualWindowRecovery:false};
try{
  info=await boot();const entry=await call('configure');await call('saveConfiguration',{configurationId:entry.configurationId,values:{mode:'desktop',workspace:root}});
  dashboardUrl=(await call('doctor')).dashboardUrl;profile=panelProfile(dashboardUrl,state);
  const app=new URL(dashboardUrl);app.searchParams.set('panelWindow','1');
  const executable=[process.env['ProgramFiles(x86)'],process.env.ProgramFiles,process.env.LOCALAPPDATA].filter(Boolean)
    .map(base=>path.join(base,'Microsoft/Edge/Application/msedge.exe')).find(file=>fs.existsSync(file));assert.ok(executable);
  // Debugging is enabled only for this disposable browser, never production.
  browser=spawn(executable,['--app='+app.href,'--user-data-dir='+profile,'--remote-debugging-port=0','--no-first-run','--no-default-browser-check','--disable-background-mode'],{windowsHide:false,stdio:'ignore'});
  await until(async()=> (await call('doctor')).panel.connected,'initial real page receipt');
  cdp=await connectDebugger();await nativeWindow('minimize');
  assert.equal((await nativeWindow('read')).minimized,true);
  // Freeze page lifecycle rather than pausing in the debugger (which can
  // activate its target). This suspends page timers/JS like a background tab.
  await cdp.pause();await nativeWindow('minimize');
  assert.equal((await nativeWindow('read')).minimized,true);
  await delay(7000);assert.equal((await call('doctor')).panel.connected,false,'render/heartbeat must actually be stale');
  console.log(JSON.stringify({phase:'minimized-and-js-paused',fakeModel:true}));
  const began=Date.now();const first=await call('start',{userAuthorized:true,requestId:'first',prompt:'fake first'});
  assert.equal(first.status,'completed');assert.equal(first.panel.jobsRendered,false);assert.equal(first.panel.renderPending,true);
  assert.equal(first.panel.display,'background');assert.equal(first.panel.launches,0);
  output.firstDispatchMs=Date.now()-began;
  const resumed=await call('resume',{userAuthorized:true,mode:'desktop',sessionId:first.sessionId,requestId:'second',prompt:'fake continuation'});
  assert.equal(resumed.sessionId,first.sessionId);assert.equal(resumed.status,'completed');
  const batch=await call('start_many',{userAuthorized:true,tasks:[{requestId:'third',prompt:'fake three'},{requestId:'fourth',prompt:'fake four'}]});
  assert.equal(batch.jobs.length,2);assert.deepEqual(batch.errors,[]);assert.equal(starts,4);
  assert.equal((await call('start',{userAuthorized:true,requestId:'first',prompt:'fake first'})).jobId,first.jobId);assert.equal(starts,4);
  assert.equal((await nativeWindow('read')).minimized,true,'dispatch never restores/steals focus');
  const owned=await findStatusWindow(dashboardUrl,state);assert.equal(owned.processCount,1);
  output.frozenDispatches=4;output.duplicateWindows=0;
  // Service restart loses every page receipt. OS ownership must still be enough.
  const previousPid=supervisor.pid;supervisor.kill();await until(()=>supervisor.exitCode!==null||supervisor.signalCode!==null,'isolated supervisor exit');info=await boot();assert.notEqual(info.pid,previousPid);
  const afterRestart=await call('resume',{userAuthorized:true,mode:'desktop',sessionId:first.sessionId,requestId:'restart',prompt:'fake after restart'});
  assert.equal(afterRestart.status,'completed');assert.equal(afterRestart.panel.jobsRendered,false);assert.equal(afterRestart.panel.launches,0);assert.equal(starts,5);
  assert.equal((await findStatusWindow(dashboardUrl,state)).processCount,1);assert.equal((await nativeWindow('read')).minimized,true);
  output.restartAdoption=true;output.fakeDispatches=starts;
  // All tasks completed before this test restores its window to verify catch-up.
  await cdp.resume();await nativeWindow('restore');
  await until(async()=>{
    const panel=(await call('doctor')).panel;
    return jobs.every(job=>panel.renderedJobs.some(item=>item.jobId===job.jobId&&item.status==='completed'&&item.hasResult));
  },'real page catches up to every completed job after foreground');
  const inspected=await cdp.request('Runtime.evaluate',{expression:"JSON.stringify(Array.from(document.querySelectorAll('#jobs article')).map(e=>({status:e.dataset.status,answer:e.querySelector('.result')?.textContent})))",returnByValue:true});
  const cards=JSON.parse(inspected.result.value);assert.equal(cards.length,3);assert.ok(cards.every(card=>card.status==='completed'&&card.answer.startsWith('fake-answer-')));
  output.foregroundCaughtUp=true;output.cards=cards.length;output.passed=true;
  console.log(JSON.stringify(output));
  if(process.argv[2])fs.writeFileSync(process.argv[2],JSON.stringify(output,null,2)+'\n');
}finally{
  if(cdp){await cdp.request('Browser.close').catch(()=>{});cdp.close()}
  if(browser&&browser.exitCode===null){await delay(500);if(browser.exitCode===null)browser.kill()}
  if(supervisor&&supervisor.exitCode===null)supervisor.kill();
  for(const socket of sockets)socket.destroy();server.close();await delay(500);
  assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir())+path.sep)&&path.basename(root).startsWith('codex-dsh-background-test-'));
  try{fs.rmSync(root,{recursive:true,force:true})}catch{console.error('Temporary test profile still in use; preserved at '+root)}
}
