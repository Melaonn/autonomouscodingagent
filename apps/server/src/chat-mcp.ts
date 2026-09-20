import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import {
  contractSchema,
  designSchema,
  planSchema,
  reviewSchema,
  runModeSchema,
  type Artifact,
  type Event,
  type Repository,
  type Run,
} from '../../../shared/types.js';
import { executeCheck, inspectWorkspace, type InspectedWorkspace } from './workspace.js';

export interface ChatApi {
  request<T>(path: string, body?: unknown): Promise<T>;
}

type Detail = { run: Run; events: Event[]; artifacts: Artifact[] };
const runInput = { runId: z.string().uuid() };
const active = new Set(['running', 'repairing']);
const approvedPlanSchema = planSchema.omit({ source: true });
const nativeReviewSchema = reviewSchema.omit({ source: true, scope: true }).extend({
  scope: z.enum(['uncommitted', 'base-branch', 'commit', 'custom']).default('uncommitted'),
});

function nextAction(run: Run) {
  if (run.status === 'completed' && run.step === 'validated')
    return 'Report that validation completed without workspace changes or publication, with its recorded evidence.';
  if (run.status === 'needs_input') return 'Ask the user the exact question, then call sdlc_answer.';
  if (run.status === 'needs_review')
    return 'Ask the developer to type /review in this Codex project and choose Review uncommitted changes. Submit the native findings once with sdlc_review.';
  if (run.status === 'awaiting_approval')
    return 'Ask the user to approve or reject the exact deployment in the local dashboard.';
  if (run.status === 'repairing') return 'Fix the reported failures in this same checkout, then call sdlc_verify.';
  if (run.status !== 'running') return 'Report this exact status and its evidence. Do not claim a failed run passed.';
  if (run.phase === 'planning') return 'Retry sdlc_begin with the approved native plan.';
  if (run.phase === 'requirements' || run.phase === 'design')
    return 'Use the returned policy and company context, then submit requirements and design together with sdlc_spec.';
  if (run.phase === 'coding') return 'Implement in the current checkout, then call sdlc_verify.';
  if (run.phase === 'testing' && run.step === 'native-review')
    return 'Wait for Codex native /review findings, then call sdlc_review with their exact evidence.';
  if (run.phase === 'deployment' && run.step === 'publish')
    return 'Create a feature branch, commit and push the verified files, then call sdlc_publish.';
  if (run.phase === 'deployment' && run.step === 'remote-ci')
    return 'Required GitHub CI is running and the server is following it automatically.';
  return 'Continue the current lifecycle step. Read sdlc_status only when the user asks or recovery is needed.';
}

