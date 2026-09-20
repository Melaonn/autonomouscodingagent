import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import {
  changeRiskSchema,
  contractSchema,
  criterionSchema,
  designSchema,
  planSchema,
  reviewSchema,
  type Artifact,
  type Event,
  type Repository,
  type Run,
  type TaskContract,
} from '../../../shared/types.js';
import { executeCheck, inspectWorkspace, type InspectedWorkspace } from './workspace.js';

export interface ChatApi {
  request<T>(path: string, body?: unknown): Promise<T>;
}

type Detail = { run: Run; events: Event[]; artifacts: Artifact[] };
const runInput = { runId: z.string().uuid() };
const active = new Set(['running', 'repairing']);
const approvedPlanSchema = planSchema.omit({ source: true });
const acceptanceCriterionInputSchema = criterionSchema.omit({ checkIds: true, evidence: true });
const requirementsInputSchema = z.object({
  summary: contractSchema.shape.summary,
  criteria: z.array(acceptanceCriterionInputSchema).min(1),
  nonGoals: contractSchema.shape.nonGoals,
  assumptions: contractSchema.shape.assumptions,
  risks: contractSchema.shape.risks,
});
const specificationInputSchema = z.object({
  plan: approvedPlanSchema,
  requirements: requirementsInputSchema,
  design: designSchema,
  risk: changeRiskSchema,
});
const nativeReviewSchema = z.object({
  scope: z.enum(['uncommitted', 'base-branch', 'commit', 'custom']).default('uncommitted'),
  summary: reviewSchema.shape.summary,
  findings: reviewSchema.shape.findings,
});

function nextAction(run: Run) {
  if (run.status === 'completed') return 'Report completion with the recorded evidence.';
  if (run.status === 'needs_review')
    return 'Ask the developer to run native /review for uncommitted changes, then submit its findings with sdlc_review.';
  if (run.status === 'awaiting_approval') return 'Deployment approval is waiting in the local dashboard.';
  if (run.status === 'repairing')
    return 'Fix only the reported failures, then call sdlc_verify again without a specification.';
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
  const changed = workspace.changedPaths.find((path) => {
    const normalized = path.replaceAll('\\', '/').replace(/^\.\//, '');
    return prefixes.some((prefix) => normalized === prefix.replace(/\/$/, '') || normalized.startsWith(prefix));
  });
  if (changed) throw new Error(`Protected policy path is modified: ${changed}`);
}

function bindAcceptanceEvidence(
  requirements: z.infer<typeof requirementsInputSchema>,
  policy: Repository,
): TaskContract {
  const testGateIds = policy.checks
    .filter((check) => check.required && ['unit', 'integration', 'e2e'].includes(check.kind))
    .map((check) => check.id);
  if (!testGateIds.length)
    throw new Error(
      'Repository policy needs a required unit, integration, or E2E gate for test-backed acceptance criteria',
    );
  return contractSchema.parse({
    ...requirements,
    clarification: null,
    criteria: requirements.criteria.map((criterion) => ({
      ...criterion,
      evidence: 'test',
      checkIds: testGateIds,
    })),
  });
}

export function createChatServer(api: ChatApi) {
  const server = new McpServer(
    { name: 'sdlc', version: '0.5.0' },
    {
      instructions:
        'Use sdlc_start once during native Plan mode to retrieve bounded company context. After implementation, call sdlc_verify once with the accepted specification; it records lifecycle evidence and runs every configured gate. Do not manually repeat the full configured gate suite. Low-risk changes proceed without a separate review when repository policy allows it. If native review is required, use /review and submit only its findings with sdlc_review. Publish only the exact verified tree with sdlc_publish. Deployment approval remains in the dashboard.',
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
      description:
        'Start or resume one governed run in the current checkout during native Plan mode. Returns only bounded relevant company context, repository rules, and gate IDs.',
      inputSchema: {
        workspaceRoot: z.string().min(1),
        prompt: z.string().min(10).max(100_000),
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    ({ workspaceRoot, prompt }) =>
      protect(async () => {
        const workspace = await inspectWorkspace(workspaceRoot);
        const repositories = await api.request<Repository[]>('/api/repositories');
        const repository = repositories.find(
          (candidate) =>
            candidate.owner.toLowerCase() === workspace.owner.toLowerCase() &&
            candidate.repo.toLowerCase() === workspace.repo.toLowerCase(),
        );
        if (!repository)
          throw new Error(
            `Repository ${workspace.owner}/${workspace.repo} is not configured. Add it in the dashboard first.`,
          );
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
          policy: {
            version: created.run.policy.version,
            standards: created.run.policy.standards,
            protectedPaths: created.run.policy.protectedPaths,
            gates: created.run.policy.checks.map(({ id, label, kind }) => ({ id, label, kind })),
            review: created.run.policy.review,
          },
          context: created.run.context,
        };
      }),
  );

  server.registerTool(
    'sdlc_verify',
    {
      description:
        'Record the accepted specification on the first call and run all configured gates in the current checkout. On repair calls, omit specification. Returns only failures or a compact pass summary.',
      inputSchema: {
        ...runInput,
        workspaceRoot: z.string().min(1),
        specification: specificationInputSchema.optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    ({ runId, workspaceRoot, specification }, extra) =>
      protect(async () => {
        let detail = await api.request<Detail>(`/api/runs/${runId}`);
        if (detail.run.phase === 'planning') {
          if (!specification) throw new Error('The first verification requires the accepted specification');
          await api.request<Run>(`/api/runs/${runId}/specification`, {
            ...specification,
            plan: { source: 'codex-plan-mode', ...specification.plan },
            requirements: bindAcceptanceEvidence(specification.requirements, detail.run.policy),
          });
          detail = await api.request<Detail>(`/api/runs/${runId}`);
        } else if (specification) {
          throw new Error('Specification is already recorded; omit it on repair verification');
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
        return {
          ...summary(run),
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
      description:
        'Record exact findings from required native /review. Test-backed acceptance evidence is derived from verified gates.',
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
      description:
        'Publish after committing and pushing the exact verified tree on a codex/ branch. The server creates or updates the PR and follows required CI.',
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
      description: 'Read a compact run status only for recovery or an explicit status request.',
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
