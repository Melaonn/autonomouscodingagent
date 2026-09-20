import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import {
  changeRiskSchema,
  contractSchema,
  designSchema,
  planSchema,
  repositorySchema,
  reviewSchema,
  type Artifact,
  type Event,
  type Repository,
  type Run,
  type TaskContract,
} from '../../../shared/types.js';
import { executeCheck, inspectWorkspace, type InspectedWorkspace } from './workspace.js';
import { configureRepositoryBootstrap, discoverRepository } from './repository-discovery.js';

export interface ChatApi {
  request<T>(path: string, body?: unknown): Promise<T>;
}

type Detail = { run: Run; events: Event[]; artifacts: Artifact[] };
const runInput = { runId: z.string().uuid() };
const active = new Set(['running', 'repairing']);
const checkpointText = z.string().trim().min(1).max(2_000);
const checkpointItem = z.string().trim().min(1).max(500);
const checkpointInputSchema = z.object({
  planSummary: checkpointText,
  planSteps: z.array(checkpointItem).min(1).max(12),
  requirementsSummary: checkpointText,
  acceptanceCriteria: z.array(checkpointItem).min(1).max(20),
  designSummary: checkpointText,
  testStrategy: checkpointText,
  risk: changeRiskSchema,
});
const nativeReviewSchema = z.object({
  scope: z.enum(['uncommitted', 'base-branch', 'commit', 'custom']).default('uncommitted'),
  summary: reviewSchema.shape.summary,
  findings: reviewSchema.shape.findings,
});
const setupDecisionSchema = z.object({
  e2e: z.enum(['required', 'not_applicable']).default('required'),
  ci: z.enum(['create', 'preserve', 'waive']).default('create'),
  requiredCiChecks: z.array(z.string().trim().min(1).max(200)).max(20).default([]),
  ciWaiver: z.string().trim().max(1_000).default(''),
  deployment: z.enum(['disabled', 'create', 'preserve']).default('disabled'),
  deploymentTarget: z.string().trim().max(200).default(''),
  healthUrl: z.string().trim().max(2_000).default(''),
});

function nextAction(run: Run) {
  if (run.status === 'completed') return 'Report completion with the recorded evidence.';
  if (run.status === 'needs_review')
    return 'Ask the developer to run native /review for uncommitted changes, then submit its findings with sdlc_review.';
  if (run.status === 'awaiting_approval') return 'Deployment approval is waiting in the local dashboard.';
  if (run.status === 'repairing')
    return 'Fix only the reported failures, then call sdlc_verify again without a checkpoint.';
  if (run.status !== 'running') return `Report that the governed run is ${run.status}.`;
  if (run.phase === 'planning') return 'Finish native Plan mode, implement the accepted plan, then call sdlc_verify.';
  if (run.phase === 'coding')
    return 'Implement locally, then call sdlc_verify. Do not duplicate the configured full gate suite.';
  if (run.phase === 'deployment' && run.step === 'publish')
    return 'Create a codex/ branch, commit and push the verified tree, then call sdlc_publish.';
  if (run.phase === 'deployment' && run.step === 'remote-ci') return 'Remote CI is being followed automatically.';
  return 'Continue the current lifecycle step.';
}

function summary(run: Run) {
  return {
    runId: run.id,
    status: run.status,
    phase: run.phase,
    step: run.step,
    attempt: run.attempt,
    candidateDigest: run.candidateDigest,
    candidateSha: run.candidateSha,
    prUrl: run.prUrl,
    blocker: run.blocker,
    review: run.reviewDecision,
    next: nextAction(run),
  };
}

function assertRepository(workspace: InspectedWorkspace, run: Run | Repository) {
  const owner = 'policy' in run ? run.policy.owner : run.owner;
  const repo = 'policy' in run ? run.policy.repo : run.repo;
  if (workspace.owner.toLowerCase() !== owner.toLowerCase() || workspace.repo.toLowerCase() !== repo.toLowerCase())
    throw new Error(`Workspace ${workspace.owner}/${workspace.repo} does not match ${owner}/${repo}`);
}

