import { afterEach, describe, expect, it, vi } from 'vitest';
import { Engine } from '../apps/server/src/engine.js';
import { Store } from '../apps/server/src/store.js';
import type { AgentJob, Runner } from '../apps/server/src/runner.js';
import type { CheckCommand, JobResult, Repository, Run } from '../shared/types.js';
class FakeRunner implements Runner {
  ready = async () => ({ ok: true, docker: 'test', image: true, agents: { codex: 'test' } });
  codexStatus = async () => ({ connected: true });
  startCodexLogin = async () => ({ id: crypto.randomUUID() });
  codexLogin = async (id: string) => ({ id, status: 'connected' as const });
  prepare = async () => ({ sha: 'a'.repeat(40) });
  async agent(job: AgentJob): Promise<JobResult> {
    let object: unknown;
    if (job.prompt.includes('delivery lead')) object = { scope: 'Add behavior', steps: ['implement'], dependencies: [], estimatedEffort: 'one day', costEstimate: 'existing subscriptions', schedule: ['day one'], risks: [] };
    else if (job.prompt.includes('business analyst')) object = { summary: 'Add behavior', criteria: [{ id: 'AC-1', description: 'Behavior works', evidence: 'test', checkIds: ['check'], category: 'functional' }], nonGoals: [], assumptions: [], risks: [], clarification: null };
    else if (job.prompt.includes('software architect')) object = { architecture: 'Follow service structure', apiContracts: [], dataChanges: [], uiBehavior: [], security: ['preserve authorization'], compatibility: 'compatible', testStrategy: 'independent test' };
    else if (job.prompt.includes('independent test engineer')) object = { files: [{ path: 'acceptance.test.js', content: 'process.exit(0)' }], command: { id: 'acceptance', label: 'acceptance', argv: ['node','/acceptance/acceptance.test.js'], required: true, kind: 'acceptance', report: 'exit', reportPath: '', timeoutSeconds: 30, baselineAllowed: false }, coveredCriteria: ['AC-1'], explanation: 'contract check' };
    else if (job.prompt.includes('independent senior code reviewer')) object = { summary: 'Verified', findings: [], criteria: [{ id: 'AC-1', satisfied: true, evidence: 'check and acceptance gates passed' }] };
    if (!object) return { exitCode: 0, stdout: 'implemented', stderr: '', durationMs: 1, files: {} };
    const text = JSON.stringify(object); const stdout = job.backend === 'codex' ? JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text } }) : JSON.stringify({ type: 'result', result: text });
    return { exitCode: 0, stdout, stderr: '', durationMs: 1, files: {} };
  }
  command = async () => ({ exitCode: 0, stdout: '', stderr: '', durationMs: 1, files: {} });
  commit = async () => ({ sha: 'b'.repeat(40), changed: ['src/feature.ts'] });
  diff = async () => ({ diff: 'diff --git a/src/feature.ts b/src/feature.ts' });
  push = async () => undefined;
  destroy = async () => undefined;
  analyze = async () => ({ exitCode: 0, stdout: '{}', stderr: '', durationMs: 1, files: {} });
}
function repository(): Repository { const check: CheckCommand = { id: 'check', label: 'check', argv: ['true'], required: true, kind: 'unit', report: 'exit', reportPath: '', timeoutSeconds: 30, baselineAllowed: false }; return { id: crypto.randomUUID(), name: 'fixture', owner: 'team', repo: 'fixture', branch: 'main', stack: 'custom', standards: 'Preserve authorization', checks: [check], requiredCiChecks: ['ci'], ciWaiver: '', protectedPaths: ['.github/workflows/'], version: 1, createdAt: new Date().toISOString(), deployment: { enabled: true, environment: 'staging', workflow: 'deploy.yml', rollbackWorkflow: 'rollback.yml', healthUrl: 'https://example.com/health', monitorIntervalSeconds: 300, automaticMaintenance: false } }; }
describe('workflow engine', () => {
  const previousToken = process.env.GITHUB_TOKEN;
  afterEach(() => { vi.unstubAllGlobals(); if (previousToken === undefined) delete process.env.GITHUB_TOKEN; else process.env.GITHUB_TOKEN = previousToken; });
  it('advances all development phases and stops at exact deployment approval', async () => {
    process.env.GITHUB_TOKEN = 'test-token';
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit) => { const url = String(input); if (url.includes('/pulls?')) return new Response('[]', { status: 200 }); if (url.endsWith('/pulls') && init?.method === 'POST') return Response.json({ number: 7, html_url: 'https://github.test/pr/7' }); if (url.includes('/check-runs')) return Response.json({ check_runs: [{ name: 'ci', status: 'completed', conclusion: 'success', html_url: 'https://github.test/check' }] }); return new Response(null, { status: 204 }); }));
    const store = await Store.open(); const policy = repository(); await store.put('repository', policy); const at = new Date().toISOString(); const run: Run = { id: crypto.randomUUID(), repositoryId: policy.id, prompt: 'Implement the requested safe behavior', backend: 'codex', reviewer: 'codex', status: 'queued', phase: 'planning', step: 'preflight', attempt: 0, createdAt: at, updatedAt: at, policy, context: [], baseline: [], gates: [], limits: { repairs: 3, minutes: 90, agentMinutes: 20 }, usage: { inputTokens: 0, outputTokens: 0, costUsd: null }, repeatedFailures: 0 }; await store.insertRun(run); const engine = new Engine(store, new FakeRunner(), 2, 0);
    for (let i = 0; i < 10; i++) await engine.runOnce();
    let current = (await store.getRun(run.id))!; expect(current.phase).toBe('deployment'); expect(current.step).toBe('remote-ci');
    await engine.runOnce(); current = (await store.getRun(run.id))!;
    expect(current.status, current.blocker).toBe('awaiting_approval'); expect(current.prUrl).toBe('https://github.test/pr/7'); expect(current.approval?.digest).toHaveLength(64); expect(current.gates.every(g => g.status === 'pass')).toBe(true); await store.close();
  });
});
