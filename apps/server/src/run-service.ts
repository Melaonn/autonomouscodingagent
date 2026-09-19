import { randomUUID } from 'node:crypto';
import type {
  Design,
  JobResult,
  Phase,
  Plan,
  Repository,
  Review,
  Run,
  TaskContract,
  WorkspaceState,
} from '../../../shared/types.js';
import type { Store } from './store.js';
import { approvalDigest, completionFailures, evaluate, report } from './gates.js';
import { createOrUpdatePr, dispatch, githubConfigured, markReady, requiredChecks, workflowStatus } from './github.js';
import { callIntegration } from './mcp.js';
import { hash } from './security.js';

const activeStatuses = new Set(['running', 'repairing', 'needs_input', 'awaiting_approval']);
const now = () => new Date().toISOString();

function failure(message: string, statusCode = 409): never {
  throw Object.assign(new Error(message), { statusCode });
}

function template(value: unknown, prompt: string, repository: Repository): unknown {
  if (typeof value === 'string')
    return value.replaceAll('{{prompt}}', prompt).replaceAll('{{repo}}', `${repository.owner}/${repository.repo}`);
  if (Array.isArray(value)) return value.map((item) => template(item, prompt, repository));
  if (value && typeof value === 'object')
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, template(item, prompt, repository)]));
  return value;
}

export class RunService {
  private timer?: NodeJS.Timeout;
  private syncing = new Set<string>();

  constructor(
    private store: Store,
    private pollMilliseconds = 15_000,
  ) {}

  start() {
    this.timer = setInterval(() => void this.tick(), 5_000);
    void this.tick();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
  }

  private async tick() {
    const runs = await this.store.runs();
    for (const run of runs) {
      const delivery = run.phase === 'deployment' && ['remote-ci', 'release', 'smoke'].includes(run.step);
      const due = Date.now() - new Date(run.updatedAt).getTime() >= this.pollMilliseconds;
      if ((delivery && due) || run.status === 'monitoring') void this.sync(run.id).catch(() => undefined);
    }
  }

  private async record(run: Run, actor: string, action: string, kind: string, message: string, data?: unknown) {
    const auditData = data && typeof data === 'object' && !Array.isArray(data) ? data : {};
    await this.store.event(run, kind, message, data);
    await this.store.saveRun(run);
    await this.store.audit(actor, action, { runId: run.id, phase: run.phase, step: run.step, ...auditData });
    return run;
  }

  private async requireRun(id: string) {
    const run = await this.store.getRun(id);
    if (!run) failure('Run not found', 404);
    return run;
  }

  private requireActive(run: Run) {
    if (!activeStatuses.has(run.status)) failure(`Run is ${run.status} and cannot accept lifecycle updates`);
  }

  async create(repository: Repository, prompt: string, workspace: WorkspaceState, actor: string) {
    const existing = (await this.store.runs()).find(
      (run) => run.repositoryId === repository.id && activeStatuses.has(run.status),
    );
    if (existing) {
      if (existing.prompt === prompt) return { run: existing, reused: true };
      failure(`Repository already has active run ${existing.id}`);
    }

    const documents = await this.store.searchDocuments(prompt);
    const context = documents.map((document) => ({
      id: document.id,
      title: document.title,
      version: document.version,
      hash: document.hash,
      excerpt: document.content.slice(0, 4_000),
    }));
    for (const integration of (await this.store.integrations()).filter((item) => item.enabled)) {
      for (const call of integration.contextCalls) {
        const args = template(call.arguments, prompt, repository) as Record<string, unknown>;
        const result = await callIntegration(integration, call.tool, args).catch((error) =>
          failure(
            `Company integration ${integration.name}/${call.tool} failed: ${error instanceof Error ? error.message : String(error)}`,
            502,
          ),
        );
        const excerpt = JSON.stringify(result).slice(0, 4_000);
        context.push({
          id: `${integration.id}:${call.tool}`,
          title: `${integration.name} / ${call.tool}`,
          version: 1,
          hash: hash(excerpt),
          excerpt,
        });
      }
    }

    const createdAt = now();
    const run: Run = {
      id: randomUUID(),
      repositoryId: repository.id,
      prompt,
      backend: 'codex',
      status: 'running',
      phase: 'planning',
      step: 'planning',
      attempt: 0,
      createdAt,
      updatedAt: createdAt,
      startedAt: createdAt,
      workspace,
      policy: structuredClone(repository),
      context,
      gates: [],
      limits: { verifications: 6 },
      repeatedFailures: 0,
    };
    await this.store.insertRun(run).catch(() => failure('This repository already has an active run'));
    await this.store.event(
      run,
      'started',
      `Native Codex session started from ${workspace.headSha}${workspace.dirty ? ' with local changes' : ''}`,
      { branch: workspace.branch, digest: workspace.digest, changes: workspace.changes },
    );
    await this.store.audit(actor, 'run.create', { runId: run.id, repositoryId: run.repositoryId, native: true });
    return { run, reused: false };
  }

