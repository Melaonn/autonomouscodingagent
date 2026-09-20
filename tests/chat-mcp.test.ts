import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createChatServer } from '../apps/server/src/chat-mcp.js';
import { ChatClient } from '../apps/server/src/chat-client.js';
import { buildApi } from '../apps/server/src/api.js';
import { RunService } from '../apps/server/src/run-service.js';
import { Store } from '../apps/server/src/store.js';
import { repositorySchema, type Repository } from '../shared/types.js';

const runFile = promisify(execFile);
const cleanup: (() => Promise<unknown>)[] = [];

afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
  vi.restoreAllMocks();
});

async function workspace() {
  const root = await mkdtemp(join(tmpdir(), 'native-sdlc-test-'));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  await runFile('git', ['init', '-b', 'main'], { cwd: root });
  await runFile('git', ['config', 'user.email', 'test@example.com'], { cwd: root });
  await runFile('git', ['config', 'user.name', 'Test User'], { cwd: root });
  await writeFile(join(root, 'index.js'), 'export const ready = true;\n');
  await runFile('git', ['add', '.'], { cwd: root });
  await runFile('git', ['commit', '-m', 'initial'], { cwd: root });
  await runFile('git', ['remote', 'add', 'origin', 'https://github.com/team/demo.git'], { cwd: root });
  return root;
}

