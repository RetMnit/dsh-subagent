import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawn, spawnSync} from 'node:child_process';
import {once} from 'node:events';
import {fileURLToPath} from 'node:url';
import {fakeConfig, fakeBridgeState} from './fixtures.mjs';

test('Windows refreshes an installed cache while its real MCP and supervisor remain alive', {
  skip: process.platform !== 'win32' || !process.env.CODEX_TEST_CLI,
  timeout: 60000,
}, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-dsh-cache-test-'));
  const home = path.join(root, 'codex-home');
  const state = path.join(root, 'state');
  const repo = fileURLToPath(new URL('../', import.meta.url));
  const version = JSON.parse(fs.readFileSync(path.join(repo, 'package.json'))).version;
  const config = fakeConfig(root);
  fs.mkdirSync(home); fs.mkdirSync(state);
  fs.writeFileSync(path.join(state, 'config.json'), JSON.stringify(config));
  const cwdLog = path.join(root, 'cwd.jsonl');
  const preload = path.join(root, 'cwd-probe.cjs');
  fs.writeFileSync(preload, `
    const fs = require('node:fs');
    const record = event => fs.appendFileSync(process.env.CODEX_CWD_PROBE, JSON.stringify({pid:process.pid,event,cwd:process.cwd()})+'\\n');
    record('start');
    const chdir = process.chdir.bind(process);
    process.chdir = dir => { chdir(dir); record('chdir'); };
  `);
  const env = {...process.env, CODEX_HOME: home, CODEX_DSH_STATE_DIR: state, DSH_BRIDGE_STATE_DIR: fakeBridgeState(root)};
  const cli = (...args) => {
    const result = spawnSync(process.env.CODEX_TEST_CLI, args, {env, cwd: root, windowsHide: true, encoding: 'utf8', timeout: 20000});
    assert.equal(result.error, undefined);
    assert.equal(result.status, 0, result.stderr + result.stdout);
    return JSON.parse(result.stdout);
  };
  let child, supervisorPid, stderr = '';
  try {
    cli('plugin', 'marketplace', 'add', repo, '--json');
    const installed = cli('plugin', 'add', 'dsh-subagent@dsh-subagent-tools', '--json').installedPath;
    assert.equal(path.basename(installed), version);
    assert.ok(!fs.existsSync(path.join(installed, '.git')));
    assert.ok(!fs.existsSync(path.join(installed, 'tests')));
    for (const manifest of ['mcp.json', '.mcp.json']) {
      const server = JSON.parse(fs.readFileSync(path.join(installed, manifest))).mcpServers['dsh-subagent'];
      assert.equal(server.cwd, undefined);
      assert.deepEqual(server.args, ['${PLUGIN_ROOT}/server/mcp.mjs']);
    }
    // Intentionally inherit the cache cwd: the entry point must release it itself.
    child = spawn(process.execPath, [path.join(installed, 'server/mcp.mjs')], {
      env: {...env, NODE_OPTIONS: '--require ' + JSON.stringify(preload), CODEX_CWD_PROBE: cwdLog},
      cwd: installed, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
    });
    child.stderr.on('data', chunk => { stderr += chunk; });
    let buffer = '', nextId = 0; const pending = new Map();
    child.stdout.on('data', chunk => {
      buffer += chunk;
      let cut;
      while ((cut = buffer.indexOf('\n')) >= 0) {
        const reply = JSON.parse(buffer.slice(0, cut)); buffer = buffer.slice(cut + 1);
        pending.get(reply.id)?.(reply); pending.delete(reply.id);
      }
    });
    const call = (method, params = {}) => new Promise((resolve, reject) => {
      const id = ++nextId;
      const timer = setTimeout(() => reject(new Error('MCP timeout: ' + stderr)), 10000);
      pending.set(id, reply => { clearTimeout(timer); resolve(reply); });
      child.stdin.write(JSON.stringify({jsonrpc: '2.0', id, method, params}) + '\n');
    });
    const init = await call('initialize');
    assert.equal(init.result.serverInfo.version, version);
    const doctor = await call('tools/call', {name: 'dsh_doctor', arguments: {}});
    assert.equal(doctor.result.isError, undefined, JSON.stringify(doctor));
    assert.equal(JSON.parse(doctor.result.content[0].text).runtime.version, 'fake-runtime');
    supervisorPid = JSON.parse(fs.readFileSync(path.join(state, 'supervisor.json'))).pid;
    const cwdEntries = fs.readFileSync(cwdLog, 'utf8').trim().split('\n').map(JSON.parse);
    assert.ok(cwdEntries.some(entry => entry.pid === child.pid && entry.event === 'chdir' && entry.cwd === state));
    assert.ok(cwdEntries.some(entry => entry.pid === supervisorPid && entry.event === 'start' && entry.cwd === state));
    assert.ok(cwdEntries.some(entry => entry.pid === supervisorPid && entry.event === 'chdir' && entry.cwd === state));
    cli('plugin', 'add', 'dsh-subagent@dsh-subagent-tools', '--json');
    assert.equal(child.exitCode, null);
    process.kill(supervisorPid, 0);
    assert.ok(!fs.existsSync(path.join(installed, '.git')));
    assert.deepEqual((await call('ping')).result, {});
    const after = await call('tools/call', {name: 'dsh_doctor', arguments: {}});
    assert.equal(after.result.isError, undefined);
    assert.equal(JSON.parse(fs.readFileSync(path.join(state, 'supervisor.json'))).pid, supervisorPid);
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) { child.kill(); await once(child, 'exit'); }
    // Only the supervisor created under this test's unique state directory is stopped.
    if (!supervisorPid && fs.existsSync(path.join(state, 'supervisor.json'))) supervisorPid = JSON.parse(fs.readFileSync(path.join(state, 'supervisor.json'))).pid;
    if (supervisorPid) {
      try { process.kill(supervisorPid); } catch (error) { if (error.code !== 'ESRCH') throw error; }
      for (let i = 0; i < 100; i++) {
        try { process.kill(supervisorPid, 0); } catch { break; }
        await new Promise(resolve => setTimeout(resolve, 20));
      }
    }
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith('codex-dsh-cache-test-'));
    fs.rmSync(root, {recursive: true, force: true});
  }
});