function summary(run: Run) {
  return {
    id: run.id,
    repository: `${run.policy.owner}/${run.policy.repo}`,
    prompt: run.prompt,
    mode: run.mode || 'delivery',
    status: run.status,
    phase: run.phase,
    step: run.step,
    verificationAttempt: run.attempt,
    candidateDigest: run.candidateDigest,
    candidateSha: run.candidateSha,
    prUrl: run.prUrl,
    question: run.question,
    blocker: run.blocker,
    updatedAt: run.updatedAt,
    nextAction: nextAction(run),
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

export function createChatServer(api: ChatApi) {
  const server = new McpServer(
    { name: 'sdlc', version: '0.4.0' },
    {
      instructions:
        'Use the low-ceremony path for feature and bug work: sdlc_begin once with the approved native plan, sdlc_spec once after reading returned company context, sdlc_verify after implementation, sdlc_review after native /review, and sdlc_publish after committing and pushing. Do not send manual progress updates or poll CI; the server handles both. Use status and recovery tools only when needed. Never start another Codex process, clone the repository, simulate Plan mode, or replace /review with an ad hoc review. Tool evidence, not model prose, decides completion. Deployment approval stays in the dashboard.',
    },
  );
  const result = (value: unknown) => ({
    content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }],
  });
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

  const beginRun = async (
    workspaceRoot: string,
    prompt: string,
    mode: 'delivery' | 'validation',
    plan: z.infer<typeof approvedPlanSchema>,
  ) => {
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
    assertProtectedPaths(workspace, repository);
    const created = await api.request<{ run: Run; reused: boolean }>('/api/runs', {
      repositoryId: repository.id,
      prompt,
      mode,
      workspace: {
        branch: workspace.branch,
        headSha: workspace.headSha,
        digest: workspace.digest,
        dirty: workspace.dirty,
        changes: workspace.changes,
      },
    });
    const run =
      created.run.phase === 'planning'
        ? await api.request<Run>(`/api/runs/${created.run.id}/plan`, { source: 'codex-plan-mode', ...plan })
        : created.run;
    return {
      reused: created.reused,
      ...summary(run),
      workspace: {
        root: workspace.root,
        branch: workspace.branch,
        startingCommit: run.workspace.headSha,
        dirtyAtStart: run.workspace.dirty,
        changesAtStart: run.workspace.changes,
      },
      policy: {
        version: run.policy.version,
        standards: run.policy.standards,
        checks: run.policy.checks.map((check) => ({ id: check.id, kind: check.kind, command: check.argv })),
        protectedPaths: run.policy.protectedPaths,
      },
      companyContext: run.context,
    };
  };

  server.registerTool(
    'sdlc_repositories',
    {
      description: 'List repositories governed by the local control plane and its readiness.',
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    () =>
      protect(async () => {
        const [repositories, readiness] = await Promise.all([
          api.request<Repository[]>('/api/repositories'),
          api.request<unknown>('/api/readiness'),
        ]);
        return {
          readiness,
          repositories: repositories.map((repository) => ({
            id: repository.id,
            repository: `${repository.owner}/${repository.repo}`,
            branch: repository.branch,
            checks: repository.checks.map((check) => check.id),
          })),
        };
      }),
  );

  server.registerTool(
    'sdlc_begin',
    {
      description:
        'Start or resume the governed run and record the approved native Codex plan in one call. Returns company context, policy and configured check IDs needed for the single specification call.',
      inputSchema: {
        workspaceRoot: z.string().min(1),
        prompt: z.string().min(10).max(100000),
        mode: runModeSchema.default('delivery'),
        plan: approvedPlanSchema,
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    ({ workspaceRoot, prompt, mode, plan }) => protect(() => beginRun(workspaceRoot, prompt, mode, plan)),
  );

  server.registerTool(
    'sdlc_spec',
    {
      description:
        'Record requirements and technical design together after reading the policy and company context returned by sdlc_begin. If a real stakeholder question remains, the run pauses before design.',
      inputSchema: { ...runInput, requirements: contractSchema, design: designSchema },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    ({ runId, requirements, design }) =>
      protect(async () => {
        let run = (await api.request<Detail>(`/api/runs/${runId}`)).run;
        if (run.phase === 'requirements') run = await api.request<Run>(`/api/runs/${runId}/requirements`, requirements);
        if (run.status === 'needs_input') return summary(run);
        if (run.phase === 'design') run = await api.request<Run>(`/api/runs/${runId}/design`, design);
        if (run.phase === 'planning') throw new Error('Call sdlc_begin with the approved native plan first');
        return summary(run);
      }),
  );

  server.registerTool(
    'sdlc_verify',
    {
      description:
        'Run every configured build, lint, type, test, and security check in the existing local checkout. Results are bound to its exact Git tree digest and returned for repair in this conversation.',
      inputSchema: { ...runInput, workspaceRoot: z.string().min(1) },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    ({ runId, workspaceRoot }, extra) =>
      protect(async () => {
        const detail = await api.request<Detail>(`/api/runs/${runId}`);
        const workspace = await inspectWorkspace(workspaceRoot);
        assertRepository(workspace, detail.run);
        assertProtectedPaths(workspace, detail.run.policy);
        const checks = detail.run.policy.checks;
        const results: { commandId: string; result: Awaited<ReturnType<typeof executeCheck>> }[] = new Array(
          checks.length,
        );
        let notificationStep = 0;
        const notify = async (message: string) => {
          const progressToken = extra._meta?.progressToken;
          if (progressToken === undefined) return;
          notificationStep += 1;
          await extra
            .sendNotification({
              method: 'notifications/progress',
              params: { progressToken, progress: notificationStep, total: checks.length * 2, message },
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
          const cacheNote = checkResult.cached ? ' using cached dependencies' : '';
          const message = `${command.label} ${outcome}${cacheNote} in ${(checkResult.durationMs / 1000).toFixed(1)}s`;
          await progress(command.id, message);
          await notify(message);
        };
        for (const index of checks.map((_, index) => index).filter((index) => checks[index].kind === 'setup')) {
          await runCheck(index);
        }
        const pending = checks.map((_, index) => index).filter((index) => checks[index].kind !== 'setup');
        let cursor = 0;
        const workers = Array.from({ length: Math.min(3, pending.length) }, async () => {
          while (cursor < pending.length) {
            const index = pending[cursor];
            cursor += 1;
            await runCheck(index);
          }
        });
        await Promise.all(workers);
        await eventQueue;
        const verified = await inspectWorkspace(workspace.root);
        assertProtectedPaths(verified, detail.run.policy);
        if (verified.digest !== workspace.digest)
          throw new Error(
            'Verification commands changed the workspace. Review the generated changes, keep or remove them intentionally, then run sdlc_verify again.',
          );
        const run = await api.request<Run>(`/api/runs/${runId}/verify`, {
          candidateDigest: verified.digest,
          results,
        });
        return {
          ...summary(run),
          workspaceChangedDuringChecks: false,
          gates: run.gates.map(({ id, status, durationMs, tests, findings, cached }) => ({
            id,
            status,
            durationMs,
            tests,
            findings,
            cached: cached || undefined,
          })),
        };
      }),
  );

  server.registerTool(
    'sdlc_review',
    {
      description:
        'Record the exact findings from Codex native /review once after all configured checks pass. Native provenance and uncommitted scope are applied automatically.',
      inputSchema: { ...runInput, review: nativeReviewSchema },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    ({ runId, review }) =>
      protect(async () =>
        summary(await api.request<Run>(`/api/runs/${runId}/review`, { source: 'codex-native-review', ...review })),
      ),
  );

  server.registerTool(
    'sdlc_publish',
    {
      description:
        'Publish a verified candidate after Codex has created a feature branch, committed the exact verified tree, and pushed it to origin. The control plane creates or updates the PR and follows CI.',
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
        if (!workspace.branch) throw new Error('Create a feature branch before publishing');
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
    'sdlc_runs',
    {
      description: 'Find recent native SDLC runs, including one from a resumed conversation.',
      inputSchema: { repository: z.string().optional() },
      annotations: { readOnlyHint: true },
    },
    ({ repository }) =>
      protect(async () =>
        (await api.request<Run[]>('/api/runs'))
          .filter(
            (run) => !repository || `${run.policy.owner}/${run.policy.repo}`.toLowerCase() === repository.toLowerCase(),
          )
          .slice(0, 20)
          .map(summary),
      ),
  );

  server.registerTool(
    'sdlc_status',
    {
      description:
        'Read lifecycle checkpoints, gates, native Codex review, activity and evidence. A bounded wait returns on change or after 20 seconds.',
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
        const deadline = Date.now() + waitSeconds * 1000;
        while (active.has(detail.run.status) && detail.run.updatedAt === version && Date.now() < deadline) {
          await new Promise((resolve) => setTimeout(resolve, Math.min(1000, deadline - Date.now())));
          detail = await api.request<Detail>(`/api/runs/${runId}`);
        }
        return {
          ...summary(detail.run),
          plan: detail.run.plan,
          requirements: detail.run.contract,
          design: detail.run.design,
          gates: detail.run.gates,
          review: detail.run.review,
          events: detail.events.slice(-12),
          artifacts: detail.artifacts.map((artifact) => ({
            id: artifact.id,
            name: artifact.name,
            hash: artifact.hash,
          })),
        };
      }),
  );

  server.registerTool(
    'sdlc_answer',
    {
      description: 'Submit the user answer to a pending clarification. Never invent a stakeholder decision.',
      inputSchema: { ...runInput, answer: z.string().min(1).max(10000) },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    ({ runId, answer }) =>
      protect(async () => summary(await api.request<Run>(`/api/runs/${runId}/answer`, { answer }))),
  );

  server.registerTool(
    'sdlc_cancel',
    {
      description: 'Cancel an active run only when the user asks to stop it.',
      inputSchema: runInput,
      annotations: { readOnlyHint: false, destructiveHint: true },
    },
    ({ runId }) => protect(async () => summary(await api.request<Run>(`/api/runs/${runId}/cancel`, {}))),
  );

  server.registerTool(
    'sdlc_resume',
    {
      description: 'Resume a failed or blocked run in this same native Codex conversation.',
      inputSchema: runInput,
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    ({ runId }) => protect(async () => summary(await api.request<Run>(`/api/runs/${runId}/resume`, {}))),
  );

  server.registerTool(
    'sdlc_report',
    {
      description: 'Read the evidence report. Failed or blocked checks must be disclosed.',
      inputSchema: runInput,
      annotations: { readOnlyHint: true },
    },
    ({ runId }) => protect(() => api.request<string>(`/api/runs/${runId}/report`)),
  );

  return server;
}
