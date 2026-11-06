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

test('all task methods force client codex, configuration metadata is nested, and local controls never cross the boundary',async()=>{
  const root=temporary();try{
    fakeConfig(root);const bridge=await loadBridge({state:fakeBridgeState(root)});
    for(const method of ['start','prepare','list','status','events','cancel','open'])await bridge.call('headless',method,{client:'agent-hub',conversationId:'chat-A',configurationId:'configuration-A',configurationRevision:2,userAuthorized:true,requestId:'request',prompt:'fake',jobId:'job-a',sessionId:'session',afterCursor:5,instanceId:'host',timeoutMs:10});
    for(const call of calls(root)){
      assert.equal(call.params.client,'codex');assert.equal(call.options.start,false);
      for(const key of ['configurationId','configurationRevision','conversationId','userAuthorized'])assert.equal(call.params[key],undefined);
      if(['start','prepare'].includes(call.method))assert.deepEqual(call.params.meta,{conversationId:'chat-A',configurationId:'configuration-A',configurationRevision:2});
    }
    assert.equal(calls(root).find(call=>call.method==='prepare').params.prompt,undefined);
    assert.throws(()=>bridge.call('headless','shutdown'),/Unsupported/);
  }finally{remove(root)}
});
