import { execFile } from 'node:child_process';
import { access, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { executeCheck, inspectWorkspace } from '../apps/server/src/workspace.js';

const runFile = promisify(execFile);
const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe('native workspace evidence', () => {
  it('keeps the verified tree stable across temporary reports and an equivalent commit', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sdlc-workspace-'));
    directories.push(root);
    await runFile('git', ['init', '-b', 'main'], { cwd: root });
    await runFile('git', ['config', 'user.email', 'test@example.com'], { cwd: root });
    await runFile('git', ['config', 'user.name', 'Test User'], { cwd: root });
    await runFile('git', ['remote', 'add', 'origin', 'https://github.com/team/demo.git'], { cwd: root });
    await writeFile(join(root, 'index.js'), 'export const value = 1;\n');
    await runFile('git', ['add', '.'], { cwd: root });
    await runFile('git', ['commit', '-m', 'initial'], { cwd: root });

    await writeFile(join(root, 'index.js'), 'export const value = 2;\n');
    const candidate = await inspectWorkspace(root);
    const result = await executeCheck(root, {
      id: 'unit',
      label: 'unit',
      argv: [
        process.execPath,
        '-e',
        "const fs=require('fs');fs.mkdirSync('.reports',{recursive:true});fs.writeFileSync('.reports/unit.json',JSON.stringify({numTotalTests:1,numFailedTests:0,numPendingTests:0,success:true}))",
      ],
      required: true,
      kind: 'unit',
      report: 'vitest',
      reportPath: '.reports/unit.json',
      timeoutSeconds: 30,
    });
    expect(JSON.parse(result.files['.reports/unit.json']).numTotalTests).toBe(1);
    await expect(access(join(root, '.reports', 'unit.json'))).rejects.toThrow();
    expect((await inspectWorkspace(root)).digest).toBe(candidate.digest);

    await runFile('git', ['add', '.'], { cwd: root });
    await runFile('git', ['commit', '-m', 'candidate'], { cwd: root });
    const committed = await inspectWorkspace(root);
    expect(committed.digest).toBe(candidate.digest);
    expect(committed.dirty).toBe(false);
  });
});