  async savePlan(id: string, plan: Plan, actor: string) {
    const run = await this.requireRun(id);
    this.requireActive(run);
    if (run.phase !== 'planning') failure('Planning checkpoint is out of order');
    run.plan = plan;
    run.phase = 'requirements';
    run.step = 'analysis';
    await this.store.artifact(run, 'plan.json', JSON.stringify(plan, null, 2));
    return this.record(run, actor, 'run.plan', 'stage', 'Planning checkpoint accepted');
  }

  async saveRequirements(id: string, contract: TaskContract, actor: string) {
    const run = await this.requireRun(id);
    this.requireActive(run);
    if (!run.plan || run.phase !== 'requirements') failure('Requirements checkpoint is out of order');
    const checks = new Set(run.policy.checks.map((check) => check.id));
    for (const criterion of contract.criteria) {
      if (criterion.evidence === 'test' && !criterion.checkIds.length)
        failure(`${criterion.id} requires at least one configured check`);
      const unknown = criterion.checkIds.filter((check) => !checks.has(check));
      if (unknown.length) failure(`${criterion.id} references unknown checks: ${unknown.join(', ')}`);
    }
    if (contract.criteria.some((criterion) => criterion.evidence === 'human') && !contract.clarification)
      failure('Human acceptance evidence requires a specific stakeholder clarification question');
    run.contract = contract;
    await this.store.artifact(run, 'requirements.json', JSON.stringify(contract, null, 2));
    if (contract.clarification) {
      run.status = 'needs_input';
      run.question = contract.clarification;
      return this.record(run, actor, 'run.requirements', 'clarification', contract.clarification);
    }
    run.phase = 'design';
    run.step = 'blueprint';
    return this.record(run, actor, 'run.requirements', 'stage', 'Requirements checkpoint accepted');
  }

  async answer(id: string, answer: string, actor: string) {
    const run = await this.requireRun(id);
    if (run.status !== 'needs_input' || !run.contract) failure('Run is not awaiting a stakeholder answer');
    run.answer = answer;
    run.contract.assumptions.push(`Stakeholder answer: ${answer}`);
    run.contract.clarification = null;
    run.question = undefined;
    run.status = 'running';
    run.phase = 'design';
    run.step = 'blueprint';
    return this.record(run, actor, 'run.answer', 'decision', 'Stakeholder answer recorded');
  }

  async saveDesign(id: string, design: Design, actor: string) {
    const run = await this.requireRun(id);
    this.requireActive(run);
    if (!run.contract || run.contract.clarification || run.phase !== 'design')
      failure('Design checkpoint is out of order');
    run.design = design;
    run.phase = 'coding';
    run.step = 'implementation';
    await this.store.artifact(run, 'design.json', JSON.stringify(design, null, 2));
    return this.record(run, actor, 'run.design', 'stage', 'Design checkpoint accepted; implementation started');
  }

