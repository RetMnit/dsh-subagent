import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { ROOT, STATE, config, readJson } from './common.mjs';

export async function connectSupervisor() {
  const cfg = config();
  const infoFile = path.join(STATE, 'supervisor.json');
  const tryInfo = async () => {
    try {
      const info = readJson(infoFile);
      const response = await fetch(info.url + '/health', { headers: { authorization: 'Bearer ' + cfg.token }, signal: AbortSignal.timeout(1500) });
      if (response.ok) { const health = await response.json(); if (health.instanceId === info.instanceId) return info; }
    } catch {}
  };
  let info = await tryInfo();
  if (!info) {
    const logDir = path.join(STATE, 'logs'); fs.mkdirSync(logDir, { recursive: true });
    const log = fs.openSync(path.join(logDir, 'supervisor.log'), 'a');
    const child = spawn(process.execPath, [path.join(ROOT, 'server/supervisor.mjs')], { detached: true, windowsHide: true, shell: false,
      env: { ...process.env, CODEX_DSH_STATE_DIR: STATE }, stdio: ['ignore', log, log] });
    child.unref(); fs.closeSync(log);
    for (let i = 0; i < 50 && !info; i++) { await new Promise(resolve => setTimeout(resolve, 100)); info = await tryInfo(); }
  }
  if (!info) throw new Error('Could not start the local DSH supervisor; inspect its log');
  return { ...info, token: cfg.token };
}
export async function api(method, params = {}) {
  if (['doctor','configure','configuration','saveConfiguration','start','start_many','resume','list','status','result','wait','cancel','open'].includes(method) && !params.conversationId) {
    const id=process.env.CODEX_THREAD_ID || process.env.CODEX_SESSION_ID;
    if(id)params={...params,conversationId:id};
  }
  const info = await connectSupervisor();
  const response = await fetch(info.url + '/api', { method: 'POST', headers: { authorization: 'Bearer ' + info.token, 'content-type': 'application/json' },
    body: JSON.stringify({ method, params }), signal: AbortSignal.timeout(method === 'wait' ? 55000 : 80000) });
  const reply = await response.json();
  if (reply.error) { const error = new Error(reply.error.message); error.code = reply.error.code; throw error; }
  return reply.result;
}
