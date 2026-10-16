import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

test('Desktop navigation retries a cold UI before acknowledging the correct revision', async () => {
  let plugin;let attempts=0;let acknowledged;let dispose;let settle;
  const done=new Promise(resolve=>{settle=resolve});
  const context={window:{location:{href:'http://127.0.0.1:19387/'},__ModuleLoader__:{load:entry=>{plugin=entry.factory()}}},URL,AbortController,
    console:{warn(){}},setTimeout,
    fetch:async(input,options)=>{
      if(options.method==='POST'){acknowledged=JSON.parse(options.body);settle();return{ok:true}}
      const after=Number(new URL(input).searchParams.get('after'));
      if(after>=7)return new Promise((resolve,reject)=>options.signal.addEventListener('abort',()=>reject(new Error('aborted')),{once:true}));
      return{ok:true,json:async()=>({revision:7,sessionId:'cold-session'})};
    }};
  vm.runInNewContext(fs.readFileSync(new URL('../companion/client.js',import.meta.url),'utf8'),context);
  plugin.apply({uiWorkspace:{openSession(id){assert.equal(id,'cold-session');attempts++;if(attempts===1)throw new Error('UI catalog is not ready')}},effect(fn){dispose=fn()}});
  await Promise.race([done,new Promise((_,reject)=>setTimeout(()=>reject(new Error('client retry timed out')),3000))]);
  assert.equal(attempts,2);assert.equal(acknowledged.revision,7);assert.equal(acknowledged.sessionId,'cold-session');dispose();
});