  async progress(id: string, phase: Phase, step: string, message: string, actor: string) {
    const run = await this.requireRun(id);
    this.requireActive(run);
    run.phase = phase;
    run.step = step;
    return this.record(run, actor, 'run.progress', 'progress', message);
  }

  async verify(
    id: string,
    candidateDigest: string,
    results: { commandId: string; result: JobResult }[],
    actor: string,
  ) {
    const run = await this.requireRun(id);
    this.requireActive(run);
    if (!run.plan || !run.contract || !run.design) failure('Planning, requirements, and design must be recorded first');
    const byId = new Map(results.map((entry) => [entry.commandId, entry.result]));
    if (byId.size !== results.length) failure('Verification contains duplicate command results', 400);
    const configured = new Set(run.policy.checks.map((check) => check.id));
    const unknownResults = results.filter((entry) => !configured.has(entry.commandId));
    if (unknownResults.length)
      failure(
        `Verification contains unknown checks: ${unknownResults.map((entry) => entry.commandId).join(', ')}`,
        400,
      );
    const missing = run.policy.checks.filter((check) => !byId.has(check.id));
    if (missing.length)
      failure(`Verification omitted configured checks: ${missing.map((check) => check.id).join(', ')}`);

    run.candidateDigest = candidateDigest;
    run.candidateSha = undefined;
    run.approval = undefined;
    run.deployment = undefined;
    run.review = undefined;
    run.phase = 'testing';
    run.step = 'verification';
    run.gates = [];
    for (const command of run.policy.checks) {
      const result = byId.get(command.id)!;
      const gate = evaluate(command, result, run);
      const artifact = await this.store.artifact(
        run,
        `verification-${run.attempt}-${command.id}.log`,
        `${result.stdout}\n${result.stderr}\n${JSON.stringify(result.files)}`,
      );
      gate.artifactId = artifact.id;
      run.gates.push(gate);
    }

    const failed = run.gates.filter((gate) => gate.required && gate.status !== 'pass');
    if (failed.length) {
      const details = failed.map((gate) => `${gate.id}: ${gate.status}; ${gate.findings.join('; ')}`).join('\n');
      const signature = hash(details);
      run.repeatedFailures = run.lastFailureSignature === signature ? run.repeatedFailures + 1 : 1;
      run.lastFailureSignature = signature;
      run.attempt += 1;
      run.phase = 'coding';
      run.step = 'repair';
      run.blocker = details;
      run.status = run.attempt >= run.limits.verifications ? 'failed' : 'repairing';
      return this.record(run, actor, 'run.verify', 'verification-failed', details, {
        attempt: run.attempt,
        digest: candidateDigest,
      });
    }

    run.status = 'running';
    run.step = 'self-review';
    run.blocker = undefined;
    run.lastFailureSignature = undefined;
    run.repeatedFailures = 0;
    return this.record(run, actor, 'run.verify', 'verification-passed', 'All configured checks passed', {
      digest: candidateDigest,
    });
  }

  async saveReview(id: string, review: Review, actor: string) {
    const run = await this.requireRun(id);
    this.requireActive(run);
    if (!run.candidateDigest || run.gates.some((gate) => gate.required && gate.status !== 'pass'))
      failure('Current workspace has not passed verification');
    const expected = new Set(run.contract?.criteria.map((criterion) => criterion.id) || []);
    const reviewed = new Set(review.criteria.map((criterion) => criterion.id));
    if (reviewed.size !== review.criteria.length) failure('Self-review contains duplicate acceptance criteria');
    const missing = [...expected].filter((criterion) => !reviewed.has(criterion));
    if (missing.length) failure(`Self-review omitted acceptance criteria: ${missing.join(', ')}`);
    const unknown = [...reviewed].filter((criterion) => !expected.has(criterion));
    if (unknown.length) failure(`Self-review contains unknown acceptance criteria: ${unknown.join(', ')}`);
    run.review = review;
    await this.store.artifact(run, 'self-review.json', JSON.stringify(review, null, 2));
    const blocking = review.findings.filter((finding) => ['critical', 'high'].includes(finding.severity));
    const unresolved = review.criteria.filter((criterion) => !criterion.satisfied || !criterion.evidence.trim());
    if (blocking.length || unresolved.length) {
      run.status = 'repairing';
      run.phase = 'coding';
      run.step = 'repair';
      run.blocker = [
        ...blocking.map((finding) => `${finding.file}:${finding.line} ${finding.description}`),
        ...unresolved.map((criterion) => `${criterion.id}: acceptance evidence is unresolved`),
      ].join('\n');
      return this.record(run, actor, 'run.review', 'review-failed', run.blocker);
    }
    run.phase = 'deployment';
    run.step = 'publish';
    return this.record(run, actor, 'run.review', 'review-passed', 'Self-review and acceptance evidence passed');
  }

