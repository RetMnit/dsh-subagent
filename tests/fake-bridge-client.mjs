import fs from 'node:fs';
import path from 'node:path';
export function connect({state}) {
  const settings=()=>JSON.parse(fs.readFileSync(path.join(state,'fake.json'),'utf8'));
  const runtime=()=>{if(settings().runtimeError)throw new Error(settings().runtimeError);return {version:'fake-runtime',compatibility:{status:'shared-check'}}};
  const invoke=async(mode,method,params={},options={start:true})=>{
    if(options.start)runtime();
    const entry={mode,method,params,options};
    fs.appendFileSync(path.join(state,'calls.jsonl'),JSON.stringify(entry)+'\n');
    if(settings().endpoint){
      const response=await fetch(settings().endpoint,{method:'POST',body:JSON.stringify(entry)});
      const reply=await response.json();if(reply.error){const error=new Error(reply.error.message);error.code=reply.error.code;throw error}return reply.result;
    }
    if(settings().error){const error=new Error(settings().error.message);error.code=settings().error.code;throw error}
    return {mode,protocolVersion:2,instanceId:mode,capabilities:['concurrent-sessions']};
  };
  return {defaults:settings().defaults,runtime,call:invoke,
    async doctor(){const modes={};for(const mode of ['desktop','headless']){try{modes[mode]=await invoke(mode,'doctor',{}, {start:false})}catch(error){const startupFailure=settings().startupFailures?.[mode];modes[mode]={connected:false,error:error.code??error.message,...(startupFailure?{startupFailure}:{})}}}return {runtime:runtime(),modes}},
    focusDesktop(){fs.appendFileSync(path.join(state,'calls.jsonl'),JSON.stringify({method:'focusDesktop'})+'\n')},
  };
}
