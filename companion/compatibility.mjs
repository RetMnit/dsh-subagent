import fs from 'node:fs';
import { createHash } from 'node:crypto';

export const compatibilityPolicy = JSON.parse(fs.readFileSync(new URL('./compatibility.json', import.meta.url), 'utf8'));

export function assertSupportedVersion(version) {
  // Current adapter covers 0.2.1 rc.1 onward within 0.2.x. Later major/minor
  // versions need a new adapter; prerelease rc numbers are not exact pins.
  const match = typeof version === 'string' && /^0\.2\.(\d+)(?:-rc\.(\d+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(version);
  if (!match || Number(match[1]) < 1 || (match[2] !== undefined && Number(match[2]) < 1)) {
    throw new Error('Unsupported DSH installation: ' + version + '; adapter supports ' + compatibilityPolicy.range);
  }
}

export function verifyRuntimeCompatibility(desktop, readFile, policy = compatibilityPolicy) {
  if (desktop.name !== '@deepseek-ai/dsh-desktop') throw new Error('Unsupported DSH installation: ' + desktop.name);
  assertSupportedVersion(desktop.version);
  if (policy.verifiedBuilds[desktop.version] && policy.verifiedBuilds[desktop.version] === desktop.dshBuildCommit) {
    return { status: 'verified-build', adapterRevision: policy.adapterRevision };
  }
  // A new release may be unrelated to our adapter. Accept it only when the
  // selected controller, agent/session, preset, model and navigation code is
  // byte-for-byte identical to the tested implementation.
  const mismatches = [];
  for (const [file, expected] of Object.entries(policy.fingerprints)) {
    try { if (createHash('sha256').update(readFile(file)).digest('hex') !== expected) mismatches.push(file); }
    catch { mismatches.push(file); }
  }
  if (!Object.keys(policy.fingerprints).length || mismatches.length) {
    throw new Error('DSH adapter code changed; run isolated acceptance and update the compatibility adapter before dispatch: ' + mismatches.join(', '));
  }
  return { status: 'matching-adapter-code', adapterRevision: policy.adapterRevision, checkedFiles: Object.keys(policy.fingerprints).length };
}

export function assertHostCapabilities(ctx) {
  const required = {
    '': ['effect', 'on', 'get'],
    agents: ['get', 'list'], sessions: ['flush'], sessionQuery: ['observeSession'], sessionProjections: ['onChanged'],
    sessionController: ['create', 'prompt', 'cancel', 'rename', 'list', 'modelCatalog'],
    'sessionController.agents': ['selectionFor', 'selectForNextRequest', 'resolveAgent'],
    agentPresets: ['resolve', 'composedPreset', 'serviceFor', 'remoteExportList'],
    permissionPresets: ['current', 'set', 'catalog'], workspaceRegistry: ['create', 'list'],
    llm: ['resolveCallConfig'], 'connection.fetch': ['register'],
  };
  const missing = [];
  for (const [service, methods] of Object.entries(required)) {
    const target = service ? service.split('.').reduce((value, key) => value?.[key], ctx) : ctx;
    for (const method of methods) if (typeof target?.[method] !== 'function') missing.push((service ? service + '.' : '') + method);
  }
  if (missing.length) throw new Error('Missing DSH adapter capabilities: ' + missing.join(', '));
}
