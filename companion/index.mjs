import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID, timingSafeEqual, createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { EventEmitter } from 'node:events';
import { assertSupportedVersion, assertHostCapabilities } from './compatibility.mjs';

export const name = 'codex-dsh-bridge';
export const inject = ['agents', 'sessions', 'sessionController', 'sessionQuery', 'sessionProjections',
  'agentPresets', 'agentDefaultModel', 'permissionPresets', 'workspaceRegistry', 'llm', 'connection'];
const terminal = new Set(['completed', 'failed', 'cancelled', 'interrupted']);
const now = () => new Date().toISOString();
const errorOf = error => ({ code: error?.code ?? 'bridge/error', message: error?.message ?? String(error) });
const safeEqual = (a, b) => typeof a === 'string' && typeof b === 'string' && Buffer.byteLength(a) === Buffer.byteLength(b)
  && timingSafeEqual(Buffer.from(a), Buffer.from(b));
const string = (value, key) => { if (typeof value !== 'string' || !value.trim()) throw new Error(key + ' must be nonempty'); return value; };
const canonical = value => Array.isArray(value) ? value.map(canonical) : (value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value);
function atomic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = file + '.' + randomUUID() + '.tmp';
  fs.writeFileSync(temp, JSON.stringify(value, null, 2), { mode: 0o600 });
  fs.renameSync(temp, file);
}
function publicJob(job) {
  const { prompt, fingerprint, ...visible } = job;
  return visible;
}
async function changed(emitter, timeoutMs, signal) {
  if (signal?.aborted) return;
  await new Promise(resolve => {
    let timer;
    const done = () => { clearTimeout(timer); emitter.off('change', done); signal?.removeEventListener('abort', done); resolve(); };
    emitter.once('change', done);
    signal?.addEventListener('abort', done, { once: true });
    timer = setTimeout(done, timeoutMs);
  });
}

