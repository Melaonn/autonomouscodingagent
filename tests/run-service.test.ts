import { afterEach, describe, expect, it } from 'vitest';
import { RunService } from '../apps/server/src/run-service.js';
import { Store } from '../apps/server/src/store.js';
import type { Repository, WorkspaceState } from '../shared/types.js';

const stores: Store[] = [];
afterEach(async () => {
  await Promise.all(stores.splice(0).map((store) => store.close()));
});

describe('validation-only lifecycle', () => {
  it('completes an unchanged verified workspace without publication', async () => {
    const store = await Store.open();
    stores.push(store);
    const service = new RunService(store);
    const repository: Repository = {
      id: crypto.randomUUID(),
      name: 'demo',
      owner: 'team',
      repo: 'demo',
      branch: 'main',
      stack: 'custom',
      standards: '',
      checks: [
        {
          id: 'unit',
          label: 'unit',
          argv: ['true'],
          kind: 'unit',
          report: 'exit',
          reportPath: '',
          required: true,
          timeoutSeconds: 30,
        },
      ],
      requiredCiChecks: [],
      ciWaiver: 'Validation fixture',
      protectedPaths: [],
      version: 1,
      createdAt: new Date().toISOString(),
      deployment: {
        enabled: false,
        environment: 'staging',
        workflow: 'deploy.yml',
        rollbackWorkflow: 'rollback.yml',
        healthUrl: '',
        monitorIntervalSeconds: 300,
      },
    };
    const digest = 'a'.repeat(40);
    const workspace: WorkspaceState = {
      branch: 'main',
      headSha: 'b'.repeat(40),
      digest,
      dirty: false,
      changes: [],
    };
    const { run } = await service.create(
      repository,
      'Validate the existing implementation',
      workspace,
      'validation',
      'tester',
    );
    await service.savePlan(
      run.id,
      {
        scope: 'Existing behavior',
        steps: ['verify'],
        dependencies: [],
        estimatedEffort: 'minutes',
        costEstimate: 'local compute',
        schedule: ['verification'],
        risks: [],
      },
      'tester',
    );
    await service.saveRequirements(
      run.id,
      {
        summary: 'Existing behavior is valid',
        criteria: [
          {
            id: 'AC-1',
            description: 'Unit gate passes',
            evidence: 'test',
            checkIds: ['unit'],
            category: 'reliability',
          },
        ],
        nonGoals: [],
        assumptions: [],
        risks: [],
        clarification: null,
      },
      'tester',
    );
    await service.saveDesign(
      run.id,
      {
        architecture: 'No change',
        apiContracts: [],
        dataChanges: [],
        uiBehavior: [],
        security: [],
        compatibility: 'Unchanged',
        testStrategy: 'Run unit gate',
      },
      'tester',
    );
    await service.verify(
      run.id,
      digest,
      [{ commandId: 'unit', result: { exitCode: 0, stdout: '', stderr: '', durationMs: 1, files: {} } }],
      'tester',
    );
    const completed = await service.saveReview(
      run.id,
      {
        summary: 'Validated',
        findings: [],
        criteria: [{ id: 'AC-1', satisfied: true, evidence: 'Unit gate passed' }],
      },
      'tester',
    );
    expect(completed.status).toBe('completed');
    expect(completed.step).toBe('validated');
    expect(completed.candidateSha).toBeUndefined();
  });
});
