import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {atomic, readJson} from './common.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
const digest = value => /^[a-f0-9]{64}$/.test(value) ? value : hash(value);
export function requestStore(state, configurations) {
  const file = path.join(state, 'dispatch-requests.json');
  const entries = fs.existsSync(file) ? readJson(file) : {};
  const owners=new Map(Object.values(entries).filter(entry=>entry.selected?.conversationId).map(entry=>[entry.selected.requestId,entry.selected.conversationId]));
  const targets=new Map(Object.values(entries).filter(entry=>entry.selected?.sessionId).map(({selected})=>[selected.requestId,{mode:selected.mode,sessionId:selected.sessionId}]));
  return {
    conversationOf(requestId){return owners.get(requestId)},
    targetOf(requestId){return targets.get(requestId)},
    resolve(params, operation = 'start') {
      if (params.userAuthorized !== true) throw new Error('Explicit user permission to use DSH is required');
      if (typeof params.requestId !== 'string' || !params.requestId.trim()) throw new Error('A unique requestId is required for each task');
      const scope=params.conversationId;
      const key=scope?JSON.stringify([scope,params.requestId]):params.requestId;
      configurations.requireReady?.(params);
      const signature=hash(JSON.stringify([operation,params.configurationId??null,params.prompt,params.title??null,...(operation==='resume'?[params.mode,params.sessionId]:[])]));
      const prior=Object.hasOwn(entries,key)?entries[key]:null;
      if(prior){
        if(prior.expired)throw new Error('This request was already cleaned; it will not be executed again');
        const previousSignature=digest(prior.signature);
        if(previousSignature!==signature)throw new Error('requestId already belongs to different arguments');
        return structuredClone(prior.selected);
      }
      if(scope&&Object.hasOwn(entries,params.requestId))throw new Error('This legacy requestId is already used; inspect existing results instead of replaying it');
      const selected={...configurations.resolve(params,operation),...(scope?{conversationId:scope,requestId:scope+':'+params.requestId}:{})};
      if(scope)owners.set(selected.requestId,scope);
      if(selected.sessionId)targets.set(selected.requestId,{mode:selected.mode,sessionId:selected.sessionId});
      entries[key]={signature,selected};atomic(file,entries);return structuredClone(selected);
    },
    forget(requestId){
      let changed=false;
      for(const [key,entry]of Object.entries(entries))if(entry.selected?.requestId===requestId){entries[key]={signature:digest(entry.signature),expired:true};changed=true}
      if(changed){owners.delete(requestId);targets.delete(requestId);atomic(file,entries)}
    },
  };
}