function assertProtectedPaths(workspace: InspectedWorkspace, repository: Repository) {
  const prefixes = repository.protectedPaths.map((prefix) => prefix.replaceAll('\\', '/').replace(/^\.\//, ''));
  const bootstrapFiles = new Set(
    repository.setup?.status === 'bootstrapping'
      ? repository.setup.tasks
          .flatMap((task) => task.files)
          .map((path) => path.replaceAll('\\', '/').replace(/^\.\//, '').replace(/\/$/, ''))
      : [],
  );
  const changed = workspace.changedPaths.find((path) => {
    const normalized = path.replaceAll('\\', '/').replace(/^\.\//, '');
    const protectedPath = prefixes.some(
      (prefix) => normalized === prefix.replace(/\/$/, '') || normalized.startsWith(prefix),
    );
    return protectedPath && !bootstrapFiles.has(normalized);
  });
  if (changed) throw new Error(`Protected policy path is modified: ${changed}`);
}

function testGateIds(policy: Repository) {
  const testGateIds = policy.checks
    .filter((check) => check.required && ['unit', 'integration', 'e2e'].includes(check.kind))
    .map((check) => check.id);
  if (!testGateIds.length)
    throw new Error(
      'Repository policy needs a required unit, integration, or E2E gate for test-backed acceptance criteria',
    );
  return testGateIds;
}

function expandCheckpoint(checkpoint: z.infer<typeof checkpointInputSchema>, policy: Repository) {
  const checkIds = testGateIds(policy);
  const plan = planSchema.parse({
    source: 'codex-plan-mode',
    scope: checkpoint.planSummary,
    steps: checkpoint.planSteps,
    dependencies: [],
    estimatedEffort: 'Defined in native Plan mode',
    costEstimate: 'Not estimated by the control plane',
    schedule: ['Implementation', 'Automated verification'],
    risks: [checkpoint.risk.rationale],
  });
  const requirements: TaskContract = contractSchema.parse({
    summary: checkpoint.requirementsSummary,
    clarification: null,
    criteria: checkpoint.acceptanceCriteria.map((description, index) => ({
      id: `AC-${index + 1}`,
      category: 'functional',
      description,
      evidence: 'test',
      checkIds,
    })),
    nonGoals: [],
    assumptions: [],
    risks: [checkpoint.risk.rationale],
  });
  const design = designSchema.parse({
    architecture: checkpoint.designSummary,
    apiContracts: [],
    dataChanges: [],
    uiBehavior: [],
    security: [],
    compatibility: 'Preserve existing behavior outside the accepted request.',
    testStrategy: checkpoint.testStrategy,
  });
  return { plan, requirements, design, risk: checkpoint.risk };
}

export function createChatServer(api: ChatApi) {
  const server = new McpServer(
    { name: 'sdlc', version: '0.8.0' },
    {
      instructions:
        'Call sdlc_start before repository inspection in native Plan mode. On first use it returns an SDLC capability inventory and questions. Explain the gaps and ask only those questions. Call it again with confirmSetup=true and setupDecision; include every returned bootstrap task in the native plan, then create the missing infrastructure in the same checkout after plan acceptance. Verification will reject placeholder or missing gates. After implementation, call sdlc_verify with a compact lifecycle checkpoint. Use /review only when policy requires it. Publish only the verified tree. Deployment approval remains in the dashboard.',
    },
  );
  const result = (value: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(value) }] });
  const protect = async (action: () => Promise<unknown>) => {
    try {
      return result(await action());
    } catch (error) {
      return {
        ...result({ error: error instanceof Error ? error.message : 'Harness operation failed' }),
        isError: true,
      };
    }
  };

  server.registerTool(
    'sdlc_start',
    {
      description: 'Start or resume; first use inventories SDLC gaps.',
      inputSchema: {
        workspaceRoot: z.string().min(1),
        prompt: z.string().min(10).max(100_000),
        confirmSetup: z.boolean().default(false),
        setupDecision: setupDecisionSchema.optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    ({ workspaceRoot, prompt, confirmSetup, setupDecision }) =>
      protect(async () => {
        const workspace = await inspectWorkspace(workspaceRoot);
        const repositories = await api.request<Repository[]>('/api/repositories');
        let repository = repositories.find(
          (candidate) =>
            candidate.owner.toLowerCase() === workspace.owner.toLowerCase() &&
            candidate.repo.toLowerCase() === workspace.repo.toLowerCase(),
        );
        let questions: string[] = [];
        if (!repository) {
          const discovery = await discoverRepository(workspace);
          repository = await api.request<Repository>('/api/repositories', discovery.repository);
          questions = discovery.questions;
        }
        if (repository.setup?.status === 'needs_confirmation' && !confirmSetup)
          return {
            status: 'needs_input',
            phase: 'planning',
            setupRequired: true,
            repository: `${repository.owner}/${repository.repo}`,
            detected: {
              stack: repository.stack,
              confidence: repository.setup.confidence,
              baseBranch: repository.branch,
              gates: repository.checks.map(({ id, label, kind, argv }) => ({ id, label, kind, argv })),
              requiredCiChecks: repository.requiredCiChecks,
              ciWaiver: repository.ciWaiver,
              deployment: repository.deployment,
              evidence: repository.setup.evidence,
              warnings: repository.setup.warnings,
              capabilities: repository.setup.capabilities,
              bootstrapTasks: repository.setup.tasks.map(({ id, title, reason, checkIds }) => ({
                id,
                title,
                reason,
                checkIds,
              })),
            },
            questions: questions.length
              ? questions
              : [
                  `Is the detected ${repository.stack} stack and gate list correct?`,
                  'Should the saved remote-CI waiver remain, or should required GitHub check names be configured?',
                  'Should delivery stop after pull-request CI, or should deployment be configured in the dashboard?',
                ],
            next: 'Explain the detected capabilities and gaps, ask the listed questions, then call sdlc_start again with confirmSetup=true and setupDecision. Do not edit the checkout before the native plan is accepted.',
          };
        if (repository.setup && ['needs_confirmation', 'reviewed'].includes(repository.setup.status)) {
          if (repository.setup.status === 'needs_confirmation' && !confirmSetup)
            throw new Error('Confirm the detected setup before starting the run');
          if (
            repository.stack === 'custom' &&
            !repository.checks.some((check) => ['unit', 'integration', 'e2e'].includes(check.kind))
          )
            throw new Error(
              'The custom stack needs at least one executable unit, integration, or E2E command. Add it in the auto-filled dashboard policy, then continue.',
            );
          const reviewedDecision =
            repository.setup.status === 'reviewed' && !setupDecision
              ? {
                  ci: repository.requiredCiChecks.length
                    ? ('preserve' as const)
                    : repository.ciWaiver && !repository.ciWaiver.startsWith('Automatic setup')
                      ? ('waive' as const)
                      : ('create' as const),
                  requiredCiChecks: repository.requiredCiChecks,
                  ciWaiver: repository.ciWaiver,
                  deployment: repository.deployment.enabled ? ('preserve' as const) : ('disabled' as const),
                  deploymentTarget: repository.deployment.target,
                  healthUrl: repository.deployment.healthUrl,
                }
              : setupDecision;
          const configured = configureRepositoryBootstrap(repositorySchema.parse(repository), reviewedDecision);
          repository = await api.request<Repository>('/api/repositories', {
            ...configured,
          });
        }
        if (repository.standards.length > 8_000)
          throw new Error('Repository standards exceed 8,000 characters; move scoped guidance into Company Knowledge');
        assertProtectedPaths(workspace, repository);
        const created = await api.request<{ run: Run; reused: boolean }>('/api/runs', {
          repositoryId: repository.id,
          prompt,
          mode: 'delivery',
          workspace: {
            branch: workspace.branch,
            headSha: workspace.headSha,
            digest: workspace.digest,
            dirty: workspace.dirty,
            changes: workspace.changes,
          },
        });
        return {
          ...summary(created.run),
          reused: created.reused,
          repository: `${repository.owner}/${repository.repo}`,
          startingCommit: created.run.workspace.headSha,
          existingChanges: created.run.workspace.changes,
          rules: {
            standards: created.run.policy.standards,
            protectedPaths: created.run.policy.protectedPaths,
            testPaths: created.run.policy.testEvidence.requiredForSourceChanges
              ? created.run.policy.testEvidence.testPaths
              : [],
          },
          context: created.run.context,
          bootstrap:
            created.run.policy.setup?.status === 'bootstrapping'
              ? {
                  status: 'required',
                  instruction:
                    'Include these tasks in the native plan and implement them before feature verification. Preserve ready capabilities and use repository-appropriate maintained tools.',
                  capabilities: created.run.policy.setup.capabilities,
                  tasks: created.run.policy.setup.tasks,
                }
              : { status: 'ready', tasks: [] },
        };
      }),
  );

  server.registerTool(
    'sdlc_verify',
    {
      description: 'Record the accepted checkpoint and run configured gates.',
      inputSchema: {
        ...runInput,
        workspaceRoot: z.string().min(1),
        checkpoint: checkpointInputSchema.optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    ({ runId, workspaceRoot, checkpoint }, extra) =>
      protect(async () => {
        let detail = await api.request<Detail>(`/api/runs/${runId}`);
        if (detail.run.phase === 'planning') {
          if (!checkpoint) throw new Error('The first verification requires the accepted lifecycle checkpoint');
          await api.request<Run>(`/api/runs/${runId}/specification`, expandCheckpoint(checkpoint, detail.run.policy));
          detail = await api.request<Detail>(`/api/runs/${runId}`);
        } else if (checkpoint) {
          throw new Error('Lifecycle checkpoint is already recorded; omit it on repair verification');
        }
        if (detail.run.phase !== 'coding') throw new Error(`Run is not ready for verification (${detail.run.step})`);

        const workspace = await inspectWorkspace(workspaceRoot);
        assertRepository(workspace, detail.run);
        assertProtectedPaths(workspace, detail.run.policy);
        const checks = detail.run.policy.checks;
        const results: { commandId: string; result: Awaited<ReturnType<typeof executeCheck>> }[] = new Array(
          checks.length,
        );
        let progressStep = 0;
        const notify = async (message: string) => {
          const progressToken = extra._meta?.progressToken;
          if (progressToken === undefined) return;
          progressStep += 1;
          await extra
            .sendNotification({
              method: 'notifications/progress',
              params: { progressToken, progress: progressStep, total: checks.length * 2, message },
            })
            .catch(() => undefined);
        };
        let eventQueue = Promise.resolve<unknown>(undefined);
        const progress = (step: string, message: string) => {
          eventQueue = eventQueue.then(() =>
            api.request(`/api/runs/${runId}/progress`, { phase: 'testing', step, message }),
          );
          return eventQueue;
        };
        const runCheck = async (index: number) => {
          const command = checks[index];
          await notify(`Starting ${command.label}`);
          await progress(command.id, `Running ${command.label}`);
          const checkResult = await executeCheck(workspace.root, command);
          results[index] = { commandId: command.id, result: checkResult };
          const outcome = checkResult.exitCode === 0 ? 'passed' : 'failed';
          await progress(command.id, `${command.label} ${outcome} in ${(checkResult.durationMs / 1_000).toFixed(1)}s`);
          await notify(`${command.label} ${outcome}`);
        };

        for (const index of checks.map((_, index) => index).filter((index) => checks[index].kind === 'setup'))
          await runCheck(index);
        const pending = checks.map((_, index) => index).filter((index) => checks[index].kind !== 'setup');
        let cursor = 0;
        const workers = Array.from({ length: Math.min(3, pending.length) }, async () => {
          while (cursor < pending.length) {
            const index = pending[cursor++];
            await runCheck(index);
          }
        });
        await Promise.all(workers);
        await eventQueue;

        const verified = await inspectWorkspace(workspace.root);
        assertProtectedPaths(verified, detail.run.policy);
        if (verified.digest !== workspace.digest)
          throw new Error('A verification command changed the workspace; inspect those changes before verifying again');
        const run = await api.request<Run>(`/api/runs/${runId}/verify`, {
          candidateDigest: verified.digest,
          changedPaths: verified.changedPaths,
          results,
        });
        const failed = run.gates
          .filter((gate) => gate.required && gate.status !== 'pass')
          .map(({ id, status, findings }) => ({ id, status, findings }));
        let setupStatus = run.policy.setup?.status;
        if (!failed.length && run.policy.setup?.status === 'bootstrapping') {
          const completed = await api.request<Repository>('/api/repositories', {
            ...run.policy,
            setup: {
              ...run.policy.setup,
              status: 'ready',
              capabilities: run.policy.setup.capabilities.map((item) =>
                ['missing', 'partial'].includes(item.status) ? { ...item, status: 'ready' as const } : item,
              ),
              tasks: run.policy.setup.tasks.map((item) => ({ ...item, status: 'verified' as const })),
            },
          });
          setupStatus = completed.setup?.status;
        }
        return {
          ...summary(run),
          setup: setupStatus,
          verification: failed.length
            ? { failed, passed: run.gates.filter((gate) => gate.status === 'pass').length }
            : {
                passed: run.gates.map((gate) => gate.id),
                durationMs: run.gates.reduce((total, gate) => total + gate.durationMs, 0),
                cached: run.gates.filter((gate) => gate.cached).map((gate) => gate.id),
              },
        };
      }),
  );

  server.registerTool(
    'sdlc_review',
    {
      description: 'Record required native review findings.',
      inputSchema: { ...runInput, review: nativeReviewSchema },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    ({ runId, review }) =>
      protect(async () => {
        const detail = await api.request<Detail>(`/api/runs/${runId}`);
        const criteria = (detail.run.contract?.criteria || []).map((criterion) => {
          const blockingFinding = review.findings.find(
            (finding) => finding.criterionId === criterion.id && ['critical', 'high'].includes(finding.severity),
          );
          if (criterion.evidence === 'test') {
            const gates = criterion.checkIds.filter((id) =>
              detail.run.gates.some((gate) => gate.id === id && gate.status === 'pass'),
            );
            return {
              id: criterion.id,
              satisfied: gates.length === criterion.checkIds.length && !blockingFinding,
              evidence: gates.length ? `Passing gates: ${gates.join(', ')}` : '',
            };
          }
          if (criterion.evidence === 'human')
            return { id: criterion.id, satisfied: Boolean(detail.run.answer), evidence: detail.run.answer || '' };
          return {
            id: criterion.id,
            satisfied: !blockingFinding,
            evidence: blockingFinding ? '' : review.summary,
          };
        });
        const run = await api.request<Run>(`/api/runs/${runId}/review`, {
          source: 'codex-native-review',
          ...review,
          criteria,
        });
        return { ...summary(run), findings: review.findings.length };
      }),
  );

  server.registerTool(
    'sdlc_publish',
    {
      description: 'Publish the verified branch and follow PR checks.',
      inputSchema: { ...runInput, workspaceRoot: z.string().min(1) },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    ({ runId, workspaceRoot }) =>
      protect(async () => {
        const detail = await api.request<Detail>(`/api/runs/${runId}`);
        const workspace = await inspectWorkspace(workspaceRoot);
        assertRepository(workspace, detail.run);
        assertProtectedPaths(workspace, detail.run.policy);
        if (workspace.dirty) throw new Error('Commit the verified workspace before publishing');
        if (!workspace.branch) throw new Error('Create a codex/ feature branch before publishing');
        return summary(
          await api.request<Run>(`/api/runs/${runId}/publish`, {
            candidateDigest: workspace.digest,
            candidateSha: workspace.headSha,
            branch: workspace.branch,
          }),
        );
      }),
  );

  server.registerTool(
    'sdlc_status',
    {
      description: 'Read run status for recovery.',
      inputSchema: {
        ...runInput,
        waitSeconds: z.number().int().min(0).max(20).default(0),
        afterUpdatedAt: z.string().optional(),
      },
      annotations: { readOnlyHint: true },
    },
    ({ runId, waitSeconds, afterUpdatedAt }) =>
      protect(async () => {
        let detail = await api.request<Detail>(`/api/runs/${runId}`);
        const version = afterUpdatedAt || detail.run.updatedAt;
        const deadline = Date.now() + waitSeconds * 1_000;
        while (active.has(detail.run.status) && detail.run.updatedAt === version && Date.now() < deadline) {
          await new Promise((resolve) => setTimeout(resolve, Math.min(1_000, deadline - Date.now())));
          detail = await api.request<Detail>(`/api/runs/${runId}`);
        }
        return {
          ...summary(detail.run),
          updatedAt: detail.run.updatedAt,
          failedGates: detail.run.gates
            .filter((gate) => gate.required && gate.status !== 'pass')
            .map(({ id, status, findings }) => ({ id, status, findings })),
        };
      }),
  );

  return server;
}
