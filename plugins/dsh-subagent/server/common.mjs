import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const STATE = path.resolve(process.env.CODEX_DSH_STATE_DIR || path.join(os.homedir(), '.codex', 'dsh-subagent'));
// Windows cannot rename a cache directory held as a process working directory.
export function enterStateDirectory() {
  fs.mkdirSync(STATE, { recursive: true });
  process.chdir(STATE);
}
const identity = createHash('sha256').update(path.resolve(STATE).toLowerCase()).digest('hex').slice(0, 16);
export const supervisorLock = process.platform === 'win32' ? '\\\\.\\pipe\\codex-dsh-subagent-' + identity : path.join(STATE, 'supervisor.sock');
export const terminal = status => ['completed', 'failed', 'cancelled', 'interrupted'].includes(status);
export const readJson = file => JSON.parse(fs.readFileSync(file, 'utf8'));
export const config = () => readJson(path.join(STATE, 'config.json'));
export function atomic(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = file + '.' + randomUUID() + '.tmp';
  fs.writeFileSync(temp, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(temp, file);
}
export function equal(a, b) {
  return typeof a === 'string' && typeof b === 'string' && Buffer.byteLength(a) === Buffer.byteLength(b)
    && timingSafeEqual(Buffer.from(a), Buffer.from(b));
}
