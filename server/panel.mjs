import fs from 'node:fs';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {EventEmitter} from 'node:events';

export async function launchStatusWindow(url, state) {
  const candidates = [process.env['ProgramFiles(x86)'], process.env.ProgramFiles, process.env.LOCALAPPDATA]
    .filter(Boolean).map(root => path.join(root, 'Microsoft/Edge/Application/msedge.exe'));
  const executable = candidates.find(file => fs.existsSync(file));
  if (!executable) throw new Error('Microsoft Edge is required to display the automatic task window');
  const view = new URL(url); view.searchParams.set('panelWindow', '1');
  const child = spawn(executable, ['--app=' + view.href, '--user-data-dir=' + path.join(state, 'status-window-profile'), '--no-first-run', '--no-default-browser-check', '--disable-background-mode'], {
    detached: true, windowsHide: false, shell: false, stdio: 'ignore',
  });
  await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
  child.unref();
  return {pid: child.pid};
}

export function statusPanel({url, state, launch = launchStatusWindow, clock = Date.now, timeoutMs = 15000}) {
  const clients = new Map(); const changes = new EventEmitter(); changes.setMaxListeners(100);
  let pending; let launches = 0; let lastError;
  const live = () => [...clients.values()].filter(client => clock() - client.seenAt < 6500);
  const visible = () => live().some(client => client.visible);
  const changed = ms => new Promise(resolve => {
    const done = () => {clearTimeout(timer); changes.off('change', done); resolve()};
    const timer = setTimeout(done, ms); changes.once('change', done);
  });
  return {
    heartbeat(params) {
      if (typeof params.clientId !== 'string' || params.clientId.length > 100 || !Array.isArray(params.jobs)) throw new Error('Invalid panel receipt');
      if (params.closed) clients.delete(params.clientId);
      else clients.set(params.clientId, {seenAt: clock(), visible: params.visible === true, windowMode: params.windowMode === true, jobs: params.jobs.slice(0, 500).map(job => ({jobId: job.jobId, status: job.status, hasResult: job.hasResult === true}))});
      changes.emit('change'); return {accepted: true};
    },
    status() {return {connected: live().length > 0, visible: visible(), launches, lastError, renderedJobs: live().flatMap(client => client.jobs)}},
    async ensure() {
      if (visible() || live().some(client => client.windowMode)) return this.status();
      if (!pending) pending = (async () => {
        launches++; await launch(url(), state);
        const deadline = clock() + timeoutMs;
        while (!visible() && clock() < deadline) await changed(Math.min(500, deadline - clock()));
        if (!visible()) throw new Error('The status window opened but did not acknowledge rendering; no task was started');
        lastError = undefined; return this.status();
      })().catch(error => {lastError = error.message; throw error}).finally(() => {pending = undefined});
      return pending;
    },
    async rendered(jobIds, timeout = 4000) {
      const deadline = clock() + timeout;
      const has = () => jobIds.every(id => live().some(client => client.jobs.some(job => job.jobId === id)));
      while (!has() && clock() < deadline) await changed(Math.min(300, deadline - clock()));
      return {...this.status(), jobsRendered: has()};
    },
  };
}
