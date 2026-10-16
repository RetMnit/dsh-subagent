import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {groupSubagents} from '../server/subagents.mjs';

test('dashboard renders all independent tasks and reports actual DOM results without dispatching', async () => {
  const elements=new Map();const requests=[];
  const element=tag=>({tag,textContent:'',dataset:{},children:[],append(...items){this.children.push(...items)},replaceChildren(){this.children=[]}});
  const document={hidden:false,createElement:element,getElementById:id=>{if(!elements.has(id))elements.set(id,element('div'));return elements.get(id)},addEventListener(){}};
  const handlers={};
  const context={window:{addEventListener(name,fn){handlers[name]=fn}},document,location:{hash:'#private',pathname:'/',search:'?conversationId=chat-A'},sessionStorage:{getItem(){return ''},setItem(){}},history:{replaceState(){}},crypto:{randomUUID:()=> 'fake-window'},URLSearchParams,TextDecoder,encodeURIComponent,setInterval(){},setTimeout,
    fetch:async(url,options)=>{if(url.startsWith('/events'))return new Promise(()=>{});requests.push(JSON.parse(options.body));return{json:async()=>({result:{accepted:true}})}}};
  document.querySelector=()=>({textContent:''});
  vm.runInNewContext(fs.readFileSync(new URL('../ui/dashboard.js',import.meta.url),'utf8'),context);
  const jobs=[1,2].map(number=>({jobId:'job-'+number,sessionId:'session-'+number,title:'任务 '+number,status:'completed',mode:'desktop',createdAt:new Date(number*1000).toISOString(),finishedAt:new Date(number*1000).toISOString(),promptSummary:'只回复 '+number,result:String(number)}));
  context.testData={conversationId:'chat-A',providers:{desktop:{connected:true}},jobs,subagents:groupSubagents(jobs)};vm.runInNewContext('draw(testData)',context);
  const cards=elements.get('jobs').children;assert.equal(cards.length,2);assert.deepEqual(cards.map(card=>card.dataset.jobId),['job-2','job-1']);
  assert.deepEqual(cards.map(card=>card.children.find(child=>child.className==='result').textContent),['2','1']);
  const receipt=requests.find(request=>request.method==='panelHeartbeat');assert.ok(receipt.params.jobs.every(job=>job.hasResult));assert.equal(receipt.params.jobs.length,2);
  assert.ok(!requests.some(request=>/start|saveConfiguration/.test(request.method)));
  const all=[...jobs,...jobs.map((job,index)=>({...job,jobId:'job-'+(index+3),title:'续接 '+(index+3),createdAt:new Date((index+3)*1000).toISOString(),result:String(index+3)}))];
  context.testData={conversationId:'chat-A',providers:{desktop:{connected:true}},jobs:all,subagents:groupSubagents(all)};vm.runInNewContext('draw(testData)',context);
  const updated=elements.get('jobs').children;assert.equal(updated.length,2);
  assert.deepEqual(updated.map(card=>card.children.find(child=>child.className==='result').textContent),['4','3']);
  assert.deepEqual(updated.map(card=>card.children[0].children[0].textContent),['任务 2','任务 1']);
  assert.ok(updated.every(card=>card.children.find(child=>child.className==='turn-history').children.length===2));
  assert.equal(requests.filter(request=>request.method==='panelHeartbeat').at(-1).params.jobs.length,4);
  assert.match(elements.get('providers').textContent,/2 项已完成/);
  updated[0].children.find(child=>child.className==='turn-history').open=true;
  vm.runInNewContext('draw(testData)',context);assert.ok(elements.get('jobs').children[0].children.find(child=>child.className==='turn-history').open);
  for(const status of ['starting','running','waiting-approval','completed']){
    const changing=all.map(job=>job.jobId==='job-3'?{...job,status,...(status==='completed'?{result:'3'}:{result:undefined,finishedAt:undefined})}:job);
    context.testData={conversationId:'chat-A',providers:{desktop:{connected:true}},jobs:changing,subagents:groupSubagents(changing)};vm.runInNewContext('draw(testData)',context);
    const resumed=elements.get('jobs').children.find(card=>card.dataset.jobId==='job-3');assert.equal(resumed.dataset.status,status);
    assert.equal(resumed.children.find(child=>child.className==='result')?.textContent,status==='completed'?'3':undefined);
    assert.equal(elements.get('jobs').children.length,2);
    if(status!=='completed')assert.match(elements.get('providers').textContent,/1 项进行中 · 1 项已完成/);
  }
  context.testData={conversationId:'chat-B',providers:{},jobs:[]};vm.runInNewContext('draw(testData)',context);assert.equal(elements.get('jobs').children.length,2);
  handlers.pagehide();assert.ok(requests.some(request=>request.method==='panelHeartbeat'&&request.params.closed===true&&request.params.conversationId==='chat-A'));
});

