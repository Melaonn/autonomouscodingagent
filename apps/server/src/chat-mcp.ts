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
const requirementTraceSchema = z.object({
  sourceQuote: z.string().trim().min(3).max(500),
  requirement: checkpointItem,
  acceptanceCriterion: checkpointItem,
  testEvidence: checkpointItem,
});
const checkpointInputSchema = z.object({
  planSummary: checkpointText,
  planSteps: z.array(checkpointItem).min(1).max(12),
  requirementsSummary: checkpointText,
  requirementCoverage: z.array(requirementTraceSchema).min(1).max(20),
  designSummary: checkpointText,
  testStrategy: checkpointText,
  risk: changeRiskSchema,
});
const reviewCriterionSchema = z.object({
  id: z.string().trim().min(1).max(100),
  satisfied: z.boolean(),
  evidence: z.string().trim().min(1).max(2_000),
});
const requestCoverageSchema = reviewSchema.shape.requestCoverage;
const nativeReviewSchema = z.object({
  scope: z.enum(['uncommitted', 'base-branch', 'commit', 'custom']).default('uncommitted'),
  summary: reviewSchema.shape.summary,
  findings: reviewSchema.shape.findings,
  criteria: z.array(reviewCriterionSchema).min(1).max(30),
  requestCoverage: requestCoverageSchema,
});
export type NativeReview = z.infer<typeof nativeReviewSchema>;
type RequestCoverage = z.infer<typeof requestCoverageSchema>[number];
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

const traceBoundaries = new Set([
  'after',
  'and',
  'before',
  'but',
  'except',
  'if',
  'including',
  'or',
  'unless',
  'until',
  'when',
  'while',
  'with',
  'without',
]);
const traceStopWords = new Set([
  'add',
  'allow',
  'also',
  'any',
  'are',
  'been',
  'being',
  'both',
  'can',
  'change',
  'could',
  'described',
  'does',
  'doing',
  'each',
  'ensure',
  'existing',
  'expected',
  'fix',
  'from',
  'further',
  'have',
  'having',
  'here',
  'implement',
  'into',
  'just',
  'made',
  'make',
  'makes',
  'might',
  'more',
  'most',
  'must',
  'need',
  'once',
  'only',
  'other',
  'over',
  'preserve',
  'recommended',
  'reported',
  'request',
  'same',
  'should',
  'some',
  'such',
  'support',
  'than',
  'that',
  'their',
  'them',
  'then',
  'there',
  'these',
  'they',
  'this',
  'those',
  'through',
  'under',
  'using',
  'very',
  'want',
  'were',
  'what',
  'where',
  'which',
  'will',
  'would',
]);
const traceSegmenter = new Intl.Segmenter('en', { granularity: 'word' });

function stemTraceTerm(value: string) {
  if (value.length > 5 && value.endsWith('ies')) return `${value.slice(0, -3)}y`;
  if (value.length > 7 && value.endsWith('ation')) return `${value.slice(0, -5)}ate`;
  if (value.length > 6 && value.endsWith('ated')) return `${value.slice(0, -4)}ate`;
  if (value.length > 7 && value.endsWith('ating')) return `${value.slice(0, -5)}ate`;
  if (value.length > 6 && value.endsWith('ing')) return value.slice(0, -3);
  if (value.length > 5 && value.endsWith('ed')) return value.slice(0, -2);
  if (value.length > 5 && value.endsWith('es')) return value.slice(0, -2);
  if (value.length > 4 && value.endsWith('s')) return value.slice(0, -1);
  return value;
}

function traceClauses(value: string) {
  const clauses: string[][] = [[]];
  for (const chunk of value.split(/\s+/)) {
    if (chunk.startsWith('http://') || chunk.startsWith('https://')) continue;
    for (const segment of traceSegmenter.segment(chunk)) {
      if (!segment.isWordLike) continue;
      const word = segment.segment.toLocaleLowerCase('en');
      if (traceBoundaries.has(word)) {
        if (clauses.at(-1)?.length) clauses.push([]);
        continue;
      }
      if (word.length < 4 || traceStopWords.has(word)) continue;
      const term = stemTraceTerm(word);
      if (!clauses.at(-1)?.includes(term)) clauses.at(-1)?.push(term);
    }
  }
  return clauses.filter((clause) => clause.length);
}

export function omittedTraceTerms(sourceQuote: string, trace: string) {
  const target = new Set(traceClauses(trace).flat());
  return traceClauses(sourceQuote).flatMap((clause) => {
    const represented = clause.filter((term) => target.has(term));
    const required = Math.max(1, Math.ceil(clause.length / 2));
    return represented.length >= required ? [] : clause.filter((term) => !target.has(term));
  });
}

function sourceQuoteIssue(prompt: string, sourceQuote: string) {
  const normalizedPrompt = normalizedTrace(prompt);
  const quote = normalizedTrace(sourceQuote);
  return normalizedPrompt.includes(quote)
    ? null
    : `Source quote is not present in the original request: ${sourceQuote}`;
}

