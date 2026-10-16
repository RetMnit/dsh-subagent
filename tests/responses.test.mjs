import test from 'node:test';
import assert from 'node:assert/strict';
import {groupSubagents} from '../server/subagents.mjs';
import {toolResponse,toolContent} from '../server/responses.mjs';

const answer='完整答案和路径 D:/项目/结果.txt\n'.repeat(2000);
const jobs=[1,2,3,4].map(number=>({jobId:'job-'+number,requestId:'request-'+number,sessionId:'session-'+(number%2),mode:'desktop',title:'任务 '+number,status:'completed',createdAt:new Date(number*1000).toISOString(),finishedAt:new Date(number*1000+1).toISOString(),result:answer+number,
  requested:{workspace:'workspace'},effective:{workspace:'workspace',preset:'unity',permission:'danger-full-access',model:{provider:'fake',model:'fake-v1'},tools:Array.from({length:30},(_,index)=>'tool_'+index)},
  recentEvents:[{type:'assistant/message',text:answer+number}],usageSamples:[{inputTokens:100,outputTokens:100}],eventCounts:{'request/header':1},stopReason:{kind:'completed'},actualModel:{provider:'fake',model:'fake-v1'}}));
const panel={connected:true,visible:true,jobsRendered:true,launches:3,renderedJobs:jobs.map(job=>({jobId:job.jobId,status:job.status,hasResult:true}))};
const snapshot={conversationId:'chat-A',cursor:5,jobs,subagents:groupSubagents(jobs),providers:{desktop:{connected:true}},panel,retention:{days:30}};

test('list returns each subagent once with control IDs, without duplicating results or history',()=>{
  const before=JSON.stringify(snapshot);const response=toolResponse('list',snapshot);
  assert.equal(response.subagents.length,2);assert.equal(response.jobs,undefined);assert.equal(response.cursor,5);
  assert.ok(response.subagents.every(agent=>agent.turnCount===2&&agent.previousJobIds.length===1&&agent.sessionId&&agent.jobId&&agent.mode));
  assert.ok(!JSON.stringify(response).includes(answer.slice(0,100)));assert.equal(response.subagents[0].turns,undefined);
  assert.equal(JSON.stringify(snapshot),before);assert.ok(JSON.stringify(response).length<before.length/10);
});

test('dispatch/status omit answers and large logs; wait/result preserve full answers and failure/user-action details',()=>{
  const dispatch=toolResponse('start_many',{jobs,errors:[{requestId:'failed',message:'busy'}],panel});
  assert.equal(dispatch.jobs.length,4);assert.equal(dispatch.jobs[0].result,undefined);assert.equal(dispatch.errors[0].message,'busy');
  assert.equal(dispatch.jobs[0].requestId,'request-1');
  assert.equal(dispatch.panel.jobsRendered,true);assert.equal(dispatch.panel.renderedJobs,undefined);
  for(const method of ['start','resume','cancel','status']){
    const response=toolResponse(method,{...jobs[0],panel});assert.equal(response.result,undefined);assert.equal(response.recentEvents,undefined);assert.equal(response.usageSamples,undefined);
    assert.equal(response.jobId,'job-1');
  }
  const status=toolResponse('status',jobs[0]);assert.equal(status.effective.preset,'unity');assert.equal(status.effective.tools,undefined);
  const waiting={...jobs[1],status:'waiting-user',pendingQuestions:[{id:'question',question:'选哪个？',options:['A','B']}],error:{code:'test',message:'useful error'},connection:'disconnected',connectionError:'pipe closed',descendants:[{sessionId:'child',status:'running'}],backgroundJobs:[{jobId:'background',status:'running',output:answer}]};
  const response=toolResponse('wait',{cursor:9,reason:'attention-or-completion',jobs:[jobs[0],waiting]});
  assert.equal(response.jobs[0].result,jobs[0].result);assert.equal(response.jobs[1].result,undefined);
  assert.deepEqual(response.jobs[1].pendingQuestions,waiting.pendingQuestions);assert.deepEqual(response.jobs[1].error,waiting.error);
  assert.equal(response.jobs[1].connectionError,'pipe closed');assert.equal(response.jobs[1].runningSubagents,1);assert.equal(response.jobs[1].backgroundJobs[0].output,undefined);
  const result=toolResponse('result',jobs[0]);assert.equal(result.result,jobs[0].result);assert.deepEqual(result.stopReason,jobs[0].stopReason);assert.deepEqual(result.actualModel,jobs[0].actualModel);
  assert.equal(toolResponse('wait',{jobs:[{...jobs[0],status:'failed',error:{message:'failed'}}]}).jobs[0].result,jobs[0].result);
  assert.equal(toolResponse('wait',{jobs:[],reason:'no-jobs'}).jobs.length,0);
});

test('MCP uses one JSON payload, preserving configuration/open data and window receipts without changing the dashboard',()=>{
  const content=toolContent('list',snapshot);assert.equal(content.structuredContent,undefined);assert.equal(content.content.length,1);
  assert.deepEqual(JSON.parse(content.content[0].text),toolResponse('list',snapshot));
  const entry={configurationId:'configuration-A',status:'ready',values:{mode:'desktop',workspace:'workspace'}};
  assert.deepEqual(JSON.parse(toolContent('configuration',entry).content[0].text),entry);
  const opened=toolResponse('open',{url:'http://127.0.0.1/?conversationId=chat-A',panel});assert.ok(opened.url);assert.equal(opened.panel.visible,true);assert.equal(opened.panel.renderedJobs,undefined);
  assert.equal(snapshot.jobs[0].result,answer+1);assert.equal(snapshot.subagents[0].turns.length,2);assert.equal(snapshot.panel.renderedJobs.length,4);
});
