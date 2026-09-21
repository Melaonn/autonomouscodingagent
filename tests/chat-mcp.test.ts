import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createChatServer, normalizeNativeReview, omittedTraceTerms } from '../apps/server/src/chat-mcp.js';
import { ChatClient } from '../apps/server/src/chat-client.js';
import { buildApi } from '../apps/server/src/api.js';
import { config } from '../apps/server/src/config.js';
import { RunService } from '../apps/server/src/run-service.js';
import { Store } from '../apps/server/src/store.js';
import { repositorySchema, type Repository } from '../shared/types.js';

const runFile = promisify(execFile);
const cleanup: (() => Promise<unknown>)[] = [];

beforeEach(() => {
  vi.stubEnv('GITHUB_CLIENT_ID', '');
  vi.stubEnv('GITHUB_CLIENT_SECRET', '');
});

afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
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
    const localMcpToken = 'local-mcp-test-token-that-is-at-least-32-characters';
    const originalLocalMcpToken = config.localMcpToken;
    config.localMcpToken = localMcpToken;
    cleanup.push(async () => {
      config.localMcpToken = originalLocalMcpToken;
    });
    vi.stubEnv('GITHUB_CLIENT_ID', 'oauth-client');
    vi.stubEnv('GITHUB_CLIENT_SECRET', 'oauth-secret');
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
    const browserSession = await fetch(`${url}/api/me`);
    expect((await browserSession.json()).user).toBeNull();
    const api = new ChatClient(url, localMcpToken);
    const server = createChatServer(api);
    cleanup.push(() => server.close());
    const client = new Client({ name: 'test-codex', version: '1' });
    cleanup.push(() => client.close());
    const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);

    const tools = (await client.listTools()).tools;
    const names = tools.map((tool) => tool.name);
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
    expect(Buffer.byteLength(JSON.stringify(tools))).toBeLessThan(7_000);

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
    const input = { workspaceRoot: project, prompt: 'Add task priorities with validation', mode: 'validation' };
    const first = await call('sdlc_start', input);
    expect(first.error).toBeFalsy();
    expect(first.data.status).toBe('running');
    expect(first.data.phase).toBe('planning');
    expect((await store.getRun(first.data.runId))?.mode).toBe('delivery');
    const again = await call('sdlc_start', input);
    expect(again.data.runId).toBe(first.data.runId);
    expect(again.data.reused).toBe(true);
    expect(await store.runs()).toHaveLength(1);
    expect((await call('sdlc_start', { ...input, prompt: 'Make an unrelated change' })).error).toBe(true);

    const runId = first.data.runId;
    const checkpoint = {
      planSummary: 'Add validated task priorities to the existing module.',
      planSteps: ['add validation', 'test behavior'],
      requirementsSummary: 'Validated task priorities',
      requirementCoverage: [
        {
          sourceQuote: 'Add task priorities with validation',
          requirement: 'Task priorities are validated.',
          acceptanceCriterion: 'Configured priority verification passes',
          testEvidence: 'The unit gate exercises valid and invalid priorities.',
        },
      ],
      designSummary: 'Extend the existing module without changing unrelated behavior.',
      testStrategy: 'Run the configured unit gate.',
      risk: { level: 'high', rationale: 'Changes validation behavior' },
    };
    const invalidTrace = await call('sdlc_verify', {
      runId,
      workspaceRoot: project,
      checkpoint: {
        ...checkpoint,
        requirementCoverage: [
          {
            ...checkpoint.requirementCoverage[0],
            sourceQuote: 'This requirement was never requested',
          },
        ],
      },
    });
    expect(invalidTrace.error).toBe(true);
    expect(invalidTrace.data.error).toContain('source quote is not present in the original request');
    const narrowedTrace = await call('sdlc_verify', {
      runId,
      workspaceRoot: project,
      checkpoint: {
        ...checkpoint,
        requirementCoverage: [
          {
            sourceQuote: 'Add task priorities with validation',
            requirement: 'Task priorities are stored.',
            acceptanceCriterion: 'Configured priorities persist.',
            testEvidence: 'The unit gate exercises priorities.',
          },
        ],
      },
    });
    expect(narrowedTrace.error).toBe(true);
    expect(narrowedTrace.data.error).toContain('trace omits material request terms (validate)');
    const progress: string[] = [];
    const verified = await call(
      'sdlc_verify',
      { runId, workspaceRoot: project, checkpoint },
      { onprogress: (update) => progress.push(update.message || '') },
    );
    expect(verified.data.status).toBe('needs_review');
    expect(verified.data.step).toBe('native-review');
    expect(verified.data.verification.passed).toContain('unit');
    expect((await store.getRun(runId))?.contract?.criteria[0].checkIds).toEqual(['unit']);
    expect((await store.getRun(runId))?.contract?.criteria[0].evidence).toBe('test');
    expect(progress).toEqual([]);
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
        criteria: [{ id: 'AC-1', satisfied: false, evidence: 'Validation remains incomplete.' }],
        requestCoverage: [
          {
            sourceQuote: 'Add task priorities with validation',
            requirement: 'Task priorities are validated.',
            status: 'missing',
            evidence: 'The invalid-priority path is absent.',
            file: 'index.js',
            line: 1,
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
        criteria: [{ id: 'AC-1', satisfied: true, evidence: 'The unit gate and diff cover validation.' }],
        requestCoverage: [
          {
            sourceQuote: 'Add task priorities with validation',
            requirement: 'Task priorities are validated.',
            status: 'satisfied',
            evidence: 'Validation and its focused test are present.',
            file: 'index.js',
            line: 1,
          },
        ],
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

  it('auto-fills an unknown repository and waits for one-time confirmation', async () => {
    const project = await workspace();
    await writeFile(
      join(project, 'package.json'),
      JSON.stringify({ scripts: { build: 'node --check index.js', test: 'node --test' } }),
    );
    const store = await Store.open();
    cleanup.push(() => store.close());
    const runs = new RunService(store);
    const app = await buildApi(store, runs);
    cleanup.push(() => app.close());
    const url = await app.listen({ host: '127.0.0.1', port: 0 });
    const server = createChatServer(new ChatClient(url));
    cleanup.push(() => server.close());
    const client = new Client({ name: 'test-codex', version: '1' });
    cleanup.push(() => client.close());
    const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const call = async (arguments_: Record<string, unknown>) => {
      const response = await client.callTool({ name: 'sdlc_start', arguments: arguments_ });
      return JSON.parse((response.content as { type: string; text: string }[])[0].text);
    };
    const input = { workspaceRoot: project, prompt: 'Add automatic project onboarding for the local repository' };

    const detected = await call(input);
    expect(detected).toMatchObject({ status: 'needs_input', setupRequired: true, repository: 'team/demo' });
    expect(detected.detected).toMatchObject({ stack: 'typescript', confidence: 'high', baseBranch: 'main' });
    expect(detected.detected.gates.map((check: { id: string }) => check.id)).toEqual(
      expect.arrayContaining(['install', 'lint', 'unit', 'integration', 'e2e']),
    );
    expect(detected.detected.warnings).toEqual(expect.arrayContaining([expect.stringContaining('lockfile')]));
    expect(detected.detected.bootstrapTasks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'dependency-lock' }),
        expect.objectContaining({ id: 'integration-foundation' }),
        expect.objectContaining({ id: 'e2e-foundation' }),
      ]),
    );
    expect(await store.runs()).toHaveLength(0);
    expect((await store.repositories())[0].setup?.status).toBe('needs_confirmation');

    const started = await call({ ...input, confirmSetup: true });
    expect(started).toMatchObject({ status: 'running', phase: 'planning', bootstrap: { status: 'required' } });
    expect(await store.runs()).toHaveLength(1);
    expect((await store.repositories())[0].setup?.status).toBe('bootstrapping');
    expect((await store.repositories())[0].requiredCiChecks).toEqual(['ci']);

    await writeFile(
      join(project, 'package.json'),
      JSON.stringify({
        name: 'bootstrap-demo',
        version: '1.0.0',
        scripts: {
          build: 'node --check index.js',
          lint: 'node --check index.js',
          test: 'node --test',
          'test:integration': 'node --test',
          'test:e2e': 'node --test',
        },
      }),
    );
    await writeFile(
      join(project, 'package-lock.json'),
      JSON.stringify({
        name: 'bootstrap-demo',
        version: '1.0.0',
        lockfileVersion: 3,
        requires: true,
        packages: { '': { name: 'bootstrap-demo', version: '1.0.0' } },
      }),
    );
    await writeFile(join(project, '.gitignore'), 'node_modules/\n.reports/\n');
    await mkdir(join(project, '.github', 'workflows'), { recursive: true });
    await writeFile(
      join(project, '.github', 'workflows', 'ci.yml'),
      'name: CI\non:\n  pull_request:\njobs:\n  ci:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo test\n',
    );
    const verified = await client.callTool({
      name: 'sdlc_verify',
      arguments: {
        runId: started.runId,
        workspaceRoot: project,
        checkpoint: {
          planSummary: 'Create the missing repository SDLC foundations.',
          planSteps: ['configure deterministic commands', 'add CI'],
          requirementsSummary: 'The detected SDLC gaps are executable and verified.',
          requirementCoverage: [
            {
              sourceQuote: 'Add automatic project onboarding for the local repository',
              requirement: 'The local repository is onboarded automatically.',
              acceptanceCriterion: 'Every configured test layer passes.',
              testEvidence: 'Unit, integration, and E2E gates run independently.',
            },
          ],
          designSummary: 'Use package scripts as stable local and CI entry points.',
          testStrategy: 'Run unit, integration, and E2E commands independently.',
          risk: { level: 'medium', rationale: 'Adds repository-wide development and CI infrastructure.' },
        },
      },
    });
    const verifiedData = JSON.parse((verified.content as { type: string; text: string }[])[0].text);
    expect(verifiedData.verification.failed).toBeUndefined();
    expect(verifiedData.setup).toBe('ready');
    expect((await store.repositories())[0].setup?.status).toBe('ready');
    expect((await store.repositories())[0].setup?.tasks.every((item) => item.status === 'verified')).toBe(true);
  }, 30_000);

  it('allows remote HTTPS, rejects unsafe server URLs and redirects, and does not retry failed mutations', async () => {
    expect(new ChatClient('https://example.com').url).toBe('https://example.com');
    expect(() => new ChatClient('http://example.com')).toThrow('requires HTTPS');
    expect(() => new ChatClient('http://127.0.0.1:4310/path')).toThrow('requires HTTPS');
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        Response.json(
          { user: { login: 'local-operator', role: 'admin' }, csrf: 'test-csrf' },
          { headers: { 'set-cookie': 'sdlc_session=test; HttpOnly; Path=/' } },
        ),
      )
      .mockResolvedValueOnce(Response.json({ error: 'private internal secret' }, { status: 500 }))
      .mockResolvedValueOnce(Response.json({ error: 'Specification checkpoint is out of order' }, { status: 409 }));
    const api = new ChatClient('http://127.0.0.1:4310');
    await expect(api.request('/api/runs', {})).rejects.toThrow('Harness request failed (500)');
    await expect(api.request('/api/runs', {})).rejects.toThrow(
      'Harness request failed (409): Specification checkpoint is out of order',
    );
    expect(fetchMock).toHaveBeenCalledTimes(3);
    for (const [, init] of fetchMock.mock.calls) expect(init?.redirect).toBe('error');
  });
});

