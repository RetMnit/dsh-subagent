import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { ROOT, STATE, atomic, discoverRuntime, readJson } from './common.mjs';

const runtime = discoverRuntime(process.env.DSH_INSTALL_DIR);
const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
const companionDir = path.join(home, 'bundles', 'codex-dsh-bridge');
const companion = companionDir.replaceAll('\\', '/');
const identity = createHash('sha256').update(os.userInfo().username + ':' + home).digest('hex').slice(0, 16);
fs.mkdirSync(STATE, { recursive: true });
if (process.platform === 'win32' && !process.env.CODEX_DSH_STATE_DIR) {
  const protectedState = spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(ROOT, 'server/protect-state.ps1')], { windowsHide: true, stdio: 'pipe' });
  if (protectedState.status !== 0) throw new Error('Could not protect the bridge state directory');
}
const settingsPath = path.join(STATE, 'config.json');
const old = fs.existsSync(settingsPath) ? readJson(settingsPath) : {};
const workspace = path.resolve(process.env.CODEX_DSH_WORKSPACE || old.defaults?.workspace || path.join(os.homedir(), 'DSH-Workspace'));
fs.mkdirSync(workspace, {recursive: true});
const settings = { ...old, protocolVersion: 1, runtime, home, workerProfile: 'codex-worker', sourceRoot: ROOT,
  token: old.token || randomBytes(32).toString('hex'),
  pipes: { desktop: '\\\\.\\pipe\\codex-dsh-' + identity + '-desktop', headless: '\\\\.\\pipe\\codex-dsh-' + identity + '-headless' },
  defaults: { permission: 'danger-full-access', ...old.defaults, workspace },
};
atomic(settingsPath, settings);
if (!process.argv.includes('--install-dsh')) { console.log(JSON.stringify({ configured: true, stateDir: STATE, version: runtime.version })); process.exit(0); }
fs.cpSync(path.join(ROOT, 'companion'), companionDir, {recursive: true});
const stamp = new Date().toISOString().replaceAll(/[:.]/g, '-');
const backup = path.join(STATE, 'backups', stamp);
for (const profile of ['desktop', settings.workerProfile]) {
  for (const file of ['package.json', 'cordis.patch.yml', 'cordis.yml', 'pnpm-lock.yaml', 'pnpm-workspace.yaml']) {
    const from = path.join(home, 'profiles', profile, file);
    if (fs.existsSync(from)) { const to = path.join(backup, profile, file); fs.mkdirSync(path.dirname(to), { recursive: true }); fs.copyFileSync(from, to); }
  }
}
const workerDir = path.join(home, 'profiles', settings.workerProfile);
if (!fs.existsSync(path.join(workerDir, 'package.json'))) {
  fs.mkdirSync(workerDir, { recursive: true });
  const desktopProfile = readJson(path.join(home, 'profiles/desktop/package.json'));
  atomic(path.join(workerDir, 'package.json'), { name: 'dsh-profile-codex-worker', private: true,
    dependencies: { ...desktopProfile.dependencies, '@local/codex-dsh-bridge': 'link:' + companion },
    dsh: { profile: { bundles: [...new Set([...desktopProfile.dsh.profile.bundles, '@local/codex-dsh-bridge'])] } } });
  const quote = value => JSON.stringify(value.replaceAll('\\', '/'));
  fs.writeFileSync(path.join(workerDir, 'cordis.patch.yml'), [
    '- id: web-runtime', '  config:', '    openBrowser: false', '    printUrl: false', '    surfaceContext: false', '    trustedHosts: []',
    '- id: hmr', '  disabled: true', '- id: session-title-llm', '  disabled: true',
    '- id: session-log-deepseek', '  disabled: true', '- id: session-persistence-jsonl', '  config:', '    root: ' + quote(path.join(STATE, 'sessions')),
    '- id: storage-json', '  config:', '    root: ' + quote(path.join(STATE, 'storages')),
    '- id: permission', '  config:', '    presets:', '      read-only:', '        sandbox: read-only', '        approval: ask',
    '      workspace-write:', '        sandbox: workspace-write', '        approval: ask', '      danger-full-access:',
    '        sandbox: danger-full-access', '        approval: never', '    defaultPreset: danger-full-access', '',
  ].join('\n'));
}
const invoke = args => {
  const result = spawnSync(runtime.executable, ['--expose-internals', runtime.cli, ...args], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', CODEX_DSH_STATE_DIR: STATE }, windowsHide: true, shell: false, stdio: 'inherit', timeout: 120000,
  });
  if (result.error || result.status !== 0) throw result.error || new Error('DSH plugin command exited ' + result.status);
};
invoke(['plugin', '--profile', 'desktop', 'add', 'link:' + companion, '--ignore-scripts']);
invoke(['plugin', '--profile', settings.workerProfile, 'add', 'link:' + companion, '--ignore-scripts']);
console.log(JSON.stringify({ installed: true, backup, stateDir: STATE, workerProfile: settings.workerProfile, version: runtime.version }));
