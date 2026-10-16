import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {configurationStore} from '../server/configurations.mjs';
import {requestStore} from '../server/requests.mjs';

test('each Codex conversation has one saved configuration; edits apply automatically while retries keep their snapshots', () => {
  const state=fs.mkdtempSync(path.join(os.tmpdir(),'codex-dsh-configuration-test-'));
  try {
    let store=configurationStore(state,{workspace:state,permission:'danger-full-access'});
    assert.equal(store.read('chat-A').status,'missing');
    const entry=store.create({conversationId:'chat-A'});
    const params={conversationId:'chat-A',prompt:'fake task',requestId:'task-1',userAuthorized:true};
    assert.throws(()=>store.resolve({...params,userAuthorized:false}),/Explicit user permission/);
    assert.throws(()=>store.resolve(params),/Save this Codex conversation/);
    store.confirm('chat-A',entry.configurationId,{...entry.values,model:{provider:'fake',model:'chosen'}});
    const revision=store.read('chat-A').revision;
    const first=store.resolve(params),second=store.resolve({...params,requestId:'task-2',prompt:'another task'});
    assert.equal(first.configurationId,second.configurationId);assert.equal(first.sessionId,undefined);assert.notEqual(first.requestId,second.requestId);
    assert.equal(store.read('chat-A').revision,revision);assert.equal(store.create({conversationId:'chat-A'}).configurationId,entry.configurationId);
    assert.throws(()=>store.create({conversationId:'chat-A',createNew:true}),/without configuration overrides/);
    assert.throws(()=>store.resolve({...params,configurationId:entry.configurationId}),/omit configurationId/);
    assert.throws(()=>store.resolve({...params,model:{provider:'fake',model:'other'}}),/parameter form/);
    let requests=requestStore(state,store);const snapshot=requests.resolve(params);
    store.confirm('chat-A',entry.configurationId,{...entry.values,model:{provider:'fake',model:'changed'}});
    assert.equal(store.read('chat-A').revision,revision+1);assert.equal(requests.resolve(params).model.model,'chosen');
    assert.equal(requests.resolve({...params,requestId:'task-3'}).model.model,'changed');
    assert.throws(()=>requests.resolve({...params,prompt:'other'}),/different arguments/);
    store=configurationStore(state,{workspace:state,permission:'danger-full-access'});requests=requestStore(state,store);assert.deepEqual(requests.resolve(params),snapshot);
    const resume=store.resolve({...params,mode:'desktop',sessionId:'existing'},'resume');
    assert.equal(resume.sessionId,'existing');assert.equal(resume.configurationId,entry.configurationId);
    for(const key of ['workspace','preset','permission','model'])assert.equal(resume[key],undefined);
    const another={conversationId:'chat-B',prompt:'only resume',requestId:'first',userAuthorized:true,mode:'desktop',sessionId:'existing'};
    assert.equal(store.read('chat-B').status,'missing');assert.throws(()=>store.resolve(another,'resume'),/Save this Codex conversation/);
    const b=store.create({conversationId:'chat-B'});assert.notEqual(b.configurationId,entry.configurationId);
    assert.equal(b.values.model,undefined);assert.throws(()=>store.confirm('chat-B',entry.configurationId,b.values),/Unknown configuration/);
    store.confirm('chat-B',b.configurationId,b.values);assert.equal(store.resolve(another,'resume').sessionId,'existing');
    assert.throws(()=>store.confirm('chat-A',entry.configurationId,{...entry.values,sessionId:'extra'}),/Unknown configuration parameter/);
    assert.equal(Object.keys(JSON.parse(fs.readFileSync(path.join(state,'configurations.json'))).conversations).length,2);
  } finally {
    assert.ok(path.resolve(state).startsWith(path.resolve(os.tmpdir())+path.sep)&&path.basename(state).startsWith('codex-dsh-configuration-test-'));
    fs.rmSync(state,{recursive:true,force:true});
  }
});

test('legacy global configurations are backed up and preserved but never adopted by a new Codex conversation', () => {
  const state=fs.mkdtempSync(path.join(os.tmpdir(),'codex-dsh-configuration-test-'));
  try {
    const configurationId='old-config';const values={mode:'desktop',workspace:state,permission:'danger-full-access',open:true};
    const legacy={schemaVersion:2,defaultConfigurationId:configurationId,configurations:{[configurationId]:{configurationId,status:'ready',values}}};
    fs.writeFileSync(path.join(state,'configurations.json'),JSON.stringify(legacy));
    const store=configurationStore(state,{workspace:state,permission:'danger-full-access'});assert.equal(store.read('chat-A').status,'missing');
    assert.throws(()=>store.resolve({conversationId:'chat-A',prompt:'new task',requestId:'new-request',userAuthorized:true}),/Save this Codex conversation/);
    assert.equal(fs.readdirSync(path.join(state,'backups')).length,1);
    const saved=JSON.parse(fs.readFileSync(path.join(state,'configurations.json')));assert.equal(saved.schemaVersion,3);assert.deepEqual(saved.legacyConfigurations,legacy.configurations);
    const first=store.create({conversationId:'chat-A'});assert.equal(first.status,'draft');assert.notEqual(first.configurationId,configurationId);assert.equal(first.values.mode,'headless');
  } finally {
    assert.ok(path.resolve(state).startsWith(path.resolve(os.tmpdir())+path.sep)&&path.basename(state).startsWith('codex-dsh-configuration-test-'));
    fs.rmSync(state,{recursive:true,force:true});
  }
});
