import { afterEach, describe, expect, it } from 'vitest';
import { Store } from '../apps/server/src/store.js';
import type { Repository, Run } from '../shared/types.js';

const stores: Store[] = [];
afterEach(async () => {
  await Promise.all(stores.splice(0).map((store) => store.close()));
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
      },
    ],
    requiredCiChecks: [],
    ciWaiver: 'Controlled fixture',
    protectedPaths: [],
    testEvidence: { requiredForSourceChanges: true, sourcePaths: ['src/**'], testPaths: ['tests/**'] },
    review: { mode: 'always', minimumRisk: 'low', sensitivePaths: [], maxChangedFiles: 8 },
    version: 1,
    createdAt: new Date().toISOString(),
    deployment: {
      enabled: true,
      target: 'test staging',
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
    status: 'running',
    phase: 'planning',
    step: 'planning',
    attempt: 0,
    createdAt: at,
    updatedAt: at,
    startedAt: at,
    workspace: {
      branch: 'main',
      headSha: 'a'.repeat(40),
      digest: 'a'.repeat(40),
      dirty: false,
      changes: [],
    },
    policy: repository,
    context: [],
    gates: [],
    limits: { verifications: 6 },
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

  it('permits a new run after the previous one finishes', async () => {
    const store = await Store.open();
    stores.push(store);
    const repository = repo();
    const first = run(repository);
    await store.insertRun(first);
    first.status = 'completed';
    await store.saveRun(first);
    await expect(store.insertRun(run(repository))).resolves.toBeUndefined();
  });

  it('versions and finds company knowledge', async () => {
    const store = await Store.open();
    stores.push(store);
    await store.putDocument({
      id: 'doc',
      title: 'Tenant security',
      source: 'policy',
      owner: 'security',
      content: 'Every request must enforce tenant isolation before reading customer data.',
      version: 1,
      hash: 'hash',
      createdAt: new Date().toISOString(),
    });
    const documents = await store.searchDocuments('add tenant isolation to customer API');
    expect(documents[0]?.id).toBe('doc');
    expect(documents[0]?.excerpt).toContain('tenant');
    expect(documents[0]?.excerpt).toContain('isolation');
  });
});