  async publish(id: string, candidateDigest: string, candidateSha: string, branch: string, actor: string) {
    const run = await this.requireRun(id);
    this.requireActive(run);
    if (run.step !== 'publish') failure('Run is not ready to publish');
    if (candidateDigest !== run.candidateDigest) failure('Workspace changed after verification; verify it again');
    if (branch === run.policy.branch)
      failure(`Create a feature branch before publishing; ${branch} is the base branch`);
    const failures = completionFailures(run);
    if (failures.length) failure(`Completion gates failed:\n${failures.join('\n')}`);
    if (!githubConfigured()) failure('GitHub is not connected in the dashboard');

    run.candidateSha = candidateSha;
    run.branch = branch;
    const pullRequest = await createOrUpdatePr(run);
    run.prNumber = pullRequest.number;
    run.prUrl = pullRequest.html_url;
    run.status = 'running';
    run.phase = 'deployment';
    run.step = 'remote-ci';
    await this.record(run, actor, 'run.publish', 'delivery', `Draft PR created or updated: ${run.prUrl}`, {
      sha: candidateSha,
      branch,
    });
    return this.sync(id, actor);
  }

  async approve(id: string, approved: boolean, digest: string, actor: string) {
    const run = await this.requireRun(id);
    if (run.status !== 'awaiting_approval' || run.step !== 'approval' || !run.approval)
      failure('Run is not awaiting deployment approval');
    if (digest !== run.approval.digest || digest !== approvalDigest(run))
      failure('Candidate changed; reload approval details');
    run.approval = {
      digest,
      approvedBy: approved ? actor : undefined,
      approvedAt: now(),
      rejected: !approved,
    };
    if (!approved) {
      run.status = 'blocked';
      run.blocker = `Deployment rejected by ${actor}`;
      return this.record(run, actor, 'deployment.reject', 'approval-rejected', run.blocker);
    }
    await dispatch(run.policy, run.policy.deployment.workflow, run.branch!, run.candidateSha!, run.id);
    run.status = 'running';
    run.step = 'release';
    return this.record(run, actor, 'deployment.approve', 'deployment', `Deployment started by ${actor}`);
  }

  async cancel(id: string, actor: string) {
    const run = await this.requireRun(id);
    if (['monitoring', 'completed', 'failed', 'cancelled'].includes(run.status)) failure('Run cannot be cancelled');
    run.status = 'cancelled';
    run.blocker = `Cancelled by ${actor}`;
    return this.record(run, actor, 'run.cancel', 'cancelled', run.blocker);
  }

  async resume(id: string, actor: string) {
    const run = await this.requireRun(id);
    if (!['blocked', 'failed'].includes(run.status)) failure('Run is not resumable');
    run.status = 'repairing';
    run.phase = 'coding';
    run.step = 'repair';
    run.blocker = undefined;
    return this.record(run, actor, 'run.resume', 'resumed', 'Run resumed in the native Codex session');
  }

