import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { atomic, readJson } from './common.mjs';
import { conversationId } from './records.mjs';

const keys = ['mode', 'workspace', 'preset', 'model', 'permission'];
export function configurationStore(state, defaults) {
  const file = path.join(state, 'configurations.json');
  const raw = fs.existsSync(file) ? readJson(file) : {};
  const migrated = raw.schemaVersion !== 3;
  const entries = migrated ? {} : raw.conversations;
  // Archive old global/session-bound configurations; never adopt them for a new chat.
  const legacyConfigurations = migrated ? (raw.configurations ?? raw) : raw.legacyConfigurations;
  const select = input => {
    for (const key of Object.keys(input)) if (!keys.includes(key)) throw new Error('Unknown configuration parameter: ' + key);
    const value = Object.fromEntries(keys.filter(key => input[key] !== undefined).map(key => [key, input[key]]));
    if (!['desktop', 'headless'].includes(value.mode)) throw new Error('Choose desktop or headless');
    for (const key of ['workspace', 'preset', 'permission']) {
      if (value[key] !== undefined && (typeof value[key] !== 'string' || !value[key].trim())) throw new Error('Invalid ' + key);
    }
    if (value.model !== undefined) {
      if (!value.model || typeof value.model.provider !== 'string' || !value.model.provider.trim() || typeof value.model.model !== 'string' || !value.model.model.trim()) throw new Error('Provider and model must be set together');
      value.model = Object.fromEntries(['provider', 'model', 'reasoningEffort'].filter(key => value.model[key] !== undefined).map(key => {
        if (typeof value.model[key] !== 'string' || !value.model[key].trim()) throw new Error('Invalid model ' + key);
        return [key, value.model[key]];
      }));
    }
    if (!value.workspace) throw new Error('Workspace is required for new subagents');
    return value;
  };
  const save = () => atomic(file, {schemaVersion: 3, conversations: entries, legacyConfigurations});
  const get = id => {
    conversationId({conversationId: id});
    return Object.hasOwn(entries, id) ? entries[id] : {conversationId: id, status: 'missing'};
  };
  const read = id => structuredClone(get(id));
  const requireReady = params => {
    const entry = get(conversationId(params));
    if (entry.status !== 'ready') throw new Error('Save this Codex conversation\'s parameter configuration before its first DSH dispatch');
    return entry;
  };
  if (migrated) {
    if (fs.existsSync(file)) {
      const backup = path.join(state, 'backups', 'configurations-before-conversation-scope-' + Date.now() + '.json');
      fs.mkdirSync(path.dirname(backup), {recursive: true}); fs.copyFileSync(file, backup);
    }
    save();
  }
  return {
    create(params) {
      const id = conversationId(params);
      for (const key of Object.keys(params)) if (key !== 'conversationId') throw new Error('Open this conversation\'s parameter form without configuration overrides');
      if (get(id).status !== 'missing') return read(id);
      entries[id] = {conversationId: id, configurationId: 'configuration-' + randomUUID(), status: 'draft', revision: 0,
        values: select({mode: 'headless', workspace: defaults.workspace, permission: defaults.permission})};
      save(); return read(id);
    },
    read,
    requireReady,
    confirm(id, configurationId, values) {
      const entry = get(id);
      if (!entry.configurationId || entry.configurationId !== configurationId) throw new Error('Unknown configuration for this Codex conversation');
      entry.values = select(values); entry.status = 'ready'; entry.revision++; entry.savedAt = new Date().toISOString();
      save(); return read(id);
    },
    resolve(params, operation = 'start') {
      if (params.userAuthorized !== true) throw new Error('Explicit user permission to use DSH is required');
      const entry = requireReady(params);
      if (params.configurationId !== undefined) throw new Error('Configuration is selected by Codex conversation; omit configurationId');
      for (const key of keys) if (params[key] !== undefined && !(operation === 'resume' && key === 'mode')) throw new Error('Set ' + key + ' in the parameter form, not in dispatch arguments');
      if (typeof params.prompt !== 'string' || !params.prompt.trim()) throw new Error('prompt is required');
      if (typeof params.requestId !== 'string' || !params.requestId.trim()) throw new Error('A unique requestId is required for each task');
      let values;
      if (operation === 'resume') {
        if (typeof params.sessionId !== 'string' || !params.sessionId.trim()) throw new Error('sessionId is required to continue an existing DSH session');
        if (!['desktop', 'headless'].includes(params.mode)) throw new Error('Specify the existing session\'s desktop or headless mode');
        values = {mode: params.mode, sessionId: params.sessionId};
      } else {
        if (params.sessionId !== undefined) throw new Error('Use resume to continue an existing session');
        values = select(entry.values);
      }
      return {...values, configurationId: entry.configurationId, configurationRevision: entry.revision, requestId: params.requestId, prompt: params.prompt, ...(params.title ? {title: params.title} : {})};
    },
  };
}
