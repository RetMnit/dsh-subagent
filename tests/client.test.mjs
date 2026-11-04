import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {fakeConfig,fakeBridgeState} from './fixtures.mjs';
import {loadBridge} from '../server/bridge.mjs';
const temporary=()=>fs.mkdtempSync(path.join(os.tmpdir(),'codex-dsh-adapter-test-'));
const remove=root=>{assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir())+path.sep)&&path.basename(root).startsWith('codex-dsh-adapter-test-'));fs.rmSync(root,{recursive:true,force:true})};
const calls=root=>fs.readFileSync(path.join(fakeBridgeState(root),'calls.jsonl'),'utf8').trim().split('\n').map(JSON.parse);

test('installed shared client loads from a root with spaces; defaults, doctor and focus delegate without starting Hosts',async()=>{
  const root=temporary();try{
    const cfg=fakeConfig(root);const bridge=await loadBridge({state:fakeBridgeState(root)});
    assert.deepEqual(bridge.defaults,cfg.defaults);assert.equal(bridge.runtime().version,'fake-runtime');
    const info=await bridge.doctor();assert.equal(info.modes.desktop.protocolVersion,2);bridge.focusDesktop();
    assert.ok(calls(root).filter(call=>call.method==='doctor').every(call=>call.options.start===false));
    assert.equal(calls(root).at(-1).method,'focusDesktop');
  }finally{remove(root)}
});
test('offline doctor preserves shared startup failure details without requesting a Host launch',async()=>{
  const root=temporary();try{
    const failure={code:'dsh/compatibility',message:'shared bundle rejected this build',details:{mode:'desktop'}};
    fakeConfig(root,{error:{code:'ENOENT',message:'pipe offline'},startupFailures:{desktop:failure}});
    const bridge=await loadBridge({state:fakeBridgeState(root)});
    const info=await bridge.doctor();
    assert.deepEqual(info.modes.desktop,{connected:false,error:'ENOENT',startupFailure:failure});
    assert.deepEqual(info.modes.headless,{connected:false,error:'ENOENT'});
    assert.equal(calls(root).length,2);assert.ok(calls(root).every(call=>call.options.start===false));
  }finally{remove(root)}
});

test('missing or malformed install receipts fail with actionable errors before starting anything',async()=>{
  const root=temporary();try{
    await assert.rejects(loadBridge({state:root}),/Install Common/);
    fs.writeFileSync(path.join(root,'install.json'),JSON.stringify({root:'relative'}));
    await assert.rejects(loadBridge({state:root}),/Invalid dsh-bridge/);
  }finally{remove(root)}
});
