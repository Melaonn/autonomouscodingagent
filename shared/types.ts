import { z } from 'zod';

export const phases = ['planning', 'requirements', 'design', 'coding', 'testing', 'deployment', 'maintenance'] as const;
export type Phase = (typeof phases)[number];

export const backendSchema = z.literal('codex');
export type Backend = z.infer<typeof backendSchema>;
export const runModeSchema = z.enum(['delivery', 'validation']);
export type RunMode = z.infer<typeof runModeSchema>;
export type Status =
  | 'running'
  | 'repairing'
  | 'needs_input'
  | 'needs_review'
  | 'awaiting_approval'
  | 'blocked'
  | 'failed'
  | 'completed'
  | 'monitoring'
  | 'cancelled';
export type Role = 'admin' | 'operator' | 'viewer';

export interface User {
  login: string;
  role: Role;
}

const relativeReportPath = z
  .string()
  .default('')
  .refine(
    (value) =>
      !value ||
      (!value.startsWith('/') && !value.startsWith('\\') && !/^[A-Za-z]:/.test(value) && !value.includes('..')),
    'Report path must stay inside the repository',
  );

export const commandSchema = z.object({
  id: z.string().regex(/^[a-z][a-z0-9_-]*$/),
  label: z.string().min(1),
  argv: z.array(z.string()).min(1).max(40),
  required: z.boolean().default(true),
  kind: z.enum(['setup', 'build', 'lint', 'types', 'unit', 'integration', 'e2e', 'security', 'acceptance']),
  report: z.enum(['exit', 'junit', 'vitest', 'playwright', 'semgrep', 'gitleaks', 'npm-audit', 'pip-audit']),
  reportPath: relativeReportPath,
  timeoutSeconds: z.number().int().min(10).max(1800).default(600),
});
export type CheckCommand = z.infer<typeof commandSchema>;

export const deploymentSchema = z.object({
  enabled: z.boolean().default(false),
  environment: z.string().default('staging'),
  workflow: z.string().default('deploy.yml'),
  rollbackWorkflow: z.string().default('rollback.yml'),
  healthUrl: z.string().default(''),
  monitorIntervalSeconds: z.number().int().min(60).default(300),
});

export const reviewPolicySchema = z
  .object({
    mode: z.enum(['always', 'risk-based']).default('risk-based'),
    minimumRisk: z.enum(['low', 'medium', 'high']).default('medium'),
    sensitivePaths: z
      .array(z.string().min(1).max(300))
      .max(100)
      .default([
        '.github/workflows/**',
        '**/migrations/**',
        '**/auth/**',
        '**/security/**',
        '**/billing/**',
        '**/payments/**',
        '**/infra/**',
      ]),
    maxChangedFiles: z.number().int().min(1).max(100).default(8),
  })
  .default({
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
  });

export const testEvidencePolicySchema = z
  .object({
    requiredForSourceChanges: z.boolean().default(true),
    sourcePaths: z
      .array(z.string().min(1).max(300))
      .min(1)
      .max(100)
      .default(['src/**', 'app/**', 'apps/**', 'lib/**', 'packages/**/src/**']),
    testPaths: z
      .array(z.string().min(1).max(300))
      .min(1)
      .max(100)
      .default(['test/**', 'tests/**', '**/__tests__/**', '**/*.test.*', '**/*.spec.*']),
  })
  .default({
    requiredForSourceChanges: true,
    sourcePaths: ['src/**', 'app/**', 'apps/**', 'lib/**', 'packages/**/src/**'],
    testPaths: ['test/**', 'tests/**', '**/__tests__/**', '**/*.test.*', '**/*.spec.*'],
  });

export const repositorySchema = z
  .object({
    name: z.string().min(1).max(120),
    owner: z.string().regex(/^[\w.-]+$/),
    repo: z.string().regex(/^[\w.-]+$/),
    branch: z.string().min(1).default('main'),
    stack: z.enum(['typescript', 'python', 'custom']),
    standards: z.string().max(8000).default(''),
    checks: z.array(commandSchema).min(1).max(20),
    requiredCiChecks: z.array(z.string()).default([]),
    ciWaiver: z.string().default(''),
    protectedPaths: z.array(z.string()).default(['.github/workflows/', '.sdlc/']),
    review: reviewPolicySchema,
    testEvidence: testEvidencePolicySchema,
    deployment: deploymentSchema.default({
      enabled: false,
      environment: 'staging',
      workflow: 'deploy.yml',
      rollbackWorkflow: 'rollback.yml',
      healthUrl: '',
      monitorIntervalSeconds: 300,
    }),
  })
  .refine((repository) => new Set(repository.checks.map((check) => check.id)).size === repository.checks.length, {
    message: 'Quality gate IDs must be unique',
    path: ['checks'],
  });
export type RepositoryConfig = z.infer<typeof repositorySchema>;
export interface Repository extends RepositoryConfig {
  id: string;
  version: number;
  createdAt: string;
}