test('parameter form reads and updates only its Codex conversation configuration and has no session binding',async()=>{
  const fields=Object.fromEntries(['mode','workspace','preset','permission','provider','model','reasoningEffort'].map(name=>[name,{value:''}]));
  const elements=new Map();const requests=[];
  const entry={conversationId:'chat-A',configurationId:'config-A',status:'ready',values:{mode:'desktop',workspace:'fake-workspace',preset:'unity',permission:'danger-full-access',model:{provider:'fake',model:'first'}}};
  const button={disabled:false};const timers=new Map();let nextTimer=0;let finishSave;let failure=false;
  const form={querySelector:()=>button,elements:{namedItem:name=>{assert.ok(fields[name],'No removed session fields');return fields[name]}}};
  elements.set('settings',form);
  const context={document:{createElement(){},getElementById:id=>{if(!elements.has(id))elements.set(id,{});return elements.get(id)},querySelector:()=>({})},location:{hash:'#private',pathname:'/',search:'?conversationId=chat-A&configure=config-A'},sessionStorage:{getItem(){},setItem(){}},history:{replaceState(){}},crypto:{randomUUID:()=> 'fake-form'},URLSearchParams,
    setTimeout(fn,ms){timers.set(++nextTimer,{fn,ms});return nextTimer},clearTimeout(id){timers.delete(id)},
    fetch:async(url,options)=>{const request=JSON.parse(options.body);requests.push(request);if(request.method==='saveConfiguration')await new Promise(resolve=>{finishSave=resolve});return{json:async()=>failure?{error:{message:'fake save failure'}}:{result:request.method==='configuration'?entry:{...entry,revision:2}}}}};
  vm.runInNewContext(fs.readFileSync(new URL('../ui/dashboard.js',import.meta.url),'utf8'),context);
  for(let i=0;i<20&&!form.onsubmit;i++)await Promise.resolve();
  assert.equal(fields.model.value,'first');fields.model.value='edited';form.oninput();
  const saving=form.onsubmit({preventDefault(){}});assert.equal(elements.get('saved').textContent,'保存中…');assert.equal(button.disabled,true);
  await form.onsubmit({preventDefault(){}});assert.equal(requests.length,2);
  finishSave();await saving;assert.equal(button.disabled,false);assert.equal(elements.get('saved').textContent,'配置已保存');
  assert.equal(requests.length,2);assert.deepEqual(requests.map(item=>item.method),['configuration','saveConfiguration']);
  const saved=requests.at(-1).params;assert.equal(saved.configurationId,'config-A');assert.equal(saved.conversationId,'chat-A');assert.equal(saved.values.model.model,'edited');assert.equal(saved.values.sessionId,undefined);
  assert.ok(!requests.some(request=>/start|resume/.test(request.method)));
  assert.equal([...timers.values()][0].ms,3000);form.onchange();assert.equal(elements.get('saved').textContent,'');assert.equal(timers.size,0);
  const again=form.onsubmit({preventDefault(){}});assert.equal(elements.get('saved').textContent,'保存中…');finishSave();await again;
  assert.equal(elements.get('saved').textContent,'配置已保存');assert.equal(timers.size,1);
  const timer=[...timers.values()][0];timer.fn();timers.clear();assert.equal(elements.get('saved').textContent,'');
  failure=true;const failed=form.onsubmit({preventDefault(){}});finishSave();await failed;
  assert.equal(elements.get('saved').textContent,'fake save failure');assert.equal(timers.size,0);assert.equal(button.disabled,false);
});
