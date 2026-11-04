import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

// Load the shared runtime by its installer receipt, never a bundled copy.
export async function loadBridge({ state = process.env.DSH_BRIDGE_STATE_DIR || path.join(os.homedir(), '.dsh-bridge') } = {}) {
  let root;
  try { ({ root } = JSON.parse(fs.readFileSync(path.join(state, 'install.json'), 'utf8'))); }
  catch (cause) { throw new Error('Install Common/dsh-bridge first (node setup.mjs); its install.json could not be read', { cause }); }
  if (typeof root !== 'string' || !path.isAbsolute(root)) throw new Error('Invalid dsh-bridge install.json root; rerun its setup.mjs');
  const { connect } = await import(pathToFileURL(path.join(root, 'lib/client.mjs')).href);
  const client = connect({ state });
  const fields = {
    doctor: [], catalog: [], sessions: ['workspace', 'query', 'limit'],
    start: ['requestId', 'prompt', 'title', 'sessionId', 'workspace', 'preset', 'model', 'permission'],
    prepare: ['requestId', 'title', 'sessionId', 'workspace', 'preset', 'model', 'permission'],
    list: [], status: ['jobId'], cancel: ['jobId'], open: ['sessionId', 'jobId'],
    events: ['afterCursor', 'instanceId', 'timeoutMs'],
  };
  const tasks = new Set(['start', 'prepare', 'list', 'status', 'events', 'cancel', 'open']);
  return {
    defaults: client.defaults,
    runtime: () => client.runtime(),
    doctor: () => client.doctor(),
    focusDesktop: () => client.focusDesktop(),
    call(mode, method, params = {}, { start = false } = {}) {
      // The hidden Host is shared with other clients; this plugin never shuts it down.
      if (!Object.hasOwn(fields, method)) throw new Error('Unsupported dsh-bridge method: ' + method);
      const selected = Object.fromEntries(fields[method].filter(key => params[key] !== undefined).map(key => [key, params[key]]));
      if (tasks.has(method)) selected.client = 'codex';
      if (method === 'start' || method === 'prepare') {
        const meta = Object.fromEntries(['conversationId', 'configurationId', 'configurationRevision'].filter(key => params[key] !== undefined).map(key => [key, params[key]]));
        if (Object.keys(meta).length) selected.meta = meta;
      }
      return client.call(mode, method, selected, { start });
    },
  };
}
