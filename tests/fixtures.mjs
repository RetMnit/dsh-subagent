import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';

// Minimal synthetic ASAR fixture. No DSH executable or model is run by tests.
export function fakeConfig(root) {
  const installDir=path.join(root,'runtime');fs.mkdirSync(path.join(installDir,'resources'),{recursive:true});
  const manifest=Buffer.from(JSON.stringify({name:'@deepseek-ai/dsh-desktop',version:'0.2.0-rc.2',dshBuildCommit:'04f392c9ddd144fa426da2045178797da6db6c11'}));
  const header=Buffer.from(JSON.stringify({files:{'package.json':{size:manifest.length,offset:'0'}}}));
  const prefix=Buffer.alloc(16);prefix.writeUInt32LE(8+header.length,4);prefix.writeUInt32LE(header.length,12);
  fs.writeFileSync(path.join(installDir,'resources/app.asar'),Buffer.concat([prefix,header,manifest]));
  fs.writeFileSync(path.join(installDir,'DeepSeek Harness.exe'),'');
  return {runtime:{installDir},defaults:{workspace:root,permission:'danger-full-access'},token:randomUUID()};
}