export const criterionSchema = z.object({
  id: z.string().min(1),
  description: z.string().min(1),
  evidence: z.enum(['test', 'review', 'human']),
  checkIds: z.array(z.string()),
  category: z.enum(['functional', 'security', 'performance', 'reliability', 'usability']),
});
export const contractSchema = z
  .object({
    summary: z.string().min(1),
    criteria: z.array(criterionSchema).min(1),
    nonGoals: z.array(z.string()),
    assumptions: z.array(z.string()),
    risks: z.array(z.string()),
    clarification: z.string().min(1).nullable(),
  })
  .refine((contract) => new Set(contract.criteria.map((criterion) => criterion.id)).size === contract.criteria.length, {
    message: 'Acceptance criterion IDs must be unique',
    path: ['criteria'],
  });
export type TaskContract = z.infer<typeof contractSchema>;

export const planSchema = z.object({
  source: z.literal('codex-plan-mode'),
  scope: z.string().min(1),
  steps: z.array(z.string()).min(1),
  dependencies: z.array(z.string()),
  estimatedEffort: z.string().min(1),
  costEstimate: z.string().min(1),
  schedule: z.array(z.string()).min(1),
  risks: z.array(z.string()),
});
export type Plan = z.infer<typeof planSchema>;

export const designSchema = z.object({
  architecture: z.string().min(1),
  apiContracts: z.array(z.string()),
  dataChanges: z.array(z.string()),
  uiBehavior: z.array(z.string()),
  security: z.array(z.string()),
  compatibility: z.string().min(1),
  testStrategy: z.string().min(1),
});
export type Design = z.infer<typeof designSchema>;

export const changeRiskSchema = z.object({
  level: z.enum(['low', 'medium', 'high']),
  rationale: z.string().min(1).max(2_000),
});
export type ChangeRisk = z.infer<typeof changeRiskSchema>;

export const specificationSchema = z.object({
  plan: planSchema,
  requirements: contractSchema,
  design: designSchema,
  risk: changeRiskSchema,
});
export type Specification = z.infer<typeof specificationSchema>;

export const findingSchema = z.object({
  id: z.string(),
  severity: z.enum(['critical', 'high', 'medium', 'low']),
  file: z.string(),
  line: z.number().int().nonnegative(),
  description: z.string(),
  correction: z.string(),
  criterionId: z.string().nullable(),
});
export const reviewSchema = z.object({
  source: z.literal('codex-native-review'),
  scope: z.enum(['uncommitted', 'base-branch', 'commit', 'custom']),
  summary: z.string().min(1),
  findings: z.array(findingSchema),
  criteria: z.array(z.object({ id: z.string(), satisfied: z.boolean(), evidence: z.string() })),
});
export type Review = z.infer<typeof reviewSchema>;

export const workspaceStateSchema = z.object({
  branch: z.string(),
  headSha: z.string().regex(/^[0-9a-f]{40}$/),
  digest: z.string().regex(/^[0-9a-f]{40}$/),
  dirty: z.boolean(),
  changes: z.array(z.string()).max(500),
});
export type WorkspaceState = z.infer<typeof workspaceStateSchema>;

export interface GateResult {
  id: string;
  label: string;
  status: 'pass' | 'fail' | 'error' | 'waived';
  required: boolean;
  candidateDigest: string;
  policyVersion: number;
  exitCode: number;
  tests: number | null;
  findings: string[];
  artifactId?: string;
  durationMs: number;
  cached?: boolean;
}

export interface ContextSource {
  id: string;
  title: string;
  version: number;
  hash: string;
  excerpt: string;
}

export interface Event {
  id: number;
  runId: string;
  time: string;
  kind: string;
  phase: Phase;
  message: string;
  data?: unknown;
}

export interface Artifact {
  id: string;
  runId: string;
  name: string;
  hash: string;
  candidateDigest: string;
  createdAt: string;
  content?: string;
}

export interface Run {
  id: string;
  repositoryId: string;
  prompt: string;
  backend: Backend;
  mode?: RunMode;
  status: Status;
  phase: Phase;
  step: string;
  attempt: number;
  createdAt: string;
  updatedAt: string;
  startedAt: string;
  workspace: WorkspaceState;
  candidateDigest?: string;
  candidateSha?: string;
  branch?: string;
  prUrl?: string;
  prNumber?: number;
  policy: Repository;
  context: ContextSource[];
  contract?: TaskContract;
  plan?: Plan;
  design?: Design;
  risk?: ChangeRisk;
  gates: GateResult[];
  review?: Review;
  reviewDecision?: { required: boolean; reasons: string[] };
  question?: string;
  answer?: string;
  blocker?: string;
  limits: { verifications: number };
  approval?: { digest: string; approvedBy?: string; approvedAt?: string; rejected?: boolean };
  deployment?: { workflowRunId?: number; rollbackSha?: string; releasedAt?: string; healthy?: boolean };
  lastFailureSignature?: string;
  repeatedFailures: number;
}

export interface Document {
  id: string;
  title: string;
  source: string;
  owner: string;
  content: string;
  version: number;
  hash: string;
  createdAt: string;
}

export interface Integration {
  id: string;
  name: string;
  url: string;
  allowedTools: string[];
  enabled: boolean;
  headersEnv: Record<string, string>;
  contextCalls: { tool: string; arguments: Record<string, unknown> }[];
}

export interface JobResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
  files: Record<string, string>;
  cached?: boolean;
}
