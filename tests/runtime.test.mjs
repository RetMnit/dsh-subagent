import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fakeConfig } from './fixtures.mjs';
import { discoverRuntime } from '../server/common.mjs';

test('runtime accepts the validated 0.2.1 build and refuses changed builds, versions and carriers', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-dsh-runtime-test-'));
  try {
    const config = fakeConfig(root);
    const runtime = discoverRuntime(config.runtime.installDir);
    assert.equal(runtime.version, '0.2.1-rc.1');
    assert.equal(runtime.buildCommit, 'ed75efeffee65f9fe93625bbd76a68cb219aaaf9');
    fakeConfig(root, { dshBuildCommit: 'unvalidated' });
    assert.throws(() => discoverRuntime(config.runtime.installDir), /build changed/);
    fakeConfig(root, { version: '0.2.2' });
    assert.throws(() => discoverRuntime(config.runtime.installDir), /Unsupported DSH installation/);
    fakeConfig(root, { name: 'another-app' });
    assert.throws(() => discoverRuntime(config.runtime.installDir), /Unsupported DSH installation/);
  } finally {
    assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep) && path.basename(root).startsWith('codex-dsh-runtime-test-'));
    fs.rmSync(root, { recursive: true, force: true });
  }
});
