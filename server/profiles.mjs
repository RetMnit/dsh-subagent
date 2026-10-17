import { atomic, readJson } from './common.mjs';

// The DSH plugin CLI forwards to pnpm; dependency installation alone does not
// select the bundle. Upgrades can leave it installed but disabled.
export function enableBridgeBundle(manifestPath) {
  const manifest = readJson(manifestPath);
  const bundles = manifest.dsh?.profile?.bundles ?? [];
  if (!Array.isArray(bundles)) throw new Error('DSH profile bundles must be an array: ' + manifestPath);
  if (bundles.includes('@local/codex-dsh-bridge')) return false;
  manifest.dsh = { ...manifest.dsh, profile: { ...manifest.dsh?.profile, bundles: [...bundles, '@local/codex-dsh-bridge'] } };
  atomic(manifestPath, manifest);
  return true;
}
