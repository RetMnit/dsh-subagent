import fs from 'node:fs';
import path from 'node:path';
import {atomic, readJson, terminal} from './common.mjs';

export const retentionPolicy = {days: 30, maxCompletedPerConversation: 100};
export function conversationId(params) {
  const id = params?.conversationId;
  if (typeof id !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(id)) throw new Error('conversationId must be the current Codex thread ID');
  return id;
}
export function runtimeRecords(state, jobs, requests, clock = Date.now) {
  const ownerFile = path.join(state, 'job-owners.json');
  const prunedFile = path.join(state, 'pruned-jobs.json');
  const owners = fs.existsSync(ownerFile) ? readJson(ownerFile) : {};
  const pruned = fs.existsSync(prunedFile) ? readJson(prunedFile) : {};
  let lastCleanup = {removed: 0, checkedAt: null};
  const decorated = job => {
    const id=owners[job.jobId]??job.conversationId??requests.conversationOf?.(job.requestId);
    const target=requests.targetOf?.(job.requestId);
    // The Host omits sessionId while preparing; a resume already has a durable target.
    return {...job,...(!job.sessionId&&target?.mode===job.mode?{sessionId:target.sessionId}:{}),...(id?{conversationId:id}:{})};
  };
  return {
    decorate: decorated,
    remember(incoming) {
      const job=decorated(incoming), previous=jobs.get(job.jobId);
      // Event snapshots and the dispatch/status replies can arrive out of order.
      if(previous&&((terminal(previous.status)&&!terminal(job.status))||(previous.status!=='starting'&&job.status==='starting')||(terminal(previous.status)===terminal(job.status)&&previous.updatedAt&&job.updatedAt&&previous.updatedAt>job.updatedAt)||JSON.stringify(previous)===JSON.stringify(job)))return previous;
      jobs.set(job.jobId,job);return job;
    },
    assign(job, id) {
      conversationId({conversationId:id});
      if (owners[job.jobId] && owners[job.jobId] !== id) throw new Error('Task already belongs to another Codex conversation');
      owners[job.jobId]=id;atomic(ownerFile,owners);return decorated(job);
    },
    accepts(job) {return !Object.hasOwn(pruned,job.jobId)},
    owns(job, id) {return decorated(job).conversationId === id},
    cleanup() {
      const cutoff=clock()-retentionPolicy.days*86400000;
      const groups=new Map();
      for(const job of jobs.values())if(terminal(job.status)){
        const scope=owners[job.jobId]??job.conversationId??'\u0000legacy';
        if(!groups.has(scope))groups.set(scope,[]);groups.get(scope).push(job);
      }
      const candidates=[];
      for(const group of groups.values()){
        group.sort((a,b)=>Date.parse(b.finishedAt??b.updatedAt??b.createdAt)-Date.parse(a.finishedAt??a.updatedAt??a.createdAt));
        group.forEach((job,index)=>{const stamp=Date.parse(job.finishedAt??job.updatedAt??job.createdAt);if(Number.isFinite(stamp)&&(stamp<cutoff||index>=retentionPolicy.maxCompletedPerConversation))candidates.push(job)});
      }
      let removed=0;const errors=[];
      for(const job of candidates){try{
        requests.forget(job.requestId);
        pruned[job.jobId]=clock();atomic(prunedFile,pruned);
        jobs.delete(job.jobId);delete owners[job.jobId];removed++;
      }catch(error){errors.push({jobId:job.jobId,message:error.message})}}
      if(removed)atomic(ownerFile,owners);
      lastCleanup={checkedAt:new Date(clock()).toISOString(),removed,...(errors.length?{errors}:{})};
      return lastCleanup;
    },
    status(){return {...retentionPolicy,...lastCleanup}},
  };
}