describe('Codex chat integration', () => {
  it('governs the existing checkout through one native Codex lifecycle without exposing approval', async () => {
    const project = await workspace();
    const store = await Store.open();
    cleanup.push(() => store.close());
    const repository: Repository = {
      ...repositorySchema.parse({
        name: 'Demo',
        owner: 'team',
        repo: 'demo',
        stack: 'custom',
        checks: [
          {
            id: 'unit',
            label: 'unit',
            argv: [process.execPath, '-e', 'process.exit(0)'],
            kind: 'unit',
            report: 'exit',
          },
        ],
        requiredCiChecks: ['ci'],
      }),
      id: crypto.randomUUID(),
      version: 1,
      createdAt: new Date().toISOString(),
    };
    await store.put('repository', repository);
    const runs = new RunService(store);
    const app = await buildApi(store, runs);
    cleanup.push(() => app.close());
    const url = await app.listen({ host: '127.0.0.1', port: 0 });
    const removedPasswordLogin = await fetch(`${url}/auth/password`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password: 'unused' }),
    });
    expect(removedPasswordLogin.status).toBe(404);
    const api = new ChatClient(url);
    const server = createChatServer(api);
    cleanup.push(() => server.close());
    const client = new Client({ name: 'test-codex', version: '1' });
    cleanup.push(() => client.close());
    const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);

    const names = (await client.listTools()).tools.map((tool) => tool.name);
    expect(names).toEqual(['sdlc_start', 'sdlc_verify', 'sdlc_review', 'sdlc_publish', 'sdlc_status']);
    expect(names).not.toEqual(
      expect.arrayContaining([
        'sdlc_begin',
        'sdlc_spec',
        'sdlc_plan',
        'sdlc_requirements',
        'sdlc_design',
        'sdlc_progress',
        'sdlc_sync',
      ]),
    );
    expect(names.some((name) => name.includes('approv'))).toBe(false);

    const call = async (name: string, args: Record<string, unknown>, options?: Parameters<Client['callTool']>[2]) => {
      const response = await client.callTool({ name, arguments: args }, undefined, options);
      const content = response.content as { type: string; text: string }[];
      let data;
      try {
        data = JSON.parse(content[0].text);
      } catch {
        data = { error: content[0].text };
      }
      return { error: response.isError, data };
    };
    const plan = {
      scope: 'Task priorities',
      steps: ['add validation', 'test behavior'],
      dependencies: [],
      estimatedEffort: 'one hour',
      costEstimate: 'one developer hour',
      schedule: ['implementation', 'verification'],
      risks: [],
    };
    const input = { workspaceRoot: project, prompt: 'Add task priorities with validation' };
    const first = await call('sdlc_start', input);
    expect(first.error).toBeFalsy();
    expect(first.data.status).toBe('running');
    expect(first.data.phase).toBe('planning');
    const again = await call('sdlc_start', input);
    expect(again.data.runId).toBe(first.data.runId);
    expect(again.data.reused).toBe(true);
    expect(await store.runs()).toHaveLength(1);
    expect((await call('sdlc_start', { ...input, prompt: 'Make an unrelated change' })).error).toBe(true);

    const runId = first.data.runId;
    const specification = {
      plan,
      requirements: {
        summary: 'Validated task priorities',
        criteria: [
          {
            id: 'AC-1',
            description: 'Configured verification passes',
            evidence: 'test',
            checkIds: ['unit'],
            category: 'functional',
          },
        ],
        nonGoals: [],
        assumptions: [],
        risks: [],
        clarification: null,
      },
      design: {
        architecture: 'Existing module',
        apiContracts: [],
        dataChanges: [],
        uiBehavior: [],
        security: ['Reject unknown values'],
        compatibility: 'Backward compatible',
        testStrategy: 'Run configured unit gate',
      },
      risk: { level: 'high', rationale: 'Changes validation behavior' },
    };
    const progress: string[] = [];
    const verified = await call(
      'sdlc_verify',
      { runId, workspaceRoot: project, specification },
      { onprogress: (update) => progress.push(update.message || '') },
    );
    expect(verified.data.status).toBe('needs_review');
    expect(verified.data.step).toBe('native-review');
    expect(verified.data.verification.passed).toContain('unit');
    expect(progress).toEqual(expect.arrayContaining(['Starting unit', expect.stringContaining('unit passed')]));
    expect((await call('sdlc_start', { ...input, prompt: 'Start while native review is pending' })).error).toBe(true);
    const blockedByNativeReview = await call('sdlc_review', {
      runId,
      review: {
        summary: 'Native review found a blocking defect',
        findings: [
          {
            id: 'RV-1',
            severity: 'high',
            file: 'index.js',
            line: 1,
            description: 'Validation is incomplete',
            correction: 'Handle the missing case',
            criterionId: 'AC-1',
          },
        ],
      },
    });
    expect(blockedByNativeReview.data.status).toBe('repairing');
    expect(blockedByNativeReview.data.step).toBe('repair');
    expect((await store.getRun(runId))?.review?.source).toBe('codex-native-review');
    expect((await store.getRun(runId))?.review?.scope).toBe('uncommitted');
    const verifiedAfterRepair = await call('sdlc_verify', { runId, workspaceRoot: project });
    expect(verifiedAfterRepair.data.status).toBe('needs_review');
    const reviewed = await call('sdlc_review', {
      runId,
      review: {
        summary: 'Acceptance evidence is complete',
        findings: [],
      },
    });
    expect(reviewed.data.step).toBe('publish');
    expect((await store.artifacts(runId)).some((artifact) => artifact.name === 'native-review.json')).toBe(true);
    expect((await call('sdlc_status', { runId })).data.runId).toBe(runId);
    await expect(api.request(`/api/runs/${runId}/approval`, {})).rejects.toThrow('Unsupported');
    await mkdir(join(project, '.github', 'workflows'), { recursive: true });
    await writeFile(join(project, '.github', 'workflows', 'release.yml'), 'name: release\n');
    const protectedStart = await call('sdlc_start', {
      workspaceRoot: project,
      prompt: 'Change a protected deployment workflow',
    });
    expect(protectedStart.error).toBe(true);
    expect(protectedStart.data.error).toContain('Protected policy path');
  }, 30_000);

  it('rejects external hosts and redirects, and does not retry failed mutations', async () => {
    expect(() => new ChatClient('https://example.com')).toThrow('loopback');
    expect(() => new ChatClient('http://127.0.0.1:4310/path')).toThrow('loopback');
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        Response.json(
          { user: { login: 'local-operator', role: 'admin' }, csrf: 'test-csrf' },
          { headers: { 'set-cookie': 'sdlc_session=test; HttpOnly; Path=/' } },
        ),
      )
      .mockResolvedValueOnce(Response.json({ error: 'private internal secret' }, { status: 500 }));
    const api = new ChatClient('http://127.0.0.1:4310');
    await expect(api.request('/api/runs', {})).rejects.toThrow('Harness request failed (500)');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    for (const [, init] of fetchMock.mock.calls) expect(init?.redirect).toBe('error');
  });
});