  async sync(id: string, actor = 'system') {
    if (this.syncing.has(id)) return this.requireRun(id);
    this.syncing.add(id);
    try {
      const run = await this.requireRun(id);
      if (run.step === 'remote-ci' && run.status === 'running') {
        const checks = await requiredChecks(run.policy, run.candidateSha!);
        if (checks.state === 'pending') return run;
        if (checks.state === 'failure') {
          run.status = 'repairing';
          run.phase = 'coding';
          run.step = 'repair';
          run.blocker = `Remote CI failed:\n${checks.details.join('\n')}`;
          return this.record(run, actor, 'delivery.ci', 'ci-failed', run.blocker);
        }
        if (run.prNumber) await markReady(run.policy, run.prNumber);
        if (!run.policy.deployment.enabled) {
          run.status = 'completed';
          run.phase = 'maintenance';
          run.step = 'completed';
          await this.store.artifact(run, 'evidence.md', report(run));
          return this.record(run, actor, 'run.complete', 'complete', 'All configured SDLC evidence passed');
        }
        run.approval = { digest: approvalDigest(run) };
        run.status = 'awaiting_approval';
        run.step = 'approval';
        return this.record(
          run,
          actor,
          'delivery.approval',
          'approval',
          `Deployment approval required for ${run.policy.deployment.environment} at ${run.candidateSha}`,
        );
      }

      if (run.step === 'release' && run.status === 'running') {
        const deployment = await workflowStatus(run.policy, run.policy.deployment.workflow, run.candidateSha!);
        if (deployment.state === 'pending') return run;
        if (deployment.state === 'failure') {
          run.status = 'failed';
          run.blocker = 'Deployment workflow failed';
          return this.record(run, actor, 'delivery.release', 'deployment-failed', run.blocker);
        }
        run.deployment = { workflowRunId: deployment.run?.id, releasedAt: now(), healthy: false };
        run.step = 'smoke';
        return this.record(
          run,
          actor,
          'delivery.release',
          'deployment',
          'Deployment workflow passed; health check started',
        );
      }

      if (run.step === 'smoke' && run.status === 'running') {
        if (!(await this.health(run))) {
          await dispatch(
            run.policy,
            run.policy.deployment.rollbackWorkflow,
            run.policy.branch,
            run.candidateSha!,
            run.id,
          );
          run.status = 'failed';
          run.blocker = 'Post-deployment health check failed; rollback workflow dispatched';
          return this.record(run, actor, 'delivery.health', 'rollback', run.blocker);
        }
        run.deployment!.healthy = true;
        run.phase = 'maintenance';
        run.step = 'monitoring';
        run.status = 'monitoring';
        await this.store.monitor(run.id);
        await this.store.artifact(run, 'evidence.md', report(run));
        return this.record(run, actor, 'run.complete', 'complete', 'Deployment passed; maintenance monitoring active');
      }

      if (run.status === 'monitoring') await this.monitor(run);
      return run;
    } finally {
      this.syncing.delete(id);
    }
  }

  private async health(run: Run) {
    if (!run.policy.deployment.healthUrl) return false;
    try {
      const response = await fetch(run.policy.deployment.healthUrl, {
        redirect: 'error',
        signal: AbortSignal.timeout(10_000),
        headers: { 'user-agent': 'sdlc-health-monitor' },
      });
      return response.ok;
    } catch {
      return false;
    }
  }

  private async monitor(run: Run) {
    const state = await this.store.monitor(run.id);
    if (
      state.last_check &&
      Date.now() - new Date(state.last_check).getTime() < run.policy.deployment.monitorIntervalSeconds * 1000
    )
      return;
    const healthy = await this.health(run);
    const failures = healthy ? 0 : state.failures + 1;
    await this.store.updateMonitor(run.id, failures);
    await this.store.event(
      run,
      healthy ? 'health' : 'health-failure',
      healthy ? 'Maintenance health check passed' : `Maintenance health check failed (${failures})`,
    );
    if (failures < 2) return;
    run.status = 'failed';
    run.blocker = 'Deployment health check failed twice; start a native Codex incident run';
    await this.store.saveRun(run);
    await this.store.audit('system', 'maintenance.health.failed', { runId: run.id, failures });
  }
}
