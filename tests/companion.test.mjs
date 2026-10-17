import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { apply } from '../companion/index.mjs';

test('companion lifecycle, idempotency, cancellation, preset ownership and authentication without a model', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-dsh-test-'));
  const originalState = process.env.CODEX_DSH_STATE_DIR;
  process.env.CODEX_DSH_STATE_DIR = root;
  const anchor = path.join(root, 'package.json'); fs.writeFileSync(anchor, '{}');
  const manifest = path.join(root, 'node_modules/@deepseek-ai/dsh/package.json');
  fs.mkdirSync(path.dirname(manifest), { recursive: true }); fs.writeFileSync(manifest, JSON.stringify({ version: '0.2.1-rc.1' }));
  const pipe = process.platform === 'win32' ? '\\\\.\\pipe\\codex-dsh-test-' + randomUUID() : path.join(root, 'bridge.sock');
  const settings = { token: randomUUID(), pipes: { headless: pipe }, defaults: { workspace: root, permission: 'danger-full-access' } };
  fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify(settings));
  const bus = new EventEmitter(); const agents = new Map(); const persisted = new Map(); const effects = [];
  let promptCount = 0; let globalSaves = 0; let flushes = 0; let createCount = 0; let resumeError;
  const ctx = {
    profileContext: { name: 'codex-worker', installAnchor: anchor },
    logger: { info() {}, warn() {} },
    effect(fn) { const dispose = fn(); if (dispose) effects.push(dispose); return dispose; },
    on(event, fn) { bus.on(event, fn); const off = () => bus.off(event, fn); effects.push(off); return off; },
    get(name) { return name === 'jobs' ? { list: () => [] } : undefined; },
    agents: { get: id => agents.get(id), list: () => [...agents.values()] },
    sessions: { async flush() { flushes++; } },
    sessionQuery: { async observeSession(id) { const agent = persisted.get(id); if (!agent) throw new Error('Session not found');
      return { header: agent.session.header, projections: { values: { agentPreset: agent.preset } }, [Symbol.dispose]() {} }; } },
    sessionProjections: { onChanged(fn) { bus.on('projection', fn); return () => bus.off('projection', fn); } },
    agentPresets: { defaultId: 'unity', async resolve(id) { if (id !== 'unity') throw new Error('Unknown preset'); return { id }; },
      composedPreset: scope => scope.agent.preset, serviceFor: () => ({ schemas: () => [{ name: 'unity_execute' }, { name: 'subagent' }] }), async remoteExportList() { return { presets: [{ id: 'unity' }] }; } },
    agentDefaultModel: { currentSelection: () => ({ provider: 'fake', model: 'fake-v1' }), async saveSelection() { globalSaves++; } },
    permissionPresets: { current: session => session.permission, set: (session, value) => { session.permission = value; }, catalog: () => ({}) },
    workspaceRegistry: { create: async workspace => ({ id: workspace }), list: () => [] },
    llm: { resolveCallConfig: async config => config },
    connection: { fetch: { register: () => () => {} } },
    appExit() {},
  };
  const makeAgent = request => {
    const events = []; let turn = 0; let resolveIdle;
    const session = { header: { cwd: request.workspaceId, agentPreset: request.agentPreset }, id: request.sessionId, permission: 'workspace-write',
      get seq() { return events.length; }, eventAt: seq => events[seq], requestHeader: () => ({ config: agent.selection.current }),
      append(type, data) { const event = { type, data, seq: events.length }; events.push(event); bus.emit('session/event', session, event); } };
    const agent = { id: request.sessionId, preset: request.agentPreset, status: 'idle', session, selection: { current: { provider: 'fake', model: 'fake-v1' } },
      ctx: {}, whenIdle: () => agent.idle ?? Promise.resolve(),
      begin() { agent.status = 'running'; agent.idle = new Promise(resolve => { resolveIdle = resolve; }); session.append('turn/start', { turn: ++turn }); bus.emit('agent/status'); },
      finish(kind, text) { if (agent.status !== 'running') return; if (text) session.append('assistant/message', { message: { content: [{ type: 'text', text }] }, usage: { inputTokens: 1, outputTokens: 1 } }); session.append('turn/end', { reason: kind === 'error' ? { kind, error: { code: 'fake/error', message: 'fake failure' } } : { kind } }); agent.status = 'idle'; resolveIdle(); bus.emit('agent/status'); },
      cancel() { agent.finish('aborted'); },
    };
    agent.ctx.agent = agent; agents.set(agent.id, agent); persisted.set(agent.id, agent); return agent;
  };
  ctx.sessionController = {
    agents: { selectionFor: agent => agent.selection, selectForNextRequest: (agent, selected) => { agent.selection.current = selected; },
      async resolveAgent(id) { if (resumeError) return { error: resumeError }; const agent = persisted.get(id); if (!agent) return { error: new Error('Session not found') }; agents.set(id, agent); return { agent }; } },
    async create(request) {
      createCount++;
      // DSH 0.2.1 creates another session when a named conversation has started.
      if (persisted.get(request.sessionId)?.session.seq > 0) request = { ...request, sessionId: 'minted-' + randomUUID() };
      if (!agents.has(request.sessionId)) makeAgent(request); return { sessionId: request.sessionId };
    },
    async rename() {}, async modelCatalog() { return {}; }, async list() { return { items: [...agents.values()].map(agent => ({ sessionId: agent.id, cwd: root, running: agent.status === 'running', projections: { kind: 'sequenced', asOfSeq: agent.session.seq, values: { title: '旧问题 Unity', agentPreset: agent.preset } } })) }; },
    async prompt(request) { promptCount++; const agent = agents.get(request.sessionId); agent.begin(); const text = request.content[0].text;
      if (text === 'child') {
        const child = makeAgent({ sessionId: 'child-' + randomUUID(), workspaceId: root, agentPreset: 'unity' }); child.session.header.parentSession = agent.id; child.begin();
        setTimeout(() => agent.finish('completed', 'parent done'), 5); setTimeout(() => child.finish('completed', 'child done'), 65);
      } else if (text !== 'hold') setTimeout(() => agent.finish(text === 'fail' ? 'error' : 'completed', '中文回调✓'), 35); return { accepted: true }; },
    async cancel(request) { agents.get(request.sessionId)?.cancel(); },
  };
  function call(method, params = {}, token = settings.token, fragmented = false) {
    return new Promise((resolve, reject) => {
      const socket = net.createConnection(pipe); socket.setEncoding('utf8'); let buffer = '';
      const timeout = setTimeout(() => { socket.destroy(); reject(new Error('test timeout')); }, 2000);
      socket.on('connect', () => { const data = Buffer.from(JSON.stringify({ id: 1, token, method, params }) + '\n');
        if (fragmented) { const split = data.indexOf(Buffer.from('中文')) + 1; socket.write(data.subarray(0, split)); setTimeout(() => socket.write(data.subarray(split)), 1); } else socket.write(data); });
      socket.on('error', reject); socket.on('data', chunk => { buffer += chunk; if (!buffer.includes('\n')) return; clearTimeout(timeout); socket.destroy(); const value = JSON.parse(buffer.split('\n')[0]); value.error ? reject(new Error(value.error.message)) : resolve(value.result); });
    });
  }
  const settled = async id => { for (let i = 0; i < 150; i++) { const job = await call('status', { jobId: id }); if (['completed','failed','cancelled'].includes(job.status)) return job; await new Promise(resolve => setTimeout(resolve, 5)); } throw new Error('job did not settle'); };
  try {
    await apply(ctx);
    await t.test('wrong token is rejected', async () => { await assert.rejects(call('doctor', {}, 'wrong'), /Unauthorized/); });
    let sessionId;
    await t.test('blank session mounts exact preset and session model without global save', async () => {
      const session = await call('prepare', { preset: 'unity', model: { provider: 'fake', model: 'fake-v2' } }); sessionId = session.sessionId;
      assert.equal(session.effective.preset, 'unity'); assert.equal(session.effective.permission, 'danger-full-access');
      assert.equal(session.effective.model.model, 'fake-v2'); assert.ok(session.effective.tools.includes('subagent')); assert.equal(globalSaves, 0); assert.equal(promptCount, 0);
    });
    await t.test('UTF-8 fragments, completion and retry deduplication', async () => {
      const params = { requestId: 'unique-1', sessionId, prompt: '中文任务' };
      const first = await call('start', params, settings.token, true); const done = await settled(first.jobId);
      assert.equal(done.status, 'completed'); assert.equal(done.result, '中文回调✓'); assert.equal(done.actualModel.model, 'fake-v2'); assert.ok(flushes >= 2);
      const again = await call('start', params); assert.equal(again.jobId, first.jobId); assert.equal(promptCount, 1);
      await assert.rejects(call('start', { ...params, prompt: 'changed' }), /different arguments/);
    });
    await t.test('cold resume restores the exact nonblank session without creating or changing its settings', async () => {
      const original = persisted.get(sessionId); const createdBefore = createCount;
      agents.delete(sessionId);
      const resumed = await call('prepare', { sessionId });
      assert.equal(resumed.sessionId, sessionId); assert.equal(agents.get(sessionId), original);
      assert.equal(createCount, createdBefore); assert.equal(resumed.effective.model.model, 'fake-v2');
      assert.equal(resumed.effective.preset, 'unity'); assert.equal(resumed.effective.permission, 'danger-full-access');
      assert.equal(promptCount, 1);
    });
    await t.test('resume domain errors never fall back to creating or prompting another session', async () => {
      const createdBefore = createCount;
      resumeError = Object.assign(new Error('Session writer is held'), { code: 'session/writer-held' });
      try { await assert.rejects(call('prepare', { sessionId }), /writer is held/); }
      finally { resumeError = undefined; }
      assert.equal(createCount, createdBefore); assert.equal(promptCount, 1);
    });
    await t.test('preset or workspace mismatch never sends a prompt', async () => {
      const job = await call('start', { requestId: 'mismatch', sessionId, preset: 'other', prompt: 'hi' });
      assert.equal((await settled(job.jobId)).status, 'failed'); assert.equal(promptCount, 1);
      const missing = await call('start', { requestId: 'missing', sessionId: 'nonexistent', prompt: 'hi' }).catch(error => error);
      assert.match(missing.message, /not found/); assert.equal(promptCount, 1);
      const other = path.join(root, 'other-workspace'); fs.mkdirSync(other);
      const mismatch = await call('start', { requestId: 'wrong-workspace', sessionId, workspace: other, prompt: 'hi' });
      assert.equal((await settled(mismatch.jobId)).status, 'failed'); assert.equal(promptCount, 1);
    });
    await t.test('session title queries use the persisted projection without loading a transcript', async () => {
      const matches = await call('sessions', { query: 'unity', workspace: root }); assert.equal(matches.length, 1); assert.equal(matches[0].sessionId, sessionId);
    });
    await t.test('completion waits for local descendants, not just the root turn', async () => {
      const begun = Date.now(); const job = await call('start', { requestId: 'child', sessionId, prompt: 'child' });
      const done = await settled(job.jobId); assert.equal(done.status, 'completed'); assert.ok(Date.now() - begun >= 55);
      assert.equal(done.descendants.length, 1); assert.equal(done.descendants[0].status, 'idle');
    });
    await t.test('event long poll wakes and cancellation settles one task', async () => {
      const before = await call('list');
      const wake = call('events', { afterCursor: before.cursor, instanceId: before.instanceId, timeoutMs: 1000 });
      const job = await call('start', { requestId: 'cancel', sessionId, prompt: 'hold' });
      const update = await wake; assert.ok(update.cursor > before.cursor);
      while ((await call('status', { jobId: job.jobId })).status === 'starting') await new Promise(resolve => setTimeout(resolve, 5));
      await call('cancel', { jobId: job.jobId }); assert.equal((await settled(job.jobId)).status, 'cancelled');
    });
    await t.test('model failure is terminal failed, never fake success', async () => {
      const job = await call('start', { requestId: 'failure', sessionId, prompt: 'fail' }); const done = await settled(job.jobId);
      assert.equal(done.status, 'failed'); assert.equal(done.error.code, 'fake/error');
    });
    await t.test('independent sessions run concurrently in one workspace, but the same resumed session stays exclusive', async () => {
      const [one,two]=await Promise.all(['parallel-1','parallel-2'].map(requestId=>call('start',{requestId,prompt:'hold',workspace:root})));
      for(const job of [one,two])while((await call('status',{jobId:job.jobId})).status==='starting')await new Promise(resolve=>setTimeout(resolve,5));
      const current=await Promise.all([one,two].map(job=>call('status',{jobId:job.jobId})));
      assert.notEqual(current[0].sessionId,current[1].sessionId);assert.ok(current.every(job=>job.status==='running'));
      await assert.rejects(call('start',{requestId:'busy-resume',sessionId:current[0].sessionId,prompt:'hold'}),/session|busy/);
      await call('cancel',{jobId:one.jobId});assert.equal((await settled(one.jobId)).status,'cancelled');
      assert.equal((await call('status',{jobId:two.jobId})).status,'running');
      await call('cancel',{jobId:two.jobId});await settled(two.jobId);
    });
    await t.test('unknown DSH version refuses startup', async () => {
      fs.writeFileSync(manifest, JSON.stringify({ version: '0.3.0' })); await assert.rejects(apply(ctx), /supports 0.2.1-rc.1/);
    });
    assert.equal(globalSaves, 0);
  } finally {
    for (const dispose of effects.reverse()) if (typeof dispose === 'function') await dispose();
    if (originalState === undefined) delete process.env.CODEX_DSH_STATE_DIR; else process.env.CODEX_DSH_STATE_DIR = originalState;
    await new Promise(resolve => setTimeout(resolve, 30));
    const resolved = path.resolve(root); const temporary = path.resolve(os.tmpdir());
    assert.ok(resolved.startsWith(temporary + path.sep) && path.basename(resolved).startsWith('codex-dsh-test-'));
    fs.rmSync(resolved, { recursive: true, force: true });
  }
});
