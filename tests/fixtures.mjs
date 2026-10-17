import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';

// Minimal synthetic ASAR fixture. No DSH executable or model is run by tests.
export function fakeConfig(root, overrides = {}) {
  const installDir=path.join(root,'runtime');fs.mkdirSync(path.join(installDir,'resources'),{recursive:true});
  const manifest=Buffer.from(JSON.stringify({name:'@deepseek-ai/dsh-desktop',version:'0.2.1-rc.1',dshBuildCommit:'ed75efeffee65f9fe93625bbd76a68cb219aaaf9',...overrides}));
  const header=Buffer.from(JSON.stringify({files:{'package.json':{size:manifest.length,offset:'0'}}}));
  const prefix=Buffer.alloc(16);prefix.writeUInt32LE(8+header.length,4);prefix.writeUInt32LE(header.length,12);
  fs.writeFileSync(path.join(installDir,'resources/app.asar'),Buffer.concat([prefix,header,manifest]));
  fs.writeFileSync(path.join(installDir,'DeepSeek Harness.exe'),'');
  return {runtime:{installDir},defaults:{workspace:root,permission:'danger-full-access'},token:randomUUID()};
}
