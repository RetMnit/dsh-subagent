import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { enableBridgeBundle } from '../server/profiles.mjs';

test('installation enables a previously disabled bridge while preserving other profile selections and metadata', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-dsh-profile-test-'));
  try {
    const file = path.join(root, 'package.json');
    const original = { name: 'custom-profile', dependencies: { custom: 'link:somewhere' },
      dsh: { custom: true, profile: { extra: 'preserve', bundles: ['@deepseek-ai/dsh-base', 'custom-bundle'] } } };
    fs.writeFileSync(file, JSON.stringify(original));
    assert.equal(enableBridgeBundle(file), true);
    const updated = JSON.parse(fs.readFileSync(file));
    assert.deepEqual(updated, { ...original, dsh: { ...original.dsh, profile: { ...original.dsh.profile,
      bundles: [...original.dsh.profile.bundles, '@local/codex-dsh-bridge'] } } });
    const saved = fs.readFileSync(file, 'utf8');
    assert.equal(enableBridgeBundle(file), false); assert.equal(fs.readFileSync(file, 'utf8'), saved);
    fs.writeFileSync(file, JSON.stringify({ dsh: { profile: { bundles: 'invalid' } } }));
    assert.throws(() => enableBridgeBundle(file), /must be an array/);
    assert.equal(JSON.parse(fs.readFileSync(file)).dsh.profile.bundles, 'invalid');
  } finally {
    assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep) && path.basename(root).startsWith('codex-dsh-profile-test-'));
    fs.rmSync(root, { recursive: true, force: true });
  }
});
