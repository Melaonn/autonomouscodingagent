import { describe, expect, it } from 'vitest';
import { decideNativeReview } from '../apps/server/src/review-policy.js';
import type { Repository, Run } from '../shared/types.js';

const policy = {
  mode: 'risk-based' as const,
  minimumRisk: 'medium' as const,
  sensitivePaths: ['**/auth/**'],
  maxChangedFiles: 4,
};

function fixture(): Run {
  return {
    id: crypto.randomUUID(),
    repositoryId: crypto.randomUUID(),
    prompt: 'Add a profile field',
    backend: 'codex',
    mode: 'delivery',
    status: 'running',
    phase: 'coding',
    step: 'implementation',
    attempt: 0,
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
    startedAt: new Date(0).toISOString(),
    workspace: {
      branch: 'main',
      headSha: 'a'.repeat(40),
      digest: 'a'.repeat(40),
      dirty: false,
      changes: [],
    },
    policy: { review: policy } as Repository,
    context: [],
    risk: { level: 'low', rationale: 'Localized presentation change' },
    gates: [],
    limits: { verifications: 6 },
    repeatedFailures: 0,
  };
}

describe('native review policy', () => {
  it('skips a low-risk change outside configured sensitive paths', () => {
    expect(decideNativeReview(fixture(), ['src/profile.tsx'])).toEqual({ required: false, reasons: [] });
  });

  it('requires review for declared risk, sensitive paths, and broad changes', () => {
    const run = fixture();
    run.risk = { level: 'medium', rationale: 'Changes authorization behavior' };
    const decision = decideNativeReview(run, [
      'src/auth/permissions.ts',
      'src/a.ts',
      'src/b.ts',
      'src/c.ts',
      'src/d.ts',
    ]);
    expect(decision.required).toBe(true);
    expect(decision.reasons).toHaveLength(3);
  });

  it('fails closed when risk is missing', () => {
    const run = fixture();
    run.risk = undefined;
    expect(decideNativeReview(run, ['src/profile.tsx']).required).toBe(true);
  });
});
