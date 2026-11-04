import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { ROOT, STATE, atomic, readJson } from './common.mjs';
import { loadBridge } from './bridge.mjs';

if (process.argv.length > 2) throw new Error('Usage: node server/setup.mjs (install Common/dsh-bridge separately first)');
const bridge = await loadBridge();
const runtime = bridge.runtime(); // Shared compatibility check; starts no Host.
const settingsPath = path.join(STATE, 'config.json');
const old = fs.existsSync(settingsPath) ? readJson(settingsPath) : {};
if (fs.existsSync(settingsPath)) {
  const stamp = new Date().toISOString().replaceAll(/[:.]/g, '-') + '-' + randomBytes(4).toString('hex');
  const backup = path.join(STATE, 'backups', stamp, 'config.json');
  fs.mkdirSync(path.dirname(backup), { recursive: true });
  fs.copyFileSync(settingsPath, backup);
}
const defaults = { ...bridge.defaults, ...old.defaults };
const workspace = path.resolve(process.env.CODEX_DSH_WORKSPACE || defaults.workspace);
fs.mkdirSync(workspace, { recursive: true });
atomic(settingsPath, { sourceRoot: ROOT, token: old.token || randomBytes(32).toString('hex'), defaults: { ...defaults, workspace } });
console.log(JSON.stringify({ configured: true, stateDir: STATE, version: runtime.version }));
