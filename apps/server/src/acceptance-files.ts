import { safePath } from './security.js';

// Chunked data avoids Linux's per-environment-string size limit. Names are data,
// never shell source, and each check receives its own fresh acceptance volume.
export function acceptanceWrites(path: string, content: string) {
  const name = safePath(path);
  if (name.includes('/')) throw new Error('Acceptance files must use flat names');
  const bytes = Buffer.from(content);
  const chunks: string[] = [];
  for (let i = 0; i < bytes.length; i += 24000) chunks.push(bytes.subarray(i, i + 24000).toString('base64'));
  if (!chunks.length) chunks.push('');
  return chunks.map((chunk, index) => ({
    argv: [
      'node',
      '-e',
      `const fs=require('node:fs'); const path=require('node:path').join('/acceptance',process.env.SDLC_FILE); fs.${index === 0 ? 'writeFileSync' : 'appendFileSync'}(path,Buffer.from(process.env.SDLC_DATA,'base64'));${index === chunks.length - 1 ? 'fs.chmodSync(path,0o444);' : ''}`,
    ],
    env: [`SDLC_FILE=${name}`, `SDLC_DATA=${chunk}`],
  }));
}
