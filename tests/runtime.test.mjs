import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fakeConfig } from './fixtures.mjs';
import { discoverRuntime } from '../server/common.mjs';

test('runtime accepts validated builds and refuses unverified changed code, unsupported versions and carriers', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-dsh-runtime-test-'));
  try {
    const config = fakeConfig(root);
    const runtime = discoverRuntime(config.runtime.installDir);
    assert.equal(runtime.version, '0.2.1-rc.1');
    assert.equal(runtime.buildCommit, 'ed75efeffee65f9fe93625bbd76a68cb219aaaf9');
    assert.equal(runtime.compatibility.status, 'verified-build');
    fakeConfig(root, { version: '0.2.1-rc.2', dshBuildCommit: '332895e0f7c9d4dbfb29729f5eb367fa263ff986' });
    assert.equal(discoverRuntime(config.runtime.installDir).version, '0.2.1-rc.2');
    fakeConfig(root, { dshBuildCommit: 'unvalidated' });
    assert.throws(() => discoverRuntime(config.runtime.installDir), /adapter code changed/);
    fakeConfig(root, { version: '0.3.0' });
    assert.throws(() => discoverRuntime(config.runtime.installDir), /Unsupported DSH installation/);
    fakeConfig(root, { name: 'another-app' });
    assert.throws(() => discoverRuntime(config.runtime.installDir), /Unsupported DSH installation/);
  } finally {
    assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep) && path.basename(root).startsWith('codex-dsh-runtime-test-'));
    fs.rmSync(root, { recursive: true, force: true });
  }
});
