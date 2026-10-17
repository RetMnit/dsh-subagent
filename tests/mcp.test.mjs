import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';

test('MCP handshake, discovery and harmless doctor round-trip', async () => {
  const state=fs.mkdtempSync(path.join(os.tmpdir(),'codex-dsh-mcp-test-'));const token=randomUUID(),instanceId=randomUUID();
  const server=http.createServer(async(request,response)=>{
    assert.equal(request.headers.authorization,'Bearer '+token);
    response.setHeader('content-type','application/json');
    if(request.url==='/health')return response.end(JSON.stringify({instanceId}));
    let body='';for await(const chunk of request)body+=chunk;const call=JSON.parse(body);assert.equal(call.method,'doctor');
    response.end(JSON.stringify({result:{runtime:{version:'0.2.1-rc.1'}}}));
  });await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  fs.writeFileSync(path.join(state,'config.json'),JSON.stringify({token}));
  fs.writeFileSync(path.join(state,'supervisor.json'),JSON.stringify({instanceId,url:'http://127.0.0.1:'+server.address().port}));
  const child = spawn(process.execPath, [fileURLToPath(new URL('../server/mcp.mjs', import.meta.url))], { env:{...process.env,CODEX_DSH_STATE_DIR:state}, stdio: ['pipe','pipe','pipe'], windowsHide: true });
  let buffer = ''; let stderr = ''; const pending = new Map();
  child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8'); child.stderr.on('data', chunk => { stderr += chunk; });
  child.stdout.on('data', chunk => { buffer += chunk; let cut; while ((cut = buffer.indexOf('\n')) >= 0) { const value = JSON.parse(buffer.slice(0,cut)); buffer = buffer.slice(cut+1); pending.get(value.id)?.(value); pending.delete(value.id); } });
  const call = (method, params = {}) => new Promise((resolve,reject) => { const id=randomUUID(); const timeout=setTimeout(()=>reject(new Error('MCP timed out')),12000); pending.set(id,value=>{clearTimeout(timeout);resolve(value)}); child.stdin.write(JSON.stringify({jsonrpc:'2.0',id,method,params})+'\n'); });
  try {
    const init=await call('initialize',{protocolVersion:'2024-11-05',capabilities:{},clientInfo:{name:'offline-test',version:'1'}});
    assert.equal(init.result.serverInfo.name,'dsh-subagent');
    const catalog=await call('tools/list'); assert.equal(catalog.result.tools.length,14);
    assert.ok(catalog.result.tools.some(tool=>tool.name==='dsh_resume'));
    assert.ok(catalog.result.tools.find(tool=>tool.name==='dsh_start').inputSchema.required.includes('userAuthorized'));
    assert.ok(catalog.result.tools.some(tool=>tool.name==='dsh_configure'));
    assert.ok(catalog.result.tools.some(tool=>tool.name==='dsh_start_many'));
    assert.ok(!catalog.result.tools.find(tool=>tool.name==='dsh_start').inputSchema.required.includes('configurationId'));
    for(const name of ['dsh_configure','dsh_configuration','dsh_start','dsh_start_many','dsh_resume','dsh_list','dsh_wait','dsh_open'])assert.ok(catalog.result.tools.find(tool=>tool.name===name).inputSchema.required.includes('conversationId'));
    for(const name of ['dsh_configure','dsh_configuration','dsh_start','dsh_start_many','dsh_resume'])assert.ok(!Object.hasOwn(catalog.result.tools.find(tool=>tool.name===name).inputSchema.properties,'configurationId'));
    assert.ok(catalog.result.tools.find(tool=>tool.name==='dsh_resume').inputSchema.required.includes('sessionId'));
    assert.ok(!catalog.result.tools.some(tool=>tool.name==='dsh_prepare'));
    const doctor=await call('tools/call',{name:'dsh_doctor',arguments:{}}); assert.equal(doctor.result.isError,undefined);
    assert.equal(doctor.result.structuredContent,undefined);assert.equal(doctor.result.content.length,1);
    assert.equal(JSON.parse(doctor.result.content[0].text).runtime.version,'0.2.1-rc.1');
    const absent=await call('tools/call',{name:'dsh_start',arguments:{}}); assert.ok(absent.error); assert.match(absent.error.message,/Missing required/);
    const legacy=await call('tools/call',{name:'dsh_configure',arguments:{conversationId:'chat-A',createNew:true}});assert.match(legacy.error.message,/Unknown argument/);
    assert.equal(stderr,'');
  } finally {
    child.kill();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));
    assert.ok(path.resolve(state).startsWith(path.resolve(os.tmpdir())+path.sep)&&path.basename(state).startsWith('codex-dsh-mcp-test-'));fs.rmSync(state,{recursive:true,force:true});
  }
});
