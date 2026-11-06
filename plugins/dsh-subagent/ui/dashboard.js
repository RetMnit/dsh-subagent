const storageKey = 'codex-dsh-panel-token';
const token = location.hash.slice(1) || sessionStorage.getItem(storageKey) || '';
if (token) sessionStorage.setItem(storageKey, token);
history.replaceState(null, '', location.pathname + location.search);
const clientId = crypto.randomUUID();
const conversationId = new URLSearchParams(location.search).get('conversationId');
const windowMode = new URLSearchParams(location.search).get('panelWindow') === '1';
const labels = {starting:'准备中',running:'运行中','waiting-user':'等待回答','waiting-approval':'等待权限',completed:'已完成',failed:'失败',cancelled:'已取消',interrupted:'已中断'};
const el = (tag, text, className) => {const item=document.createElement(tag);if(text!==undefined)item.textContent=text;if(className)item.className=className;return item};
const byId = id => document.getElementById(id);
let renderedJobs = [];
let streamController;
let drawnInstance;let drawnCursor=-1;
async function call(method, params, keepalive = false) {
  const response = await fetch('/api', {method:'POST',headers:{authorization:'Bearer '+token,'content-type':'application/json'},body:JSON.stringify({method,params:{...params,...(conversationId?{conversationId}:{})}}),keepalive});
  const reply=await response.json();if(reply.error)throw new Error(reply.error.message);return reply.result;
}
async function heartbeat() {
  try {await call('panelHeartbeat',{clientId,visible:!document.hidden,windowMode,jobs:renderedJobs})} catch {}
}
function draw(data) {
  if (data.conversationId !== conversationId) return;
  if(data.instanceId&&Number.isInteger(data.cursor)) {
    if(data.instanceId===drawnInstance&&data.cursor<drawnCursor)return;
    drawnInstance=data.instanceId;drawnCursor=data.cursor;
  }
  byId('connection').textContent='实时连接';
  const subagents=data.subagents||[];
  const active=subagents.filter(job=>['starting','running','waiting-user','waiting-approval'].includes(job.status)).length;
  const completed=subagents.filter(job=>job.status==='completed').length;
  byId('providers').textContent=active+' 项进行中 · '+completed+' 项已完成　'+Object.entries(data.providers).map(([key,val])=>(key==='desktop'?'DSH Desktop':'后台 CLI')+' · '+(val.connected?'在线':'离线')).join(' / ');
  const main=byId('jobs');
  const expanded=new Map(Array.from(main.children).map(card=>[card.dataset.subagentId,new Set(Array.from(card.children||[]).filter(item=>item.open).map(item=>item.className))]));
  main.replaceChildren();
  if(!subagents.length)main.append(el('div','等待子智能体启动。每个子智能体只显示一张卡片。','empty'));
  for(const job of subagents) {
    const card=el('article');card.dataset.subagentId=job.subagentId;card.dataset.jobId=job.jobId;card.dataset.status=job.status;
    const top=el('div',undefined,'top');top.append(el('h2',job.title||'DSH 任务'),el('span',labels[job.status]||job.status,'status '+job.status));
    card.append(top,el('p',job.promptSummary));
    const info=el('div',undefined,'details');const effective=job.effective||job.requested||{};
    const recent=job.recentEvents||[];const last=recent.at(-1);
    const phase=job.phase==='waiting-subagents'?'等待子任务':last?.type==='tool/call'?'执行工具 '+last.tool:job.status==='running'?'等待模型 / 生成回复':labels[job.status];
    for(const [key,value] of [['运行方式',job.mode==='desktop'?'Desktop':'后台 CLI'],['进度',phase],['工作区',effective.workspace],['预设',effective.preset],['模型',effective.model?effective.model.provider+'/'+effective.model.model:'沿用 DSH'],['权限',effective.permission],['耗时',Math.round(((job.finishedAt?Date.parse(job.finishedAt):Date.now())-Date.parse(job.createdAt))/1000)+' 秒']])info.append(el('b',key),el('span',value||'—'));
    card.append(info);
    if(job.error)card.append(el('pre',job.error.message||JSON.stringify(job.error),'error'));
    if(job.result!==undefined)card.append(el('pre',job.result,'result'));
    if(job.turnCount>1){
      const history=el('details',undefined,'turn-history');history.open=expanded.get(job.subagentId)?.has('turn-history')||false;history.append(el('summary','交互记录 · '+job.turnCount+' 轮'));
      for(const turn of job.turns.filter(turn=>turn.jobId!==job.jobId)){
        const item=el('section');item.dataset.jobId=turn.jobId;
        item.append(el('p',turn.promptSummary),el('span',labels[turn.status]||turn.status,'muted'));
        if(turn.error)item.append(el('pre',turn.error.message||JSON.stringify(turn.error),'error'));
        if(turn.result!==undefined)item.append(el('pre',turn.result,'result'));
        history.append(item);
      }
      card.append(history);
    }
    if(recent.length){
      const log=el('details',undefined,'run-log');log.open=expanded.get(job.subagentId)?.has('run-log')||false;log.append(el('summary','运行日志'));
      const events=el('div',undefined,'events');
      const eventLabels={'turn/start':'开始本轮','assistant/message':'收到回复','turn/end':'本轮结束','tool/call':'调用工具','tool/result':'工具返回'};
      for(const event of recent)events.append(el('div',(eventLabels[event.type]||event.type)+(event.tool?' · '+event.tool:'')));
      log.append(events);card.append(log);
    }
    if(job.backgroundJobs?.length)card.append(el('p','仍有后台工作：'+job.backgroundJobs.length,'error'));
    const actions=el('div',undefined,'card-actions');
    if(job.mode==='desktop'&&job.sessionId){const open=el('button','在 DSH 中查看');open.onclick=()=>call('open',{jobId:job.jobId}).catch(error=>alert(error.message));actions.append(open)}
    if(['starting','running','waiting-user','waiting-approval'].includes(job.status)){const cancel=el('button','取消');cancel.onclick=()=>call('cancel',{jobId:job.jobId}).catch(error=>alert(error.message));actions.append(cancel)}
    if(actions.children.length)card.append(actions);
    main.append(card);
  }
  renderedJobs=data.jobs.map(job=>({jobId:job.jobId,status:job.status,hasResult:job.result!==undefined}));
  void heartbeat();
}
async function watch() {
  for(;;){try{
    streamController=new AbortController();
    const response=await fetch('/events?conversationId='+encodeURIComponent(conversationId),{headers:{authorization:'Bearer '+token},signal:streamController.signal});if(!response.ok)throw new Error('HTTP '+response.status);
    const reader=response.body.getReader();const decoder=new TextDecoder();let buffer='';
    for(;;){const {value,done}=await reader.read();if(done)break;buffer+=decoder.decode(value,{stream:true});let cut;
      while((cut=buffer.indexOf('\n\n'))>=0){const frame=buffer.slice(0,cut);buffer=buffer.slice(cut+2);if(frame.startsWith('data: '))draw(JSON.parse(frame.slice(6)));else if(frame.startsWith(':'))void heartbeat()}}
  }catch{byId('connection').textContent='连接中断 · 重试'}await new Promise(resolve=>setTimeout(resolve,1500))}
}
async function refreshPanel() {
  // Background timers and streaming readers may be suspended by the browser.
  // A foreground event always fetches a fresh authoritative snapshot and resets
  // the stream, without starting/resuming tasks or changing configuration.
  streamController?.abort();
  try {draw(await call('list',{}))} catch {byId('connection').textContent='连接中断 · 重试'}
}
const configurationId=new URLSearchParams(location.search).get('configure');
async function configure() {
  byId('configuration').hidden=false;byId('providers').hidden=true;byId('jobs').hidden=true;document.querySelector('.caption').hidden=true;
  document.querySelector('h1').textContent='DSH 子智能体';document.querySelector('header p').textContent='当前 Codex 会话的唯一配置';byId('connection').textContent='参数配置';
  const form=byId('settings');const field=name=>form.elements.namedItem(name);
  const saveButton=form.querySelector('button[type="submit"]');let noticeTimer;
  const notice=(message,temporary=false)=>{clearTimeout(noticeTimer);byId('saved').textContent=message;if(temporary)noticeTimer=setTimeout(()=>{byId('saved').textContent=''},3000)};
  const edited=()=>{if(!saveButton.disabled)notice('')};form.oninput=edited;form.onchange=edited;
  try {
    const entry=await call('configuration',{});if(entry.configurationId!==configurationId)throw new Error('配置不属于当前 Codex 会话，请重新打开参数表。');const values=entry.values;
    for(const key of ['mode','workspace','preset','permission'])field(key).value=values[key]||'';
    for(const key of ['provider','model','reasoningEffort'])field(key).value=values.model?.[key]||'';
    form.onsubmit=async event=>{
      event.preventDefault();if(saveButton.disabled)return;const values={mode:field('mode').value};
      for(const key of ['workspace','preset','permission'])if(field(key).value.trim())values[key]=field(key).value.trim();
      const provider=field('provider').value.trim(),model=field('model').value.trim(),reasoningEffort=field('reasoningEffort').value.trim();
      if(provider||model||reasoningEffort){if(!provider||!model){notice('请同时填写模型提供方和模型。');return}values.model={provider,model,...(reasoningEffort?{reasoningEffort}:{})}}
      saveButton.disabled=true;notice('保存中…');
      try{await call('saveConfiguration',{configurationId,values});notice('配置已保存',true)}catch(error){notice(error.message)}finally{saveButton.disabled=false}
    };
  }catch(error){notice(error.message)}
}
if(token) {
  if(configurationId)configure();
  else if(conversationId){document.title='DSH Subagent · 当前会话';document.querySelector('header p').textContent='仅显示当前 Codex 会话的任务';void watch();setInterval(()=>void heartbeat(),1500);document.addEventListener('visibilitychange',()=>{void heartbeat();if(!document.hidden)void refreshPanel()});window.addEventListener('focus',()=>void refreshPanel());window.addEventListener('pageshow',()=>void refreshPanel());window.addEventListener('pagehide',()=>void call('panelHeartbeat',{clientId,closed:true,jobs:[]},true).catch(()=>{}))}
  else {byId('connection').textContent='未指定 Codex 会话';byId('jobs').append(el('p','请让 Codex 重新打开当前会话的 DSH 状态窗口。'))}
}else {byId('connection').textContent='需要访问凭据';byId('jobs').append(el('p','请从插件打开任务看板。'))}