export async function apply(ctx) {
  const stateDir = process.env.CODEX_DSH_STATE_DIR || path.join(process.env.LOCALAPPDATA || os.homedir(), 'CodexDSHBridge');
  const settings = JSON.parse(fs.readFileSync(path.join(stateDir, 'config.json'), 'utf8'));
  const mode = ctx.profileContext.name === 'desktop' ? 'desktop' : 'headless';
  const requireFromDsh = createRequire(ctx.profileContext.installAnchor);
  const manifest = JSON.parse(fs.readFileSync(requireFromDsh.resolve('@deepseek-ai/dsh/package.json'), 'utf8'));
  assertSupportedVersion(manifest.version);
  assertHostCapabilities(ctx);
  const controller = ctx.sessionController;
  const pipe = settings.pipes[mode];
  const instanceId = randomUUID();
  const jobs = new Map();
  const requests = new Map();
  const reservations = new Map();
  const emitter = new EventEmitter();
  emitter.setMaxListeners(100);
  let cursor = 0;
  let nav = { revision: 0, sessionId: null };
  let navigationAck = null;
  const dir = path.join(stateDir, 'companion', mode);
  fs.mkdirSync(dir, { recursive: true });
  for (const file of fs.readdirSync(dir).filter(name => name.endsWith('.json'))) {
    try {
      const job = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
      if (!job.jobId) continue;
      if (!terminal.has(job.status)) { job.status = 'interrupted'; job.error = { code: 'bridge/restarted', message: 'DSH Host restarted; inspect before resuming' }; job.finishedAt = now(); atomic(path.join(dir, file), job); }
      jobs.set(job.jobId, job);
      requests.set(job.requestId, job.jobId);
    } catch (error) { ctx.logger.warn('Skipping unreadable bridge job: ' + file + ': ' + error.message); }
  }
  const publish = job => {
    job.updatedAt = now();
    atomic(path.join(dir, job.jobId + '.json'), job);
    cursor++;
    emitter.emit('change');
  };
  const navChanged = new EventEmitter();
  let navigationRetry;
  const navigate = sessionId => {
    clearTimeout(navigationRetry);
    nav = { revision: nav.revision + 1, sessionId }; const revision = nav.revision;
    navChanged.emit('change');
    navigationRetry = setTimeout(() => {
      if (nav.revision === revision && navigationAck?.revision !== revision) navigate(sessionId);
    }, 2000);
    navigationRetry.unref();
  };
  ctx.effect(() => () => clearTimeout(navigationRetry), 'codex-dsh-bridge navigation retry');
  const snapshot = () => ({ instanceId, cursor, jobs: [...jobs.values()].map(publicJob) });
  const inspect = agent => {
    const tools = ctx.agentPresets.serviceFor(agent, 'tools') ?? ctx.get('tools');
    return {
      workspace: agent.session.header.cwd,
      preset: ctx.agentPresets.composedPreset(agent.ctx) ?? agent.session.header.agentPreset,
      permission: ctx.permissionPresets.current(agent.session),
      model: controller.agents.selectionFor(agent).current,
      tools: tools?.schemas(agent).map(tool => tool.name) ?? [],
    };
  };
  const descendants = rootId => {
    const owned = new Set([rootId]); const result = []; let more = true;
    while (more) { more = false; for (const agent of ctx.agents.list()) {
      if (!owned.has(String(agent.id)) && owned.has(String(agent.session.header.parentSession))) {
        owned.add(String(agent.id)); more = true;
        result.push({ sessionId: String(agent.id), parentSessionId: String(agent.session.header.parentSession), status: agent.status });
      }
    } }
    return result;
  };
  const resolveExisting = async sessionId => {
    const observation = await ctx.sessionQuery.observeSession(string(sessionId, 'sessionId'));
    try {
      if (observation.header.origin === 'subagent' || observation.header.parentSession !== undefined) throw new Error('Use the owning parent to control a DSH child session');
      return { workspace: observation.header.cwd, preset: observation.projections?.values.agentPreset ?? observation.header.agentPreset };
    } finally { observation[Symbol.dispose](); }
  };
  const prepare = async params => {
    let existing;
    if (params.sessionId) existing = await resolveExisting(params.sessionId);
    const workspace = fs.realpathSync(existing?.workspace ?? params.workspace ?? settings.defaults.workspace);
    if (existing && params.workspace && fs.realpathSync(params.workspace) !== workspace) throw new Error('Cannot change a resumed session workspace');
    if (existing && params.preset && params.preset !== existing.preset) throw new Error('Cannot change a resumed session preset');
    if (!fs.statSync(workspace).isDirectory()) throw new Error('Workspace must be an existing directory');
    const preset = existing?.preset ?? params.preset ?? ctx.agentPresets.defaultId;
    const declaration = await ctx.agentPresets.resolve(preset);
    if (declaration.broken) throw new Error('Preset is broken: ' + declaration.broken);
    let sessionId = params.sessionId ?? ('codex-dsh-' + randomUUID());
    if (ctx.agents.get(sessionId)?.status === 'running') throw new Error('Session is busy; do not silently queue or steer existing work');
    if (descendants(sessionId).some(item => item.status === 'running')) throw new Error('Session still owns running subagents');
    let agent;
    if (existing) {
      const resolved = await controller.agents.resolveAgent(sessionId);
      if ('error' in resolved) throw resolved.error;
      agent = resolved.agent;
      if (String(agent?.id) !== sessionId) throw new Error('Resumed agent identity did not match the requested session');
    } else {
      const workspaceEntity = await ctx.workspaceRegistry.create(workspace);
      const created = await controller.create({ workspaceId: workspaceEntity.id, sessionId, agentPreset: preset });
      sessionId = created.sessionId;
      agent = ctx.agents.get(sessionId);
    }
    if (!agent) throw new Error('Created agent was not published');
    if (params.model) {
      const provider = string(params.model.provider, 'model.provider');
      const model = string(params.model.model, 'model.model');
      const selected = await ctx.llm.resolveCallConfig({ provider, model,
        ...(params.model.reasoningEffort === undefined ? {} : { reasoningEffort: params.model.reasoningEffort }) });
      controller.agents.selectForNextRequest(agent, { provider: selected.provider, model: selected.model,
        ...(selected.reasoningEffort === undefined ? {} : { reasoningEffort: selected.reasoningEffort }) });
    }
    if (!existing || params.permission) ctx.permissionPresets.set(agent.session, params.permission ?? settings.defaults.permission);
    if (!existing) await controller.rename({ sessionId, title: params.title || 'Codex 委派任务' });
    await ctx.sessions.flush(agent.session);
    return { sessionId, agent, effective: inspect(agent) };
  };
  const appendEvent = (job, event) => {
    job.events.push({ at: now(), ...event });
    if (job.events.length > 300) { job.events.shift(); job.eventsTruncated = true; }
    publish(job);
  };
  const run = async (job, params) => {
    let stop;
    let stopProjection;
    try {
      const prepared = await prepare(params);
      job.sessionId = prepared.sessionId;
      job.effective = prepared.effective;
      const agent = prepared.agent;
      const firstSeq = agent.session.seq;
      job.status = 'running';
      publish(job);
      if (job.cancelRequested) { job.status = 'cancelled'; return; }
      stop = ctx.on('session/event', (session, event) => {
        if (String(session.id) !== job.sessionId || event.seq < firstSeq) return;
        const data = event.data;
        if (event.type === 'turn/start') { job.status = 'running'; job.turn = data.turn; appendEvent(job, { type: 'turn/start', seq: event.seq, turn: data.turn }); }
        else if (event.type === 'assistant/message') {
          const text = data.message.content.filter(block => block.type === 'text').map(block => block.text).join('');
          if (text) job.result = text;
          if (data.usage) job.usageSamples.push(data.usage);
          appendEvent(job, { type: 'assistant/message', seq: event.seq, text: text.slice(0, 4000), truncated: text.length > 4000 });
        } else if (event.type === 'tool/call') appendEvent(job, { type: event.type, seq: event.seq, tool: data.name, callId: data.callId });
        else if (event.type === 'tool/result') appendEvent(job, { type: event.type, seq: event.seq, error: data.message?.isError === true });
        else if (event.type === 'turn/end') { job.stopReason = data.reason; appendEvent(job, { type: event.type, seq: event.seq, reason: data.reason }); }
        else if (event.type === 'request/header') {
          const used = agent.session.requestHeader()?.config;
          if (used) job.actualModel = { provider: used.provider, model: used.model, reasoningEffort: used.reasoningEffort };
          publish(job);
        }
      });
      stopProjection = ctx.sessionProjections.onChanged((session, key, value) => {
        if (String(session.id) !== job.sessionId || key !== 'userQuestions') return;
        const active = value?.active?.filter(item => item.state === 'open') ?? [];
        const pending = active.length > 0;
        if (pending) { job.status = 'waiting-user'; job.pendingQuestions = active; }
        else if (job.status === 'waiting-user') { job.status = 'running'; delete job.pendingQuestions; }
        publish(job);
      });
      await controller.prompt({ requestId: job.requestId, sessionId: job.sessionId, mode: 'queue', clientTimeZone: 'Asia/Shanghai', content: [{ type: 'text', text: job.prompt }] }, new AbortController().signal);
      for (;;) {
        await agent.whenIdle();
        job.descendants = descendants(job.sessionId);
        if (job.cancelRequested) {
          for (const child of job.descendants) ctx.agents.get(child.sessionId)?.cancel({ kind: 'user' }, { keepInbox: false });
        }
        const active = job.descendants.some(item => item.status === 'running');
        if (!active && (!job.pendingQuestions?.length || job.cancelRequested)) break;
        if (active) { job.phase = 'waiting-subagents'; publish(job); }
        await changed(emitter, 1000);
      }
      await ctx.sessions.flush(agent.session);
      const used = agent.session.requestHeader()?.config;
      if (used) job.actualModel = { provider: used.provider, model: used.model, reasoningEffort: used.reasoningEffort };
      job.eventCounts = {};
      for (let seq = firstSeq; seq < agent.session.seq; seq++) {
        const event = agent.session.eventAt(seq);
        if (event) job.eventCounts[event.type] = (job.eventCounts[event.type] ?? 0) + 1;
      }
      job.backgroundJobs = ctx.get('jobs')?.list(agent.id).filter(item => ['running', 'stopping'].includes(item.status)) ?? [];
      job.completionScope = 'agent-tree-turns';
      job.effective = inspect(agent);
      job.status = job.cancelRequested ? 'cancelled' : (job.stopReason?.kind === 'completed' ? 'completed' : (job.stopReason?.kind === 'aborted' ? 'cancelled' : 'failed'));
      if (job.stopReason?.kind === 'error') job.error = job.stopReason.error;
      if (!job.stopReason) job.error = { code: 'bridge/no-turn-end', message: 'No correlated turn ending was observed' };
    } catch (error) { job.status = 'failed'; job.error = errorOf(error); }
    finally {
      stop?.(); stopProjection?.();
      job.finishedAt = now();
      reservations.delete(job.reservation);
      publish(job);
    }
  };
  const starts = async params => {
    string(params.prompt, 'prompt');
    string(params.requestId, 'requestId');
    const fingerprint = createHash('sha256').update(JSON.stringify(canonical(params))).digest('hex');
    const prior = requests.get(params.requestId);
    if (prior) {
      const job = jobs.get(prior);
      if (job.fingerprint !== fingerprint) throw new Error('requestId already belongs to different arguments');
      return publicJob(job);
    }
    const existing = params.sessionId ? await resolveExisting(params.sessionId) : undefined;
    if (existing && (ctx.agents.get(params.sessionId)?.status === 'running' || [...jobs.values()].some(job => job.sessionId === params.sessionId && !terminal.has(job.status)))) throw new Error('Session is busy');
    const workspace = fs.realpathSync(existing?.workspace ?? params.workspace ?? settings.defaults.workspace);
    if (requests.has(params.requestId)) return starts(params);
    const reservation = params.sessionId ? 'session:' + params.sessionId : 'request:' + params.requestId;
    if (reservations.has(reservation)) throw new Error('This bridge already owns active work in the session');
    const job = { jobId: 'job-' + randomUUID(), requestId: params.requestId, fingerprint, prompt: params.prompt,
      promptSummary: params.prompt.slice(0, 120), mode, status: 'starting', createdAt: now(), updatedAt: now(),
      requested: { workspace, preset: params.preset, permission: params.permission, model: params.model }, reservation,
      title: params.title, configurationId: params.configurationId, configurationRevision: params.configurationRevision,
      events: [], usageSamples: [] };
    reservations.set(reservation, job.jobId);
    jobs.set(job.jobId, job); requests.set(job.requestId, job.jobId); publish(job);
    void run(job, params);
    return publicJob(job);
  };
  const methods = {
    doctor: async () => ({ protocolVersion: 1, bridgeVersion: '0.3.0', dshVersion: manifest.version, mode, pid: process.pid, instanceId,
      profile: ctx.profileContext.name, navigationAck, capabilities: ['presets', 'resume', 'session-model', 'permissions', 'events', 'cancel', 'concurrent-sessions', ...(mode === 'desktop' ? ['desktop-navigation'] : [])] }),
    catalog: async () => ({ presets: await ctx.agentPresets.remoteExportList(), models: await controller.modelCatalog(),
      permissions: ctx.permissionPresets.catalog(), workspaces: ctx.workspaceRegistry.list().map(item => ({ workspaceId: item.id, path: item.path, title: item.title })) }),
    sessions: async params => {
      const { items } = await controller.list({}, new AbortController().signal);
      return items.map(item => ({ sessionId: item.sessionId, title: item.title ?? item.projections?.values?.title ?? '', cwd: item.cwd,
        preset: item.projections?.values?.agentPreset, running: item.running, blank: item.blank, updatedAt: item.updatedAt }))
        .filter(item => (!params.workspace || item.cwd?.toLowerCase() === params.workspace.toLowerCase())
        && (!params.query || (item.title ?? '').toLowerCase().includes(params.query.toLowerCase()))).slice(0, params.limit ?? 30);
    },
    start: starts,
    prepare: async params => { const prepared = await prepare(params); return { sessionId: prepared.sessionId, effective: prepared.effective, modelRequested: false }; },
    list: async () => snapshot(),
    status: async params => { const job = jobs.get(params.jobId); if (!job) throw new Error('Unknown jobId'); return publicJob(job); },
    cancel: async params => {
      const job = jobs.get(params.jobId); if (!job) throw new Error('Unknown jobId');
      if (!terminal.has(job.status)) {
        job.cancelRequested = true; publish(job);
        if (job.sessionId) await controller.cancel({ sessionId: job.sessionId });
        for (const child of descendants(job.sessionId)) ctx.agents.get(child.sessionId)?.cancel({ kind: 'user' }, { keepInbox: false });
      }
      return publicJob(job);
    },
    events: async params => {
      if (params.afterCursor === cursor && params.instanceId === instanceId) await changed(emitter, Math.min(params.timeoutMs ?? 25000, 45000));
      return snapshot();
    },
    open: async params => {
      if (mode !== 'desktop') throw new Error('Desktop navigation is only available in Desktop mode');
      const sessionId = params.sessionId ?? jobs.get(params.jobId)?.sessionId;
      if (!sessionId) throw new Error('sessionId or a prepared jobId is required');
      await resolveExisting(sessionId);
      navigate(sessionId);
      return { queued: true, ...nav };
    },
    shutdown: async () => {
      if (mode === 'desktop') throw new Error('The bridge never exits the user Desktop');
      if ([...jobs.values()].some(job => !terminal.has(job.status))) throw new Error('Active tasks remain');
      setTimeout(() => ctx.appExit(0), 150).unref();
      return { accepted: true };
    },
  };
  ctx.effect(() => ctx.connection.fetch.register({ path: '/api/codex-dsh-navigation', methods: ['GET', 'POST'], requestBody: 'buffered',
    fetch: async request => {
      if (request.method === 'POST') {
        const ack = await request.json();
        if (ack.revision !== nav.revision || ack.sessionId !== nav.sessionId) return Response.json({ accepted: false });
        navigationAck = { revision: ack.revision, sessionId: ack.sessionId, at: now() };
        clearTimeout(navigationRetry);
        return Response.json({ accepted: true });
      }
      const after = Number(new URL(request.url).searchParams.get('after') ?? 0);
      if (after === nav.revision) await changed(navChanged, 20000, request.signal);
      return Response.json(nav);
    } }), 'codex-dsh-bridge navigation route');
  ctx.on('approval/request', async (request, next) => {
    const job = [...jobs.values()].find(item => item.sessionId === String(request.agent?.id) && !terminal.has(item.status));
    if (job) { job.status = 'waiting-approval'; publish(job); }
    try { return await next(); }
    finally { if (job && !terminal.has(job.status)) { job.status = 'running'; publish(job); } }
  });
  ctx.on('agent/status', () => {
    for (const job of jobs.values()) if (job.sessionId && !terminal.has(job.status)) { job.descendants = descendants(job.sessionId); publish(job); }
  });
  const sockets = new Set();
  const server = net.createServer(socket => {
    socket.setEncoding('utf8');
    sockets.add(socket); socket.on('close', () => sockets.delete(socket));
    let buffer = '';
    socket.on('data', chunk => {
      buffer += chunk.toString('utf8');
      if (Buffer.byteLength(buffer) > 2 * 1024 * 1024) return socket.destroy();
      let newline;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
        void (async () => {
          let request;
          try {
            request = JSON.parse(line);
            if (!safeEqual(request.token, settings.token)) throw new Error('Unauthorized');
            if (!Object.hasOwn(methods, request.method)) throw new Error('Unknown bridge method');
            const result = await methods[request.method](request.params ?? {});
            if (!socket.destroyed) socket.write(JSON.stringify({ id: request.id, result }) + '\n');
          } catch (error) { if (!socket.destroyed) socket.write(JSON.stringify({ id: request?.id ?? null, error: errorOf(error) }) + '\n'); }
        })();
      }
    });
    socket.on('error', () => {});
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(pipe, resolve); });
  ctx.effect(() => () => { for (const socket of sockets) socket.destroy(); server.close(); }, 'codex-dsh-bridge IPC');
  atomic(path.join(stateDir, mode + '-instance.json'), { protocolVersion: 1, instanceId, pid: process.pid, pipe, version: manifest.version, startedAt: now() });
  ctx.logger.info('Codex DSH bridge ready (' + mode + ', protocol 1)');
}
