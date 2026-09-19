import { z } from 'zod';
export const phases = ['planning', 'requirements', 'design', 'coding', 'testing', 'deployment', 'maintenance'] as const;
export type Phase = (typeof phases)[number];
export const backendSchema = z.literal('codex');
export type Backend = z.infer<typeof backendSchema>;
export type Status =
  | 'queued'
  | 'running'
  | 'repairing'
  | 'needs_input'
  | 'awaiting_approval'
  | 'blocked'
  | 'failed'
  | 'monitoring'
  | 'cancelled';
export type Role = 'admin' | 'operator' | 'viewer';
export interface User {
  login: string;
  role: Role;
}
export const commandSchema = z.object({
  id: z.string().regex(/^[a-z][a-z0-9_-]*$/),
  label: z.string().min(1),
  argv: z.array(z.string()).min(1).max(40),
  required: z.boolean().default(true),
  kind: z.enum(['setup', 'build', 'lint', 'types', 'unit', 'integration', 'e2e', 'security', 'acceptance']),
  report: z.enum(['exit', 'junit', 'vitest', 'playwright', 'semgrep', 'gitleaks', 'npm-audit', 'pip-audit']),
  reportPath: z.string().default(''),
  timeoutSeconds: z.number().int().min(10).max(1800).default(600),
  baselineAllowed: z.boolean().default(false),
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
export const repositorySchema = z.object({
  name: z.string().min(1).max(120),
  owner: z.string().regex(/^[\w.-]+$/),
  repo: z.string().regex(/^[\w.-]+$/),
  branch: z.string().min(1).default('main'),
  stack: z.enum(['typescript', 'python', 'custom']),
  standards: z.string().max(60000).default(''),
  checks: z.array(commandSchema).min(1),
  requiredCiChecks: z.array(z.string()).default([]),
  ciWaiver: z.string().default(''),
  protectedPaths: z.array(z.string()).default(['.github/workflows/', '.sdlc/']),
  deployment: deploymentSchema.default({
    enabled: false,
    environment: 'staging',
    workflow: 'deploy.yml',
    rollbackWorkflow: 'rollback.yml',
    healthUrl: '',
    monitorIntervalSeconds: 300,
  }),
});
export type RepositoryConfig = z.infer<typeof repositorySchema>;
export interface Repository extends RepositoryConfig {
  id: string;
  version: number;
  createdAt: string;
}
export const repoAnalysisSchema = z.object({
  name: z.string().min(1).max(120),
  stack: z.enum(['typescript', 'python', 'custom']),
  branch: z.string().min(1).default('main'),
  standards: z.string().max(60000).default(''),
  requiredCiChecks: z.array(z.string()).default([]),
  ciWaiver: z.string().default(''),
  workflow: z.string().default('deploy.yml'),
  rollbackWorkflow: z.string().default('rollback.yml'),
  environment: z.string().default('staging'),
  healthUrl: z.string().default(''),
  rationale: z.string().default(''),
});
export type RepoAnalysis = z.infer<typeof repoAnalysisSchema>;
export const criterionSchema = z.object({
  id: z.string().min(1),
  description: z.string().min(1),
  evidence: z.enum(['test', 'review', 'human']),
  checkIds: z.array(z.string()),
  category: z.enum(['functional', 'security', 'performance', 'reliability', 'usability']),
});
export const contractSchema = z.object({
  summary: z.string(),
  criteria: z.array(criterionSchema).min(1),
  nonGoals: z.array(z.string()),
  assumptions: z.array(z.string()),
  risks: z.array(z.string()),
  clarification: z.string().nullable(),
});
export type TaskContract = z.infer<typeof contractSchema>;
export const planSchema = z.object({
  scope: z.string(),
  steps: z.array(z.string()).min(1),
  dependencies: z.array(z.string()),
  estimatedEffort: z.string(),
  costEstimate: z.string(),
  schedule: z.array(z.string()),
  risks: z.array(z.string()),
});
export const designSchema = z.object({
  architecture: z.string(),
  apiContracts: z.array(z.string()),
  dataChanges: z.array(z.string()),
  uiBehavior: z.array(z.string()),
  security: z.array(z.string()),
  compatibility: z.string(),
  testStrategy: z.string(),
});
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
  summary: z.string(),
  findings: z.array(findingSchema),
  criteria: z.array(z.object({ id: z.string(), satisfied: z.boolean(), evidence: z.string() })),
});
export type Review = z.infer<typeof reviewSchema>;
export const acceptanceSchema = z.object({
  files: z.array(z.object({ path: z.string(), content: z.string() })).min(1),
  command: commandSchema,
  coveredCriteria: z.array(z.string()).min(1),
  explanation: z.string(),
});
export type Acceptance = z.infer<typeof acceptanceSchema>;
export interface GateResult {
  id: string;
  label: string;
  status: 'pass' | 'fail' | 'error' | 'waived';
  required: boolean;
  candidateSha: string;
  policyVersion: number;
  exitCode: number;
  tests: number | null;
  findings: string[];
  artifactId?: string;
  durationMs: number;
  baseline?: boolean;
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
  candidateSha: string;
  createdAt: string;
  content?: string;
}
export interface Run {
  id: string;
  repositoryId: string;
  prompt: string;
  backend: Backend;
  reviewer: Backend;
  status: Status;
  phase: Phase;
  step: string;
  attempt: number;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  baseSha?: string;
  candidateSha?: string;
  branch?: string;
  prUrl?: string;
  prNumber?: number;
  policy: Repository;
  context: ContextSource[];
  contract?: TaskContract;
  plan?: z.infer<typeof planSchema>;
  design?: z.infer<typeof designSchema>;
  acceptance?: Acceptance;
  baseline: GateResult[];
  gates: GateResult[];
  review?: Review;
  question?: string;
  answer?: string;
  blocker?: string;
  leaseUntil?: string;
  limits: { repairs: number; minutes: number; agentMinutes: number };
  usage: { inputTokens: number; outputTokens: number; costUsd: number | null };
  approval?: { digest: string; approvedBy?: string; approvedAt?: string; rejected?: boolean };
  deployment?: { workflowRunId?: number; rollbackSha?: string; releasedAt?: string; healthy?: boolean };
  parentRunId?: string;
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
export interface AgentResult {
  text: string;
  structured?: unknown;
  exitCode: number;
  usage: Run['usage'];
  logs: string;
}
export interface JobResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
  files: Record<string, string>;
}
