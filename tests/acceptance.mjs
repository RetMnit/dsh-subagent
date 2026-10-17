// Opt-in real DSH Host acceptance with an isolated home and a local fake model.
// Run: DSH_INSTALL_DIR=<desktop installation> node tests/acceptance.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { ROOT, discoverRuntime } from '../server/common.mjs';

const runtime = discoverRuntime(process.env.DSH_INSTALL_DIR);
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-dsh-acceptance-'));
const home = path.join(root, 'home'), state = path.join(root, 'state'), workspace = path.join(root, 'workspace');
const profile = path.join(home, 'profiles', 'bridge-acceptance');
const fixture = path.join(root, 'fixture');
const pipe = process.platform === 'win32' ? '\\\\.\\pipe\\codex-dsh-acceptance-' + randomUUID() : path.join(root, 'bridge.sock');
const token = randomUUID();
const write = (file, value) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value, null, 2)); };
for (const directory of [profile, state, workspace, fixture]) fs.mkdirSync(directory, { recursive: true });
write(path.join(state, 'config.json'), { token, pipes: { headless: pipe }, defaults: { workspace, permission: 'workspace-write' } });
write(path.join(fixture, 'package.json'), { name: '@local/dsh-bridge-acceptance', version: '1.0.0', type: 'module', main: './index.mjs', dsh: { bundle: { patch: './cordis.patch.yml' } } });
write(path.join(fixture, 'cordis.patch.yml'), '- insert:\n    - id: bridge-fake-model\n      name: "@local/dsh-bridge-acceptance"\n');
write(path.join(fixture, 'index.mjs'), `
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
export const inject = ['llm'];
export async function apply(ctx) {
const require = createRequire(ctx.profileContext.installAnchor);
const { LlmAdapter } = await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-llm')).href);
class FakeAdapter extends LlmAdapter {
  async listModels(provider) { return [{ provider, id: 'fake', name: 'Local fake model' }]; }
  async *stream() {
    const text = '本地假模型验收成功';
    yield { type: 'block-start', index: 0, blockType: 'text' };
    yield { type: 'text-delta', index: 0, text };
    yield { type: 'block-end', index: 0, block: { type: 'text', text } };
    yield { type: 'usage', usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } };
    yield { type: 'finish', reason: { kind: 'stop' } };
  }
}
ctx.llm.registerAdapter(['bridge-test'], new FakeAdapter());
}
`);
const dependencies = { '@local/codex-dsh-bridge': path.join(ROOT, 'companion'), '@local/dsh-bridge-acceptance': fixture };
for (const [name, target] of Object.entries(dependencies)) {
  const link = path.join(profile, 'node_modules', name); fs.mkdirSync(path.dirname(link), { recursive: true });
  fs.symlinkSync(target, link, process.platform === 'win32' ? 'junction' : 'dir');
}
write(path.join(profile, 'package.json'), { name: 'dsh-profile-bridge-acceptance', private: true,
  dependencies: Object.fromEntries(Object.entries(dependencies).map(([name, target]) => [name, 'link:' + target.replaceAll('\\', '/')])),
  dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', ...Object.keys(dependencies)] } } });
write(path.join(profile, 'cordis.yml'), '[]\n');
write(path.join(profile, 'cordis.patch.yml'), [
  '- id: web-runtime', '  config:', '    openBrowser: false', '    printUrl: false', '    surfaceContext: false', '    trustedHosts: []',
  ...['hmr', 'session-title-llm', 'session-log-deepseek'].flatMap(id => ['- id: ' + id, '  disabled: true']),
  '- id: agent-default-model', '  config:', '    provider: bridge-test', '    model: fake', ''
].join('\n'));
let child, output = '';
const call = (method, params = {}) => new Promise((resolve, reject) => {
  const socket = net.createConnection(pipe); socket.setEncoding('utf8'); let buffer = '';
  const finish = (error, value) => { clearTimeout(timer); socket.destroy(); error ? reject(error) : resolve(value); };
  const timer = setTimeout(() => finish(new Error('IPC timeout: ' + method)), 5000);
  socket.on('connect', () => socket.write(JSON.stringify({ id: 1, token, method, params }) + '\n'));
  socket.on('error', error => finish(error));
  socket.on('data', chunk => { buffer += chunk; if (!buffer.includes('\n')) return; try { const reply = JSON.parse(buffer.split('\n')[0]); finish(reply.error ? new Error(reply.error.message) : null, reply.result); } catch (error) { finish(error); } });
});
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function boot() {
  child = spawn(runtime.executable, ['--expose-internals', runtime.cli, '--profile', 'bridge-acceptance', '--no-open', '--port', '0'], {
    cwd: workspace, windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', DSH_HOME: home, CODEX_DSH_STATE_DIR: state, DSH_TELEMETRY_DISABLED: '1' }
  });
  for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => { output = (output + chunk).slice(-30000); });
  child.on('error', error => { output += error.stack; });
  for (let i = 0; i < 100; i++) {
    await delay(200);
    try { return await call('doctor'); } catch {}
    if (child.exitCode !== null) throw new Error('Host exited: ' + output);
  }
  throw new Error('Host never became ready: ' + output);
}
async function stop() {
  if (!child || child.exitCode !== null) return;
  const exited = new Promise(resolve => child.once('exit', resolve));
  try { await call('shutdown'); } catch { child.kill(); }
  let timeout;
  try { await Promise.race([exited, new Promise(resolve => { timeout = setTimeout(() => { if (child.exitCode === null) child.kill(); resolve(); }, 8000); })]); }
  finally { clearTimeout(timeout); }
}
async function settled(id) {
  for (let i = 0; i < 100; i++) { const job = await call('status', { jobId: id }); if (['completed', 'failed', 'cancelled'].includes(job.status)) return job; await delay(100); }
  throw new Error('Job never settled');
}
try {
  const firstHost = await boot();
  assert.equal(firstHost.dshVersion, runtime.version);
  const prepared = await call('prepare', { model: { provider: 'bridge-test', model: 'fake' } });
  assert.equal(prepared.effective.model.provider, 'bridge-test');
  const first = await call('start', { requestId: 'acceptance-first', sessionId: prepared.sessionId, prompt: 'Local fake model only' });
  const firstResult = await settled(first.jobId);
  assert.equal(firstResult.status, 'completed', JSON.stringify(firstResult.error));
  assert.equal(firstResult.result, '本地假模型验收成功');
  await stop();
  const secondHost = await boot();
  assert.notEqual(secondHost.instanceId, firstHost.instanceId);
  const resumed = await call('prepare', { sessionId: prepared.sessionId });
  assert.equal(resumed.sessionId, prepared.sessionId); assert.deepEqual(resumed.effective.model, prepared.effective.model);
  assert.equal(resumed.effective.preset, prepared.effective.preset); assert.equal(resumed.effective.permission, prepared.effective.permission);
  const second = await call('start', { requestId: 'acceptance-second', sessionId: prepared.sessionId, prompt: 'Resume local fake model only' });
  const secondResult = await settled(second.jobId);
  assert.equal(secondResult.status, 'completed', JSON.stringify(secondResult.error));
  assert.equal(secondResult.sessionId, firstResult.sessionId); assert.equal(secondResult.result, firstResult.result);
  assert.deepEqual(secondResult.actualModel, firstResult.actualModel);
  console.log(JSON.stringify({ passed: true, dshVersion: runtime.version, buildCommit: runtime.buildCommit, bridgeVersion: firstHost.bridgeVersion,
    checks: ['real Host startup', 'new session', 'fake model completion', 'Host restart', 'cold exact-session resume', 'model/preset/permission preservation', 'second turn completion'], externalModelRequests: 0 }, null, 2));
} catch (error) {
  console.error(output); throw error;
} finally {
  await stop();
  const resolved = path.resolve(root);
  assert.ok(resolved.startsWith(path.resolve(os.tmpdir()) + path.sep) && path.basename(resolved).startsWith('codex-dsh-acceptance-'));
  fs.rmSync(resolved, { recursive: true, force: true, maxRetries: 5, retryDelay: 250 });
}
