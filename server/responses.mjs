import {terminal} from './common.mjs';

const pick = (value, keys) => Object.fromEntries(keys.filter(key => value?.[key] !== undefined).map(key => [key, value[key]]));
const panelSummary = panel => panel && pick(panel, ['connected', 'visible', 'jobsRendered', 'lastError']);
const settingsSummary = settings => settings && pick(settings, ['workspace', 'preset', 'model', 'permission']);

function jobSummary(job, {answer = false, details = false, request = false} = {}) {
  const value = pick(job, ['jobId', 'sessionId', 'mode', 'title', 'status', 'phase', 'error', 'pendingQuestions', 'connection', 'connectionError']);
  const recent = job.recentEvents ?? job.events ?? [];
  const lastTool = recent.findLast(event => event.type === 'tool/call');
  if (!terminal(job.status) && lastTool?.tool) value.lastTool = lastTool.tool;
  const activeChildren = job.descendants?.filter(child => child.status === 'running').length;
  if (activeChildren) value.runningSubagents = activeChildren;
  if (job.backgroundJobs?.length) value.backgroundJobs = job.backgroundJobs.map(item => pick(item, ['id', 'jobId', 'status', 'title']));
  if (answer && job.result !== undefined) value.result = job.result;
  if (request && job.requestId !== undefined) value.requestId = job.requestId;
  if (details) {
    Object.assign(value, pick(job, ['createdAt', 'finishedAt', 'stopReason', 'actualModel', 'completionScope']));
    if (job.effective) value.effective = settingsSummary(job.effective);
    else if (job.requested) value.requested = settingsSummary(job.requested);
  }
  return value;
}

// Only the MCP presentation is reduced. The supervisor, persisted records and
// dashboard event stream keep the complete data.
export function toolResponse(method, value) {
  switch (method) {
    case 'list':
      return {...pick(value, ['conversationId', 'cursor']), subagents: value.subagents.map(agent => ({
        ...jobSummary(agent), turnCount: agent.turnCount,
        ...(agent.turnCount > 1 ? {previousJobIds: agent.turns.filter(turn => turn.jobId !== agent.jobId).map(turn => turn.jobId)} : {}),
      }))};
    case 'start': case 'resume':
      return {...jobSummary(value, {request: true}), panel: panelSummary(value.panel)};
    case 'start_many':
      return {jobs: value.jobs.map(job => jobSummary(job, {request: true})), errors: value.errors, panel: panelSummary(value.panel)};
    case 'status':
      return jobSummary(value, {details: true});
    case 'cancel':
      return jobSummary(value);
    case 'wait':
      return {...pick(value, ['cursor', 'reason']), jobs: value.jobs.map(job => jobSummary(job, {answer: terminal(job.status)}))};
    case 'result':
      return jobSummary(value, {answer: true, details: true});
    case 'doctor': case 'open':
      return {...value, ...(value.panel ? {panel: panelSummary(value.panel)} : {})};
    default:
      return value;
  }
}

export function toolContent(method, value) {
  // JSON text works with ordinary MCP clients without duplicating the payload
  // in structuredContent (these tools do not declare an outputSchema).
  return {content: [{type: 'text', text: JSON.stringify(toolResponse(method, value))}]};
}
