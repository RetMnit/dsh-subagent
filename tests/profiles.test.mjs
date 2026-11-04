import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

test('removed installer flag is rejected before loading any bridge or changing a DSH profile',()=>{
  const result=spawnSync(process.execPath,[fileURLToPath(new URL('../server/setup.mjs',import.meta.url)),'--install-dsh'],{encoding:'utf8',windowsHide:true});
  assert.notEqual(result.status,0);assert.match(result.stderr,/install Common\/dsh-bridge separately/);
});