describe('requirement trace validation', () => {
  it('keeps coordinated request clauses visible through review', () => {
    const quote = 'Using autofocus on a dialog or its descendants is recommended by the standard';
    expect(omittedTraceTerms(quote, 'Allow autofocus on dialog elements.')).toEqual(['descendant', 'standard']);
    expect(omittedTraceTerms(quote, 'Allow autofocus on dialog elements and descendants.')).toEqual([]);

    const normalized = normalizeNativeReview(
      quote,
      [
        {
          id: 'AC-1',
          description: 'Dialog autofocus is accepted.',
          sourceQuote: quote,
          requirement: 'Allow autofocus on dialogs and descendants.',
          testEvidence: 'Direct and nested cases have focused tests.',
          evidence: 'test',
          checkIds: ['unit'],
          category: 'functional',
        },
      ],
      {
        scope: 'uncommitted',
        summary: 'The direct dialog case passes.',
        findings: [],
        criteria: [{ id: 'AC-1', satisfied: true, evidence: 'A direct dialog fixture passes.' }],
        requestCoverage: [
          {
            sourceQuote: quote,
            requirement: 'Allow autofocus on dialog elements.',
            status: 'satisfied',
            evidence: 'The direct dialog fixture passes.',
            file: 'src/rule.ts',
            line: 10,
          },
        ],
      },
    );

    expect(normalized.requestCoverage[0].status).toBe('unverified');
    expect(normalized.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          severity: 'high',
          description: expect.stringContaining('descendant'),
        }),
      ]),
    );
  });
});
