import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { verifyRuntimeCompatibility } from '../companion/compatibility.mjs';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const STATE = process.env.CODEX_DSH_STATE_DIR || path.join(process.env.LOCALAPPDATA || os.homedir(), 'CodexDSHBridge');
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
export function pipeCall(mode, method, params = {}, timeoutMs = 55000) {
  const cfg = config();
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(cfg.pipes[mode]);
    socket.setEncoding('utf8');
    const id = randomUUID();
    let buffer = '';
    let done = false;
    const finish = (error, value) => { if (done) return; done = true; clearTimeout(timer); socket.destroy(); error ? reject(error) : resolve(value); };
    const timer = setTimeout(() => finish(new Error('DSH bridge request timed out: ' + method)), timeoutMs);
    socket.on('connect', () => socket.write(JSON.stringify({ id, token: cfg.token, method, params }) + '\n'));
    socket.on('error', error => finish(error));
    socket.on('end', () => { if (!done) finish(new Error('DSH bridge disconnected before replying')); });
    socket.on('data', chunk => {
      buffer += chunk;
      if (buffer.length > 16 * 1024 * 1024) return finish(new Error('Bridge response exceeded limit'));
      const newline = buffer.indexOf('\n');
      if (newline < 0) return;
      try {
        const reply = JSON.parse(buffer.slice(0, newline));
        if (reply.id !== id) throw new Error('Unexpected response id');
        if (reply.error) { const error = new Error(reply.error.message); error.code = reply.error.code; finish(error); }
        else finish(null, reply.result);
      } catch (error) { finish(error); }
    });
  });
}
export function readAsar(archive, rel) {
  const fd = fs.openSync(archive, 'r');
  try {
    const start = Buffer.alloc(16); fs.readSync(fd, start, 0, 16, 0);
    const header = Buffer.alloc(start.readUInt32LE(12)); fs.readSync(fd, header, 0, header.length, 16);
    let entry = JSON.parse(header).files;
    const pieces = rel.split('/');
    for (let i = 0; i < pieces.length; i++) { entry = entry[pieces[i]]; if (!entry) throw new Error('Missing ASAR entry: ' + rel); if (i < pieces.length - 1) entry = entry.files; }
    if (entry.unpacked) return fs.readFileSync(archive + '.unpacked/' + rel);
    const data = Buffer.alloc(Number(entry.size));
    fs.readSync(fd, data, 0, data.length, 8 + start.readUInt32LE(4) + Number(entry.offset));
    return data;
  } finally { fs.closeSync(fd); }
}
export function discoverRuntime(installDir) {
  if (!installDir) {
    for (const directory of (process.env.PATH || '').split(path.delimiter)) {
      if (fs.existsSync(path.join(directory, 'dsh.cmd'))) { installDir = path.resolve(directory, '../../../..'); break; }
    }
  }
  if (!installDir) throw new Error('DSH Desktop-installed dsh.cmd was not found on PATH');
  const executable = path.join(installDir, 'DeepSeek Harness.exe');
  const archive = path.join(installDir, 'resources/app.asar');
  const desktop = JSON.parse(readAsar(archive, 'package.json'));
  const compatibility = verifyRuntimeCompatibility(desktop, file => readAsar(archive, 'dsh/node_modules/' + file));
  if (!fs.existsSync(executable)) throw new Error('DSH executable not found');
  return { installDir, executable, cli: path.join(archive, 'dsh/node_modules/@deepseek-ai/dsh-desktop-host/lib/cli.js'), version: desktop.version, buildCommit: desktop.dshBuildCommit, compatibility };
}
