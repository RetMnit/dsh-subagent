import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {fakeConfig} from './fixtures.mjs';

test('new-machine setup accepts a custom workspace and preserves it and its token on later setup',()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'codex-dsh-setup-test-'));
  try{
    const config=fakeConfig(root);const state=path.join(root,'state'),workspace=path.join(root,'workspace');
    const env={...process.env,DSH_INSTALL_DIR:config.runtime.installDir,DSH_HOME:path.join(root,'dsh'),CODEX_DSH_STATE_DIR:state,CODEX_DSH_WORKSPACE:workspace};
    const run=()=>{const result=spawnSync(process.execPath,[fileURLToPath(new URL('../server/setup.mjs',import.meta.url))],{env,windowsHide:true,encoding:'utf8'});assert.equal(result.status,0,result.stderr);return JSON.parse(fs.readFileSync(path.join(state,'config.json')))};
    const first=run();assert.equal(first.defaults.workspace,workspace);assert.ok(fs.statSync(workspace).isDirectory());
    delete env.CODEX_DSH_WORKSPACE;const again=run();assert.equal(again.defaults.workspace,workspace);assert.equal(again.token,first.token);
  }finally{
    assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir())+path.sep)&&path.basename(root).startsWith('codex-dsh-setup-test-'));fs.rmSync(root,{recursive:true,force:true});
  }
});
