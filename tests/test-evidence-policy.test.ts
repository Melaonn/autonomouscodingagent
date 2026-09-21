import { describe, expect, it } from 'vitest';
import { changedTestEvidence } from '../apps/server/src/test-evidence-policy.js';
import { repositorySchema, type Repository } from '../shared/types.js';

const repository = {
  ...repositorySchema.parse({
    name: 'service',
    owner: 'team',
    repo: 'service',
    stack: 'typescript',
    checks: [
      {
        id: 'unit',
        label: 'unit',
        argv: ['npm', 'test'],
        kind: 'unit',
        report: 'exit',
        reportPath: '',
      },
    ],
    requiredCiChecks: ['ci'],
  }),
  id: crypto.randomUUID(),
  version: 1,
  createdAt: new Date().toISOString(),
} satisfies Repository;

describe('changed test evidence policy', () => {
  it('requires a configured test-path change when source changes', () => {
    expect(changedTestEvidence(repository, ['src/server.ts'])).toMatchObject({
      applicable: true,
      satisfied: false,
    });
    expect(changedTestEvidence(repository, ['src/server.ts', 'tests/server.test.ts'])).toMatchObject({
      applicable: true,
      satisfied: true,
      sourceFiles: ['src/server.ts'],
      testFiles: ['tests/server.test.ts'],
    });
  });

  it('does not require test changes for documentation-only work', () => {
    expect(changedTestEvidence(repository, ['README.md'])).toMatchObject({ applicable: false, satisfied: false });
  });
});
