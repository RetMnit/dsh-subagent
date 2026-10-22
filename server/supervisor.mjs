import http from 'node:http';
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { ROOT, STATE, config, readJson, atomic, pipeCall, equal, terminal, discoverRuntime } from './common.mjs';
import { configurationStore } from './configurations.mjs';
import { requestStore } from './requests.mjs';
import { statusPanel } from './panel.mjs';
import { runtimeRecords, conversationId } from './records.mjs';
import { groupSubagents } from './subagents.mjs';

const cfg = config();
const instanceId = randomUUID();
const lock = net.createServer();
try { await new Promise((resolve, reject) => { lock.once('error', reject); lock.listen(cfg.pipes.headless + '-supervisor', resolve); }); }
catch { process.exit(0); }
const configurations = configurationStore(STATE, cfg.defaults);
const requests = requestStore(STATE, configurations);
const changes = new EventEmitter(); changes.setMaxListeners(200);
const streams = new Set();
const jobs = new Map();
const providers = { desktop: { connected: false }, headless: { connected: false } };
const boots = new Map();
const dispatching = new Set();
const monitorStarted = new Set();
let cursor = 0;
const mirror = path.join(STATE, 'supervisor-jobs.json');
if (fs.existsSync(mirror)) for (const job of readJson(mirror).jobs ?? []) jobs.set(job.jobId, job);
const records = runtimeRecords(STATE, jobs, requests);
for (const [id, job] of jobs) jobs.set(id, records.decorate(job));
if (records.cleanup().removed) atomic(mirror, {jobs: [...jobs.values()]});
const compact = job => {
  const { events, usageSamples, reservation, ...rest } = job;
  return { ...rest, recentEvents: events?.slice(-4), ...(usageSamples?.length ? { usageSamples } : {}) };
};
const snapshot = id => {
  const owned = [...jobs.values()].filter(job => records.owns(job,id)).sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map(compact);
  return {instanceId, cursor, conversationId: id, providers, panel: getPanel(id).status(), retention: records.status(), jobs: owned, subagents: groupSubagents(owned)};
};
function publish() {
  records.cleanup();
  cursor++;
  atomic(mirror, { jobs: [...jobs.values()] });
  changes.emit('change');
  for (const stream of streams) if (!stream.response.write('data: ' + JSON.stringify(snapshot(stream.conversationId)) + '\n\n')) { streams.delete(stream); stream.response.end(); }
}
function accept(mode, result) {
  let updated = false;
  for (const incoming of result.jobs) {
    if (!records.accepts(incoming)) continue;
    const previous = jobs.get(incoming.jobId);
    if (records.remember(incoming) !== previous) updated = true;
  }
  if (!providers[mode].connected || providers[mode].instanceId !== result.instanceId) updated = true;
  providers[mode] = { ...providers[mode], connected: true, instanceId: result.instanceId, sourceCursor: result.cursor };
  if (updated) publish();
}
async function monitor(mode) {
  if (monitorStarted.has(mode)) return;
  monitorStarted.add(mode);
  for (;;) {
    try {
      const current = providers[mode];
      const result = await pipeCall(mode, 'events', { afterCursor: current.sourceCursor ?? -1, instanceId: current.instanceId, timeoutMs: 25000 });
      accept(mode, result);
    } catch (error) {
      if (providers[mode].connected) { providers[mode] = { ...providers[mode], connected: false, error: error.message }; publish(); }
      await new Promise(resolve => setTimeout(resolve, 1500));
    }
  }
}
function startProcess(mode) {
  discoverRuntime(cfg.runtime.installDir);
  const child = spawn(process.execPath, [path.join(ROOT, 'server/host-runner.mjs'), mode], {
    cwd: cfg.defaults.workspace, windowsHide: true, detached: true, shell: false, stdio: 'ignore',
    env: { ...process.env, CODEX_DSH_STATE_DIR: STATE },
  });
  child.on('error', error => { providers[mode].error = error.message; });
  child.unref();
  providers[mode] = { connected: false, runnerPid: child.pid, startedByBridge: true };
}
async function ensure(mode) {
  if (!['desktop', 'headless'].includes(mode)) throw new Error('mode must be desktop or headless');
  discoverRuntime(cfg.runtime.installDir);
  try { const result = await pipeCall(mode, 'doctor', {}, 2000); void monitor(mode); return result; } catch (error) {
    if (!['ENOENT', 'ECONNREFUSED'].includes(error.code)) throw error;
  }
  if (!boots.has(mode)) boots.set(mode, (async () => {
    startProcess(mode);
    let failure;
    for (let i = 0; i < 150; i++) {
      await new Promise(resolve => setTimeout(resolve, 300));
      try {
        const result = await pipeCall(mode, 'doctor', {}, 1500);
        const launch = readJson(path.join(STATE, mode + '-launch.json'));
        providers[mode] = { ...providers[mode], pid: launch.pid, runnerPid: launch.runnerPid };
        void monitor(mode); return result;
      } catch (error) { failure = error; }
    }
    const log = path.join(STATE, 'logs', mode + '.log');
    throw new Error(`DSH ${mode} bridge did not become ready (${failure?.message}); inspect ${log}`);
  })().finally(() => boots.delete(mode)));
  return boots.get(mode);
}
function focusDesktop() {
  const runtime = discoverRuntime(cfg.runtime.installDir);
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(runtime.executable, [], { env, detached: true, windowsHide: false, shell: false, stdio: 'ignore' });
  child.on('error', error => { providers.desktop.error = error.message; }); child.unref();
}
async function locate(params) {
  let job = jobs.get(params.jobId);
  if (!job) for (const mode of ['desktop', 'headless']) {
    try { accept(mode, await pipeCall(mode, 'list', {}, 2500)); } catch {}
  }
  job = jobs.get(params.jobId);
  if (!job || !records.owns(job,conversationId(params))) throw new Error('Unknown jobId in this Codex conversation');
  return job;
}
async function waitChange(timeoutMs) {
  await new Promise(resolve => {
    let timer;
    const done = () => { clearTimeout(timer); changes.off('change', done); resolve(); };
    changes.once('change', done); timer = setTimeout(done, timeoutMs);
  });
}
let baseUrl;
const panels = new Map();
const dashboardUrl = id => baseUrl + '/?conversationId=' + encodeURIComponent(id) + '#' + cfg.token;
function getPanel(id) {
  conversationId({conversationId:id});
  if (!panels.has(id)) panels.set(id,statusPanel({url: () => dashboardUrl(id), state: STATE, refresh: () => {
    // Send data now rather than waiting for a background browser timer. This
    // does not create a heartbeat or pretend that the browser has drawn it.
    for (const stream of streams) if (stream.conversationId === id)
      if (!stream.response.write('data: ' + JSON.stringify(snapshot(id)) + '\n\n')) stream.response.destroy();
  }}));
  return panels.get(id);
}
const methods = {
  doctor: async params => {
    const states = {};
    for (const mode of ['desktop', 'headless']) {
      try { states[mode] = await pipeCall(mode, 'doctor', {}, 2000); } catch (error) { states[mode] = { connected: false, error: error.code ?? error.message }; }
    }
    return { version: '0.6.2', runtime: discoverRuntime(cfg.runtime.installDir), defaults: cfg.defaults, providers: states,
      ...(params.conversationId ? {dashboardUrl: dashboardUrl(conversationId(params)), panel: getPanel(params.conversationId).status()} : {}), retention: records.status(), callback: { activeWait: true, idleCodexWakeup: 'not-supported-or-verified' } };
  },
  configure: async params => { const entry = configurations.create(params); return {...entry, url: baseUrl + '/?conversationId=' + encodeURIComponent(entry.conversationId) + '&configure=' + entry.configurationId + '#' + cfg.token}; },
  configuration: async params => configurations.read(conversationId(params)),
  saveConfiguration: async params => configurations.confirm(conversationId(params), params.configurationId, params.values),
  panelHeartbeat: async params => {const id=conversationId(params);return getPanel(id).heartbeat({...params,jobs:params.jobs?.filter(job => jobs.has(job.jobId) && records.owns(jobs.get(job.jobId),id))})},
  catalog: async params => { const mode = params.mode ?? 'headless'; await ensure(mode); return pipeCall(mode, 'catalog'); },
  sessions: async params => { const mode = params.mode ?? 'desktop'; await ensure(mode); return pipeCall(mode, 'sessions', params); },
  prepare: async params => { const mode = params.mode ?? 'headless'; await ensure(mode); return pipeCall(mode, 'prepare', params); },
  start: async params => {
    const panel=getPanel(conversationId(params));
    const selected = requests.resolve(params);
    await panel.ensure();
    const job = await dispatch(selected);
    return {...job, panel: await panel.rendered([job.jobId])};
  },
  start_many: async params => {
    const id=conversationId(params);const panel=getPanel(id);
    if (params.userAuthorized !== true) throw new Error('Explicit user permission to use DSH is required');
    if (!Array.isArray(params.tasks) || !params.tasks.length || params.tasks.length > 16) throw new Error('Provide 1 to 16 tasks');
    if (new Set(params.tasks.map(task => task.requestId)).size !== params.tasks.length) throw new Error('Every task needs a distinct requestId');
    if (params.configurationId !== undefined) throw new Error('Configuration is selected by Codex conversation; omit configurationId');
    const selected = params.tasks.map(task => requests.resolve({...task, userAuthorized: true, conversationId: id}));
    await panel.ensure();
    const settled = await Promise.allSettled(selected.map(task => dispatch(task)));
    const accepted = settled.flatMap(result => result.status === 'fulfilled' ? [result.value] : []);
    const errors = settled.flatMap((result, index) => result.status === 'rejected' ? [{requestId: selected[index].requestId, message: result.reason.message}] : []);
    return {jobs: accepted, errors, panel: await panel.rendered(accepted.map(job => job.jobId))};
  },
  resume: async params => {
    const panel=getPanel(conversationId(params));
    const selected = requests.resolve(params, 'resume');
    await panel.ensure();
    const job = await dispatch(selected);
    return {...job, panel: await panel.rendered([job.jobId])};
  },
  list: async params => snapshot(conversationId(params)),
  status: async params => {
    const job = await locate(params);
    try { const current = records.remember(await pipeCall(job.mode, 'status', params, 3000)); publish(); return compact(current); }
    catch (error) { return { ...compact(job), connection: 'disconnected', connectionError: error.message }; }
  },
  result: async params => methods.status(params),
  wait: async params => {
    const id=conversationId(params);
    const ids = params.jobIds ?? [...jobs.values()].filter(job => records.owns(job,id)).map(job => job.jobId);
    if (!Array.isArray(ids) || !ids.length) return { ...snapshot(id), reason: 'no-jobs' };
    for (const jobId of ids) if (!jobs.has(jobId) || !records.owns(jobs.get(jobId),id)) throw new Error('Unknown jobId in this Codex conversation');
    const deadline = Date.now() + Math.max(0, Math.min(params.timeoutMs ?? 45000, 45000));
    const actionable = () => ids.some(id => !jobs.has(id) || terminal(jobs.get(id).status) || jobs.get(id).status.startsWith('waiting-'));
    while (!(actionable() && (params.afterCursor === undefined || params.afterCursor !== cursor)) && Date.now() < deadline) await waitChange(deadline - Date.now());
    return { instanceId, cursor, reason: actionable() ? 'attention-or-completion' : 'timeout', jobs: ids.flatMap(id => jobs.has(id)?[compact(jobs.get(id))]:[]) };
  },
  cancel: async params => { const job = await locate(params); return pipeCall(job.mode, 'cancel', params); },
  open: async params => {
    const id=conversationId(params);
    if (params.dashboard) {const panel=getPanel(id);return {url:dashboardUrl(id),conversationId:id,panel:await panel.ensure()};}
    const job = params.jobId ? await locate(params) : null;
    if (job?.mode === 'headless') throw new Error('This worker session has isolated storage; use the task dashboard to inspect it');
    await ensure('desktop');
    focusDesktop();
    return pipeCall('desktop', 'open', { ...params, sessionId: params.sessionId ?? job?.sessionId });
  },
  shutdownWorker: async () => pipeCall('headless', 'shutdown'),
};
async function dispatch(params) {
    const mode = params.mode ?? 'headless';
    const host = await ensure(mode);
    if (!host.capabilities?.includes('concurrent-sessions')) throw new Error('DSH must reload the updated bridge plugin before dispatch');
    discoverRuntime(cfg.runtime.installDir);
    const target = params.sessionId ? mode + ':' + params.sessionId : null;
    if (target && dispatching.has(target)) throw new Error('A dispatch is in progress in this session; retry the same requestId');
    if ([...jobs.values()].some(job => !terminal(job.status) && (job.requestId !== params.requestId || job.mode !== mode)
      && target && job.mode === mode && job.sessionId === params.sessionId)) throw new Error('Another bridge task is active in this session');
    if (target) dispatching.add(target);
    try {
      const job = records.remember(records.assign(await pipeCall(mode, 'start', { ...params, requestId: params.requestId ?? randomUUID() }), conversationId(params)));
      publish(); return compact(job);
    } finally { if (target) dispatching.delete(target); }
}
const server = http.createServer(async (request, response) => {
  response.setHeader('cache-control', 'no-store');
  response.setHeader('x-content-type-options', 'nosniff');
  const host = request.headers.host;
  if (baseUrl && host !== new URL(baseUrl).host) { response.writeHead(403); return response.end('Forbidden host'); }
  if (request.url.split('?')[0] === '/' && request.method === 'GET') {
    response.setHeader('content-type', 'text/html; charset=utf-8');
    response.setHeader('content-security-policy', "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'self'; frame-ancestors 'self'");
    return response.end(fs.readFileSync(path.join(ROOT, 'ui/dashboard.html')));
  }
  if (request.url === '/dashboard.js' && request.method === 'GET') {
    response.setHeader('content-type', 'text/javascript; charset=utf-8');
    return response.end(fs.readFileSync(path.join(ROOT, 'ui/dashboard.js')));
  }
  if (!equal(request.headers.authorization, 'Bearer ' + cfg.token)) { response.writeHead(401); return response.end(JSON.stringify({ error: { message: 'Unauthorized' } })); }
  if (request.headers.origin && request.headers.origin !== baseUrl) { response.writeHead(403); return response.end('Forbidden origin'); }
  if (request.url === '/health') { response.setHeader('content-type', 'application/json'); return response.end(JSON.stringify({ instanceId })); }
  if (request.url.split('?')[0] === '/events' && request.method === 'GET') {
    let id;try{id=conversationId({conversationId:new URL(request.url,baseUrl).searchParams.get('conversationId')})}catch(error){response.writeHead(400);return response.end(error.message)}
    response.writeHead(200, { 'content-type': 'text/event-stream', connection: 'keep-alive' });
    response.write('data: ' + JSON.stringify(snapshot(id)) + '\n\n'); const stream={response,conversationId:id};streams.add(stream);
    const keepalive = setInterval(() => response.write(': heartbeat\n\n'), 20000);
    request.on('close', () => { clearInterval(keepalive); streams.delete(stream); });
    return;
  }
  response.setHeader('content-type', 'application/json; charset=utf-8');
  if (request.url !== '/api' || request.method !== 'POST' || !request.headers['content-type']?.startsWith('application/json')) {
    response.writeHead(404); return response.end(JSON.stringify({ error: { message: 'Not found' } }));
  }
  try {
    let body = ''; for await (const chunk of request) { body += chunk; if (body.length > 1024 * 1024) throw new Error('Request too large'); }
    const call = JSON.parse(body);
    if (!Object.hasOwn(methods, call.method)) throw new Error('Unknown supervisor method');
    response.end(JSON.stringify({ result: await methods[call.method](call.params ?? {}) }));
  } catch (error) { response.end(JSON.stringify({ error: { code: error.code ?? 'supervisor/error', message: error.message } })); }
});
let previousPort = 0;
try { previousPort = Number(new URL(readJson(path.join(STATE, 'supervisor.json')).url).port); } catch {}
const listen = port => new Promise((resolve, reject) => { const fail = error => {server.off('listening', ready); reject(error)}; const ready = () => {server.off('error', fail); resolve()}; server.once('error', fail); server.once('listening', ready); server.listen(port, '127.0.0.1'); });
try { await listen(previousPort); } catch (error) { if (!previousPort || error.code !== 'EADDRINUSE') throw error; await listen(0); }
baseUrl = 'http://127.0.0.1:' + server.address().port;
atomic(path.join(STATE, 'supervisor.json'), { instanceId, pid: process.pid, url: baseUrl, sourceRoot: ROOT, startedAt: new Date().toISOString() });
void monitor('desktop'); void monitor('headless');
setInterval(() => {if(records.cleanup().removed)publish()},3600000).unref();
console.error('DSH supervisor ready at ' + baseUrl);
