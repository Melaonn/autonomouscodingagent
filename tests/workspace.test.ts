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

  it('reuses npm dependencies only while manifests and runtime inputs are unchanged', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sdlc-install-cache-'));
    directories.push(root);
    await runFile('git', ['init', '-b', 'main'], { cwd: root });
    await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'cache-test', version: '1.0.0' }));
    await writeFile(
      join(root, 'package-lock.json'),
      JSON.stringify({
        name: 'cache-test',
        version: '1.0.0',
        lockfileVersion: 3,
        requires: true,
        packages: { '': { name: 'cache-test', version: '1.0.0' } },
      }),
    );
    const command = {
      id: 'install',
      label: 'install',
      argv: ['npm', 'ci'],
      required: true,
      kind: 'setup' as const,
      report: 'exit' as const,
      reportPath: '',
      timeoutSeconds: 60,
    };
    expect((await executeCheck(root, command)).cached).toBeUndefined();
    expect((await executeCheck(root, command)).cached).toBe(true);
    await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'cache-test', version: '1.0.1' }));
    await writeFile(
      join(root, 'package-lock.json'),
      JSON.stringify({
        name: 'cache-test',
        version: '1.0.1',
        lockfileVersion: 3,
        requires: true,
        packages: { '': { name: 'cache-test', version: '1.0.1' } },
      }),
    );
    expect((await executeCheck(root, command)).cached).toBeUndefined();
  }, 30_000);

  it('returns machine-readable secret and static security findings for tracked source', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sdlc-security-scan-'));
    directories.push(root);
    await runFile('git', ['init', '-b', 'main'], { cwd: root });
    const accessKey = ['AKIA', 'ABCDEFGHIJKLMNOP'].join('');
    const dynamicExecution = ['ev', "al('unsafe');"].join('');
    await writeFile(join(root, 'unsafe.js'), `const key = '${accessKey}';\n${dynamicExecution}\n`);
    const secrets = await executeCheck(root, {
      id: 'secrets',
      label: 'secrets',
      argv: ['@sdlc/security', 'secrets'],
      required: true,
      kind: 'security',
      report: 'gitleaks',
      reportPath: '.reports/secrets.json',
      timeoutSeconds: 30,
    });
    const sast = await executeCheck(root, {
      id: 'sast',
      label: 'sast',
      argv: ['@sdlc/security', 'sast'],
      required: true,
      kind: 'security',
      report: 'semgrep',
      reportPath: '.reports/sast.json',
      timeoutSeconds: 30,
    });
    expect(JSON.parse(secrets.files['.reports/secrets.json'])[0].RuleID).toBe('aws-access-key');
    expect(JSON.parse(sast.files['.reports/sast.json']).results[0].check_id).toBe('dynamic-eval');
  });
});
