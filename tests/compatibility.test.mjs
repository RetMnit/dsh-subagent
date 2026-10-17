import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { assertSupportedVersion, assertHostCapabilities, verifyRuntimeCompatibility } from '../companion/compatibility.mjs';

test('small releases pass the family gate while older, unrecognized and future adapter families are refused', () => {
  for (const version of ['0.2.1-rc.1', '0.2.1-rc.2', '0.2.1-rc.999', '0.2.1', '0.2.2-rc.1', '0.2.8']) assert.doesNotThrow(() => assertSupportedVersion(version));
  for (const version of ['0.2.0', '0.2.1-rc.0', '0.2.1-beta.1', '0.3.0', '1.0.0', 'invalid', undefined]) assert.throws(() => assertSupportedVersion(version), /Unsupported/);
});

test('an unknown build is accepted only with matching adapter code, not by version or method names alone', () => {
  const original = Buffer.from('tested controller implementation');
  const policy = { adapterRevision: 99, verifiedBuilds: {}, fingerprints: { 'controller.js': createHash('sha256').update(original).digest('hex') } };
  const runtime = { name: '@deepseek-ai/dsh-desktop', version: '0.2.2-rc.1', dshBuildCommit: 'new-unrelated-release' };
  const accepted = verifyRuntimeCompatibility(runtime, () => original, policy);
  assert.equal(accepted.status, 'matching-adapter-code'); assert.equal(accepted.checkedFiles, 1);
  assert.throws(() => verifyRuntimeCompatibility(runtime, () => Buffer.from('same methods; different resume behavior'), policy), /adapter code changed.*controller.js/);
  assert.throws(() => verifyRuntimeCompatibility(runtime, () => { throw new Error('missing'); }, policy), /adapter code changed/);
  assert.throws(() => verifyRuntimeCompatibility(runtime, () => original, { ...policy, fingerprints: {} }), /adapter code changed/);
  assert.throws(() => verifyRuntimeCompatibility({ ...runtime, version: '0.3.0' }, () => original, policy), /Unsupported/);
});

test('startup lists missing controller and resume capabilities before opening IPC or starting work', () => {
  assert.throws(() => assertHostCapabilities({ sessionController: { create() {}, prompt() {} } }), error => {
    assert.match(error.message, /sessionController.agents.resolveAgent/);
    assert.match(error.message, /sessions.flush/);
    assert.match(error.message, /connection.fetch.register/);
    return true;
  });
});
