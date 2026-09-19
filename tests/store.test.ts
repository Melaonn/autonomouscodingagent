import { afterEach, describe, expect, it } from 'vitest';
import { Store } from '../apps/server/src/store.js';
import type { Repository, Run } from '../shared/types.js';
const stores: Store[] = [];
afterEach(async () => {
  await Promise.all(stores.splice(0).map((s) => s.close()));
});
function repo(): Repository {
  return {
    id: crypto.randomUUID(),
    name: 'service',
    owner: 'team',
    repo: 'service',
    branch: 'main',
    stack: 'custom',
    standards: '',
    checks: [
      {
        id: 'check',
        label: 'check',
        argv: ['true'],
        kind: 'unit',
        report: 'exit',
        reportPath: '',
        required: true,
        timeoutSeconds: 30,
        baselineAllowed: false,
      },
    ],
    requiredCiChecks: [],
    ciWaiver: 'Controlled fixture',
    protectedPaths: [],
    version: 1,
    createdAt: new Date().toISOString(),
    deployment: {
      enabled: true,
      environment: 'staging',
      workflow: 'deploy.yml',
      rollbackWorkflow: 'rollback.yml',
      healthUrl: 'https://example.com/health',
      monitorIntervalSeconds: 300,
    },
  };
}
function run(repository: Repository): Run {
  const at = new Date().toISOString();
  return {
    id: crypto.randomUUID(),
    repositoryId: repository.id,
    prompt: 'Make a reliable change',
    backend: 'codex',
    reviewer: 'codex',
    status: 'queued',
    phase: 'planning',
    step: 'preflight',
    attempt: 0,
    createdAt: at,
    updatedAt: at,
    policy: repository,
    context: [],
    baseline: [],
    gates: [],
    limits: { repairs: 3, minutes: 90, agentMinutes: 20 },
    usage: { inputTokens: 0, outputTokens: 0, costUsd: null },
    repeatedFailures: 0,
  };
}
describe('durable store', () => {
  it('prevents two active runs for one repository', async () => {
    const store = await Store.open();
    stores.push(store);
    const repository = repo();
    await store.insertRun(run(repository));
    await expect(store.insertRun(run(repository))).rejects.toThrow();
  });
  it('rejects a stale worker write after its lease token changes', async () => {
    const store = await Store.open();
    stores.push(store);
    const item = run(repo());
    await store.insertRun(item);
    const claim = await store.claim(item.id);
    expect(claim).toBeTruthy();
    claim!.run.status = 'running';
    await expect(store.saveRun(claim!.run, crypto.randomUUID())).rejects.toThrow('Run lease lost');
  });
  it('versions and finds company knowledge', async () => {
    const store = await Store.open();
    stores.push(store);
    await store.put('document', {
      id: 'doc',
      title: 'Tenant security',
      source: 'policy',
      owner: 'security',
      content: 'Every request must enforce tenant isolation before reading customer data.',
      version: 1,
      hash: 'hash',
      createdAt: new Date().toISOString(),
    });
    const docs = await store.searchDocuments('add tenant isolation to customer API');
    expect(docs[0]?.id).toBe('doc');
  });
});