export function normalizeNativeReview(
  prompt: string,
  expectedCriteria: TaskContract['criteria'],
  review: NativeReview,
) {
  const parsed = nativeReviewSchema.parse(review);
  const findings = [...parsed.findings];
  const seen = new Set<string>();
  const requestCoverage = parsed.requestCoverage.map((coverage, index) => {
    const quote = normalizedTrace(coverage.sourceQuote);
    const quoteIssue = sourceQuoteIssue(prompt, coverage.sourceQuote);
    const duplicate = seen.has(quote);
    seen.add(quote);
    const omitted = omittedTraceTerms(coverage.sourceQuote, `${coverage.requirement} ${coverage.evidence}`);
    const issue = quoteIssue || (duplicate ? `Source quote is duplicated: ${coverage.sourceQuote}` : null);
    const evidenceIssue = omitted.length ? `Review trace omits material request terms: ${omitted.join(', ')}` : null;
    if (!issue && !evidenceIssue) return coverage;
    findings.push({
      id: `TRACE-${index + 1}`,
      severity: 'high',
      file: coverage.file,
      line: coverage.line,
      description: issue || evidenceIssue || 'Review trace is incomplete.',
      correction: `Re-evaluate the complete requirement in the original request: ${coverage.sourceQuote}`,
      criterionId: null,
    });
    return {
      ...coverage,
      status: 'unverified' as const,
      evidence: `${coverage.evidence} Controller validation: ${issue || evidenceIssue}`,
    };
  });

  for (const criterion of expectedCriteria) {
    if (!criterion.sourceQuote) continue;
    const quote = normalizedTrace(criterion.sourceQuote);
    if (seen.has(quote)) continue;
    const missing: RequestCoverage = {
      sourceQuote: criterion.sourceQuote,
      requirement: criterion.requirement || criterion.description,
      status: 'unverified',
      evidence: `The native review omitted accepted requirement ${criterion.id}.`,
      file: '',
      line: 0,
    };
    requestCoverage.push(missing);
    findings.push({
      id: `TRACE-${requestCoverage.length}`,
      severity: 'high',
      file: '',
      line: 0,
      description: `Native review omitted accepted requirement ${criterion.id}: ${criterion.sourceQuote}`,
      correction: 'Review the implementation and focused test evidence for this complete request clause.',
      criterionId: criterion.id,
    });
  }

  requestCoverage.forEach((coverage, index) => {
    if (coverage.status === 'satisfied') return;
    findings.push({
      id: `REQ-${index + 1}`,
      severity: 'high',
      file: coverage.file,
      line: coverage.line,
      description: `${coverage.requirement} (${coverage.status}): ${coverage.evidence}`,
      correction: `Implement and verify the requirement quoted from the request: ${coverage.sourceQuote}`,
      criterionId: null,
    });
  });
  return { ...parsed, requestCoverage, findings };
}

export async function submitNativeReview(api: ChatApi, runId: string, review: NativeReview) {
  const detail = await api.request<Detail>(`/api/runs/${runId}`);
  const parsed = normalizeNativeReview(detail.run.prompt, detail.run.contract?.criteria || [], review);
  return api.request<Run>(`/api/runs/${runId}/review`, {
    source: 'codex-native-review',
    ...parsed,
  });
}

function normalizedTrace(value: string) {
  return value.replace(/\s+/g, ' ').trim().toLowerCase();
}

function assertSourceQuotes(prompt: string, coverage: { sourceQuote: string }[]) {
  const seen = new Set<string>();
  for (const item of coverage) {
    const quote = normalizedTrace(item.sourceQuote);
    const issue = sourceQuoteIssue(prompt, item.sourceQuote);
    if (issue) throw new Error(`Requirement ${issue.charAt(0).toLowerCase()}${issue.slice(1)}`);
    if (seen.has(quote)) throw new Error(`Requirement source quote is duplicated: ${item.sourceQuote}`);
    seen.add(quote);
  }
}

function expandCheckpoint(checkpoint: z.infer<typeof checkpointInputSchema>, policy: Repository, prompt: string) {
  assertSourceQuotes(prompt, checkpoint.requirementCoverage);
  for (const coverage of checkpoint.requirementCoverage) {
    const omitted = omittedTraceTerms(
      coverage.sourceQuote,
      `${coverage.requirement} ${coverage.acceptanceCriterion} ${coverage.testEvidence}`,
    );
    if (omitted.length)
      throw new Error(
        `Requirement trace omits material request terms (${omitted.join(', ')}): ${coverage.sourceQuote}`,
      );
  }
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
    criteria: checkpoint.requirementCoverage.map((coverage, index) => ({
      id: `AC-${index + 1}`,
      category: 'functional',
      description: coverage.acceptanceCriterion,
      sourceQuote: coverage.sourceQuote,
      requirement: coverage.requirement,
      testEvidence: coverage.testEvidence,
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
    testStrategy: `${checkpoint.testStrategy}\n\nRequirement evidence:\n${checkpoint.requirementCoverage
      .map((coverage) => `- ${coverage.requirement}: ${coverage.testEvidence}`)
      .join('\n')}`,
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
    ({ runId, workspaceRoot, checkpoint }) =>
      protect(async () => {
        let detail = await api.request<Detail>(`/api/runs/${runId}`);
        if (detail.run.phase === 'planning') {
          if (!checkpoint) throw new Error('The first verification requires the accepted lifecycle checkpoint');
          await api.request<Run>(
            `/api/runs/${runId}/specification`,
            expandCheckpoint(checkpoint, detail.run.policy, detail.run.prompt),
          );
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
        let eventQueue = Promise.resolve<unknown>(undefined);
        const progress = (step: string, message: string) => {
          eventQueue = eventQueue.then(() =>
            api.request(`/api/runs/${runId}/progress`, { phase: 'testing', step, message }),
          );
          return eventQueue;
        };
        const runCheck = async (index: number) => {
          const command = checks[index];
          await progress(command.id, `Running ${command.label}`);
          const checkResult = await executeCheck(workspace.root, command);
          results[index] = { commandId: command.id, result: checkResult };
          const outcome = checkResult.exitCode === 0 ? 'passed' : 'failed';
          await progress(command.id, `${command.label} ${outcome} in ${(checkResult.durationMs / 1_000).toFixed(1)}s`);
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
        const run = await submitNativeReview(api, runId, review);
        return { ...summary(run), findings: run.review?.findings.length || review.findings.length };
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
