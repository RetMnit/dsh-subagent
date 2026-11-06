import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {fakeConfig,fakeBridgeState} from './fixtures.mjs';
import {loadBridge} from '../plugins/dsh-subagent/server/bridge.mjs';
import {spawnSync} from 'node:child_process';
const temporary=()=>fs.mkdtempSync(path.join(os.tmpdir(),'codex-dsh-adapter-test-'));
const remove=root=>{assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir())+path.sep)&&path.basename(root).startsWith('codex-dsh-adapter-test-'));fs.rmSync(root,{recursive:true,force:true})};
const calls=root=>fs.readFileSync(path.join(fakeBridgeState(root),'calls.jsonl'),'utf8').trim().split('\n').map(JSON.parse);

test('runtime validation and launch requests delegate to the shared client and propagate its failures',async()=>{
  const root=temporary();try{
    fakeConfig(root,{runtimeError:'shared runtime rejected'});const bridge=await loadBridge({state:fakeBridgeState(root)});
    assert.throws(()=>bridge.runtime(),/shared runtime rejected/);
    await assert.rejects(bridge.call('desktop','doctor',{}, {start:true}),/shared runtime rejected/);
    assert.equal(fs.existsSync(path.join(fakeBridgeState(root),'calls.jsonl')),false);
  }finally{remove(root)}
});

test('default Codex state and supervisor lock use the user home across different AppData hosts',()=>{
  const root=temporary();try{
    const script='import {STATE,supervisorLock} from '+JSON.stringify(new URL('../plugins/dsh-subagent/server/common.mjs',import.meta.url).href)+'; console.log(JSON.stringify({STATE,supervisorLock}));';
    const states=['terminal AppData','MSIX private AppData'].map(host=>{
      const env={...process.env,USERPROFILE:root,HOME:root,LOCALAPPDATA:path.join(root,host)};delete env.CODEX_DSH_STATE_DIR;
      const result=spawnSync(process.execPath,['--input-type=module','-e',script],{env,encoding:'utf8',windowsHide:true});
      assert.equal(result.status,0,result.stderr);return JSON.parse(result.stdout);
    });
    assert.equal(states[0].STATE,path.join(root,'.codex','dsh-subagent'));
    assert.deepEqual(states[1],states[0]);assert.ok(!states[0].supervisorLock.includes('CodexDSHBridge'));
  }finally{remove(root)}
});

test('default shared receipt loads from the user home across different AppData hosts',()=>{
  const root=temporary();try{
    const cfg=fakeConfig(root);
    fs.renameSync(fakeBridgeState(root),path.join(root,'.dsh-bridge'));
    const script='import {loadBridge} from '+JSON.stringify(new URL('../plugins/dsh-subagent/server/bridge.mjs',import.meta.url).href)+'; const bridge=await loadBridge();console.log(JSON.stringify({defaults:bridge.defaults,runtime:bridge.runtime()}));';
    for(const host of ['terminal AppData','MSIX private AppData']){
      const env={...process.env,USERPROFILE:root,HOME:root,LOCALAPPDATA:path.join(root,host)};delete env.DSH_BRIDGE_STATE_DIR;
      const result=spawnSync(process.execPath,['--input-type=module','-e',script],{env,encoding:'utf8',windowsHide:true});
      assert.equal(result.status,0,result.stderr);const info=JSON.parse(result.stdout);
      assert.deepEqual(info.defaults,cfg.defaults);assert.equal(info.runtime.version,'fake-runtime');
    }
    assert.equal(fs.existsSync(path.join(root,'.dsh-bridge','calls.jsonl')),false);
  }finally{remove(root)}
});

test('state environment overrides take precedence over both user-home defaults',()=>{
  const root=temporary();try{
    const cfg=fakeConfig(root),state=path.join(root,'custom plugin state');
    const env={...process.env,USERPROFILE:path.join(root,'empty home'),HOME:path.join(root,'empty home'),LOCALAPPDATA:path.join(root,'unused AppData'),CODEX_DSH_STATE_DIR:state,DSH_BRIDGE_STATE_DIR:fakeBridgeState(root)};
    const script='import {STATE} from '+JSON.stringify(new URL('../plugins/dsh-subagent/server/common.mjs',import.meta.url).href)+';import {loadBridge} from '+JSON.stringify(new URL('../plugins/dsh-subagent/server/bridge.mjs',import.meta.url).href)+';const bridge=await loadBridge();console.log(JSON.stringify({STATE,defaults:bridge.defaults,runtime:bridge.runtime()}));';
    const result=spawnSync(process.execPath,['--input-type=module','-e',script],{env,encoding:'utf8',windowsHide:true});
    assert.equal(result.status,0,result.stderr);const info=JSON.parse(result.stdout);
    assert.equal(info.STATE,state);assert.deepEqual(info.defaults,cfg.defaults);assert.equal(info.runtime.version,'fake-runtime');
  }finally{remove(root)}
});
