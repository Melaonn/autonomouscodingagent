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
import { config } from '../apps/server/src/config.js';
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
    const originalPassword = config.adminPassword;
    config.adminPassword = 'test-local-chat-password';
    cleanup.push(async () => {
      config.adminPassword = originalPassword;
    });
    const app = await buildApi(store, runs);
    cleanup.push(() => app.close());
    const url = await app.listen({ host: '127.0.0.1', port: 0 });
    const api = new ChatClient(url, config.adminPassword);
    const server = createChatServer(api);
    cleanup.push(() => server.close());
    const client = new Client({ name: 'test-codex', version: '1' });
    cleanup.push(() => client.close());
    const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);

    const names = (await client.listTools()).tools.map((tool) => tool.name);
    expect(names).toEqual(
      expect.arrayContaining(['sdlc_start', 'sdlc_plan', 'sdlc_verify', 'sdlc_review', 'sdlc_publish']),
    );
    expect(names.some((name) => name.includes('approv'))).toBe(false);

    const call = async (name: string, args: Record<string, unknown>) => {
      const response = await client.callTool({ name, arguments: args });
      const content = response.content as { type: string; text: string }[];
      return { error: response.isError, data: JSON.parse(content[0].text) };
    };
    const input = { workspaceRoot: project, prompt: 'Add task priorities with validation' };
    const first = await call('sdlc_start', input);
    expect(first.error).toBeFalsy();
    expect(first.data.status).toBe('running');
    expect(first.data.workspace.root).toBe(project);
    const again = await call('sdlc_start', input);
    expect(again.data.id).toBe(first.data.id);
    expect(again.data.reused).toBe(true);
    expect(await store.runs()).toHaveLength(1);
    expect((await call('sdlc_start', { ...input, prompt: 'Make an unrelated change' })).error).toBe(true);

    const runId = first.data.id;
    expect(
      (
        await call('sdlc_plan', {
          runId,
          plan: {
            scope: 'Task priorities',
            steps: ['add validation', 'test behavior'],
            dependencies: [],
            estimatedEffort: 'one hour',
            costEstimate: 'one developer hour',
            schedule: ['implementation', 'verification'],
            risks: [],
          },
        })
      ).data.phase,
    ).toBe('requirements');
    await call('sdlc_requirements', {
      runId,
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
    });
    await call('sdlc_design', {
      runId,
      design: {
        architecture: 'Existing module',
        apiContracts: [],
        dataChanges: [],
        uiBehavior: [],
        security: ['Reject unknown values'],
        compatibility: 'Backward compatible',
        testStrategy: 'Run configured unit gate',
      },
    });
    const verified = await call('sdlc_verify', { runId, workspaceRoot: project });
    expect(verified.data.step).toBe('self-review');
    expect(verified.data.gates[0].status).toBe('pass');
    const reviewed = await call('sdlc_review', {
      runId,
      review: {
        summary: 'Acceptance evidence is complete',
        findings: [],
        criteria: [{ id: 'AC-1', satisfied: true, evidence: 'unit gate passed' }],
      },
    });
    expect(reviewed.data.step).toBe('publish');
    expect((await call('sdlc_cancel', { runId })).data.status).toBe('cancelled');
    expect((await call('sdlc_runs', {})).data[0].id).toBe(runId);
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

  it('rejects external hosts and redirects before leaking a password, and does not retry failed mutations', async () => {
    expect(() => new ChatClient('https://example.com', 'secret')).toThrow('loopback');
    expect(() => new ChatClient('http://127.0.0.1:4310/path', 'secret')).toThrow('loopback');
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response('{}', { headers: { 'set-cookie': 'sdlc_session=test; HttpOnly; Path=/' } }))
      .mockResolvedValueOnce(Response.json({ csrf: 'test-csrf' }))
      .mockResolvedValueOnce(Response.json({ error: 'private internal secret' }, { status: 500 }));
    const api = new ChatClient('http://127.0.0.1:4310', 'private-password');
    await expect(api.request('/api/runs', {})).rejects.toThrow('Harness request failed (500)');
    expect(fetchMock).toHaveBeenCalledTimes(3);
    for (const [, init] of fetchMock.mock.calls) expect(init?.redirect).toBe('error');
  });
});
