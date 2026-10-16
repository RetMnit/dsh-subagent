// Independent log owner: a supervisor restart must not break a DSH stdout pipe.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { STATE, config, discoverRuntime, atomic } from './common.mjs';
const mode=process.argv[2];
if(!['desktop','headless'].includes(mode))throw new Error('Invalid Host mode');
const cfg=config();const runtime=discoverRuntime(cfg.runtime.installDir);
const logDir=path.join(STATE,'logs');fs.mkdirSync(logDir,{recursive:true});
const log=fs.createWriteStream(path.join(logDir,mode+'.log'),{flags:'a'});
const env={...process.env,CODEX_DSH_STATE_DIR:STATE};
if(mode==='headless')env.ELECTRON_RUN_AS_NODE='1';else delete env.ELECTRON_RUN_AS_NODE;
const child=spawn(runtime.executable,mode==='headless'?['--expose-internals',runtime.cli,'--profile',cfg.workerProfile,'--no-open','--port','0']:[],
  {cwd:cfg.defaults.workspace,windowsHide:mode==='headless',shell:false,env,stdio:['ignore','pipe','pipe']});
const record={runnerPid:process.pid,pid:child.pid,mode,startedAt:new Date().toISOString(),sourceRoot:cfg.sourceRoot};
atomic(path.join(STATE,mode+'-launch.json'),record);
for(const stream of [child.stdout,child.stderr]){
  stream.setEncoding('utf8');let pending='';
  const write=line=>log.write(line.replace(/([?&]token=)[^\s&]+/gi,'$1[redacted]')+'\n');
  stream.on('data',chunk=>{pending+=chunk;let cut;while((cut=pending.indexOf('\n'))>=0){write(pending.slice(0,cut));pending=pending.slice(cut+1)}});
  stream.on('end',()=>{if(pending)write(pending)});
}
child.on('error',error=>log.write('Host launch failed: '+error.message+'\n'));
child.on('close',code=>{atomic(path.join(STATE,mode+'-launch.json'),{...record,exitCode:code,finishedAt:new Date().toISOString()});log.end()});
