import fs from 'node:fs';
import path from 'node:path';
import {spawn, execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createHash} from 'node:crypto';
import {EventEmitter} from 'node:events';

const run = promisify(execFile);
const argument = (command, name) => {
  const match = command?.match(new RegExp('(?:^|\\s)(?:"--' + name + '=([^"\\r\\n]+)"|--' + name + '="([^"\\r\\n]+)"|--' + name + '=([^\\s"\\r\\n]+))'));
  return match?.[1] ?? match?.[2] ?? match?.[3];
};
export function panelScope(value) {
  const url = new URL(value);
  const id = url.searchParams.get('conversationId');
  if (!id) throw new Error('Status window requires a Codex conversation ID');
  return {id, origin: url.origin};
}
export function panelProfile(url, state) {
  return path.join(state, 'status-window-profiles', createHash('sha256').update(panelScope(url).id).digest('hex').slice(0, 24));
}

export function matchStatusWindows(processes, url, state) {
  const scope = panelScope(url);
  const profiles = [panelProfile(url, state), path.join(state, 'status-window-profile')].map(value => path.resolve(value).toLowerCase());
  const matches = [];
  for (const item of processes) {
    try {
      const app = new URL(argument(item.commandLine, 'app'));
      const profile = argument(item.commandLine, 'user-data-dir');
      if (!profile || !profiles.includes(path.resolve(profile).toLowerCase()) || app.searchParams.get('conversationId') !== scope.id || app.searchParams.get('panelWindow') !== '1') continue;
      matches.push({pid: item.pid, originMatches: app.origin === scope.origin, hasWindow: item.hasWindow === true});
    } catch {}
  }
  return {exists: matches.length > 0, originMatches: matches.every(item => item.originMatches),
    windowConfirmed: matches.some(item => item.hasWindow), processCount: matches.length};
}

export async function findStatusWindow(url, state) {
  if (process.platform !== 'win32') throw new Error('Status window ownership checks require Windows');
  // Read only. No titles, URLs, tokens or unrelated process command lines are logged.
  const script = "$ErrorActionPreference='Stop'; [Console]::OutputEncoding=[Text.UTF8Encoding]::new($false); $items=@(Get-CimInstance Win32_Process -Filter \"Name='msedge.exe'\" | Where-Object { $_.CommandLine -like '*--app=*' -and $_.CommandLine.Contains($env:CODEX_DSH_PANEL_STATE) } | ForEach-Object { $p=Get-Process -Id $_.ProcessId -ErrorAction SilentlyContinue; [pscustomobject]@{pid=$_.ProcessId;commandLine=$_.CommandLine;hasWindow=($null -ne $p -and $p.MainWindowHandle -ne 0)} }); ConvertTo-Json -InputObject $items -Compress";
  const {stdout} = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
    windowsHide: true, timeout: 10000, maxBuffer: 1024 * 1024,
    env: {...process.env, CODEX_DSH_PANEL_STATE: state},
  });
  return matchStatusWindows(JSON.parse(stdout.replace(/^\uFEFF/, '') || '[]'), url, state);
}

export async function launchStatusWindow(url, state) {
  const candidates = [process.env['ProgramFiles(x86)'], process.env.ProgramFiles, process.env.LOCALAPPDATA]
    .filter(Boolean).map(root => path.join(root, 'Microsoft/Edge/Application/msedge.exe'));
  const executable = candidates.find(file => fs.existsSync(file));
  if (!executable) throw new Error('Microsoft Edge is required to display the automatic task window');
  const view = new URL(url); view.searchParams.set('panelWindow', '1');
  const child = spawn(executable, ['--app=' + view.href, '--user-data-dir=' + panelProfile(url, state), '--no-first-run', '--no-default-browser-check', '--disable-background-mode'], {
    detached: true, windowsHide: false, shell: false, stdio: 'ignore',
  });
  await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
  child.unref();
  return {pid: child.pid};
}

export function statusPanel({url, state, launch = launchStatusWindow, findWindow = findStatusWindow, clock = Date.now, timeoutMs = 15000}) {
  const clients = new Map(); const changes = new EventEmitter(); changes.setMaxListeners(100);
  let pending; let launches = 0; let reuses = 0; let lastError;
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
    status() {return {connected: live().length > 0, visible: visible(), launches, reuses, lastError, renderedJobs: live().flatMap(client => client.jobs)}},
    async ensure() {
      if (visible() || live().some(client => client.windowMode)) return this.status();
      if (!pending) pending = (async () => {
        const existing = await findWindow(url(), state);
        if (existing.exists) {
          reuses++;
          if (!existing.originMatches) throw new Error('The existing status window belongs to an old service address. Close that window and reopen it; no duplicate window was opened and no task was started');
        } else {
          launches++; await launch(url(), state);
        }
        const deadline = clock() + timeoutMs;
        const acknowledged = () => visible() || live().some(client => client.windowMode);
        while (!acknowledged() && clock() < deadline) await changed(Math.min(500, deadline - clock()));
        if (!acknowledged()) throw new Error(existing.exists
          ? 'The existing status window is not responding. Restore or close it and retry; no duplicate window was opened and no task was started'
          : 'The status window opened but did not acknowledge rendering; no task was started');
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
