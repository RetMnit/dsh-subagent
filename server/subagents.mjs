// A DSH session is one subagent; jobs are individual turns within that session.
export function groupSubagents(jobs) {
  const groups = new Map();
  for (const job of [...jobs].sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.jobId.localeCompare(b.jobId))) {
    const key = JSON.stringify([job.mode, job.sessionId || job.jobId]);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(job);
  }
  return [...groups].map(([subagentId, turns]) => {
    const latest = turns.findLast(turn=>!terminal(turn.status)) || turns.at(-1);
    return {...latest, subagentId, title: turns[0].title || 'DSH 子智能体', subagentCreatedAt: turns[0].createdAt, turnCount: turns.length, turns};
  }).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}
import {terminal} from './common.mjs';
