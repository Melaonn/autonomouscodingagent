import { minimatch } from 'minimatch';
import type { Repository, Run } from '../../../shared/types.js';

const defaultPolicy: Repository['review'] = {
  mode: 'risk-based',
  minimumRisk: 'medium',
  sensitivePaths: [
    '.github/workflows/**',
    '**/migrations/**',
    '**/auth/**',
    '**/security/**',
    '**/billing/**',
    '**/payments/**',
    '**/infra/**',
  ],
  maxChangedFiles: 8,
};

const riskOrder = { low: 0, medium: 1, high: 2 } as const;

export function decideNativeReview(run: Run, changedPaths: string[]) {
  const policy = run.policy.review || defaultPolicy;
  const paths = changedPaths.map((path) => path.replaceAll('\\', '/'));
  const reasons: string[] = [];

  if (policy.mode === 'always') reasons.push('Repository policy requires review for every change');
  if (!run.risk) reasons.push('Change risk was not declared');
  else if (riskOrder[run.risk.level] >= riskOrder[policy.minimumRisk])
    reasons.push(`Declared ${run.risk.level} risk meets the ${policy.minimumRisk} review threshold`);
  if (paths.length > policy.maxChangedFiles)
    reasons.push(`${paths.length} changed files exceed the policy limit of ${policy.maxChangedFiles}`);

  const sensitive = paths.filter((path) =>
    policy.sensitivePaths.some((pattern) =>
      minimatch(path, pattern, { dot: true, nocase: process.platform === 'win32' }),
    ),
  );
  if (sensitive.length) reasons.push(`Sensitive paths changed: ${sensitive.join(', ')}`);
  if (run.contract?.criteria.some((criterion) => criterion.evidence === 'review'))
    reasons.push('Acceptance criteria require review evidence');

  return { required: reasons.length > 0, reasons };
}
