import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {fakeConfig,fakeBridgeState} from './fixtures.mjs';
import {loadBridge} from '../plugins/dsh-subagent/server/bridge.mjs';
const temporary=()=>fs.mkdtempSync(path.join(os.tmpdir(),'codex-dsh-adapter-test-'));
const remove=root=>{assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir())+path.sep)&&path.basename(root).startsWith('codex-dsh-adapter-test-'));fs.rmSync(root,{recursive:true,force:true})};
const calls=root=>fs.readFileSync(path.join(fakeBridgeState(root),'calls.jsonl'),'utf8').trim().split('\n').map(JSON.parse);

test('shared protocol mismatch errors are preserved and passive calls never request a Host launch',async()=>{
  const root=temporary();try{
    fakeConfig(root,{error:{code:'dsh/protocol',message:'restart DSH Desktop'}});const bridge=await loadBridge({state:fakeBridgeState(root)});
    await assert.rejects(bridge.call('desktop','doctor',{}, {start:true}),{code:'dsh/protocol'});
    await assert.rejects(bridge.call('desktop','events',{afterCursor:0}),{code:'dsh/protocol'});
    assert.deepEqual(calls(root).map(call=>call.options.start),[true,false]);
  }finally{remove(root)}
});
