import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

test('portable and Codex compatibility manifests publish the same cache version', () => {
  const read = name => JSON.parse(fs.readFileSync(new URL('../' + name, import.meta.url), 'utf8'));
  const portable = read('plugin.json');
  const compatibility = read('.codex-plugin/plugin.json');
  assert.equal(compatibility.name, portable.name);
  assert.equal(compatibility.version, portable.version);
  assert.equal(read('package.json').version, portable.version);
});
