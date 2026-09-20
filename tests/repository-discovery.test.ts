import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { discoverRepository } from '../apps/server/src/repository-discovery.js';
import { inspectWorkspace } from '../apps/server/src/workspace.js';

const runFile = promisify(execFile);
const cleanup: string[] = [];

afterEach(async () => {
  for (const path of cleanup.splice(0)) await rm(path, { recursive: true, force: true });
});

async function repository(files: Record<string, string>) {
  const root = await mkdtemp(join(tmpdir(), 'sdlc-discovery-'));
  cleanup.push(root);
  await runFile('git', ['init', '-b', 'main'], { cwd: root });
  await runFile('git', ['config', 'user.email', 'test@example.com'], { cwd: root });
  await runFile('git', ['config', 'user.name', 'Test User'], { cwd: root });
  await runFile('git', ['remote', 'add', 'origin', 'https://github.com/team/project.git'], { cwd: root });
  for (const [path, content] of Object.entries(files)) {
    await mkdir(join(root, path, '..'), { recursive: true });
    await writeFile(join(root, path), content);
  }
  await runFile('git', ['add', '.'], { cwd: root });
  await runFile('git', ['commit', '-m', 'initial'], { cwd: root });
  return root;
}

describe('automatic repository setup', () => {
  it('detects TypeScript commands, tests, CI evidence, and safe deployment defaults', async () => {
    const root = await repository({
      'package.json': JSON.stringify({
        scripts: {
          build: 'tsc',
          lint: 'eslint .',
          typecheck: 'tsc --noEmit',
          'test:unit': 'vitest run tests/unit',
          'test:e2e': 'playwright test',
        },
      }),
      'package-lock.json': JSON.stringify({ lockfileVersion: 3, packages: {} }),
      'src/index.ts': 'export const ready = true;\n',
      'tests/unit/index.test.ts': 'export {};\n',
      '.github/workflows/ci.yml': 'name: CI\njobs: {}\n',
      '.github/workflows/deploy.yml': 'name: deploy\njobs: {}\n',
    });

    const result = await discoverRepository(await inspectWorkspace(root));

    expect(result.repository).toMatchObject({
      owner: 'team',
      repo: 'project',
      branch: 'main',
      stack: 'typescript',
      setup: { source: 'detected', status: 'needs_confirmation', confidence: 'high' },
      deployment: { enabled: false, workflow: 'deploy.yml' },
    });
    expect(result.repository.checks.map((check) => check.id)).toEqual(
      expect.arrayContaining([
        'install',
        'build',
        'lint',
        'typecheck',
        'unit',
        'e2e',
        'secrets',
        'sast',
        'dependencies',
      ]),
    );
    expect(result.repository.testEvidence.sourcePaths).toContain('src/**');
    expect(result.repository.testEvidence.testPaths).toContain('tests/**');
    expect(result.questions).toHaveLength(3);
  });

  it('detects a uv Python project and keeps missing policy decisions visible', async () => {
    const root = await repository({
      'pyproject.toml': '[build-system]\nrequires=[]\n[tool.ruff]\n[tool.mypy]\n[tool.pytest.ini_options]\n',
      'uv.lock': 'version = 1\n',
      'src/service.py': 'READY = True\n',
      'tests/unit/test_service.py': 'def test_ready(): assert True\n',
    });

    const result = await discoverRepository(await inspectWorkspace(root));

    expect(result.repository.stack).toBe('python');
    expect(result.repository.checks.map((check) => check.id)).toEqual(
      expect.arrayContaining(['install', 'build', 'lint', 'typecheck', 'unit', 'secrets', 'sast']),
    );
    expect(result.repository.setup.warnings).toEqual(
      expect.arrayContaining([expect.stringContaining('dependency-audit'), expect.stringContaining('GitHub Actions')]),
    );
  });
});
