import { randomUUID } from 'node:crypto';
import {
  acceptanceSchema,
  contractSchema,
  designSchema,
  planSchema,
  reviewSchema,
  type CheckCommand,
  type Run,
} from '../../../shared/types.js';
import type { Store } from './store.js';
import type { Runner } from './runner.js';
import { Agents } from './agents.js';
import { approvalDigest, completionFailures, evaluate, report, validApproval } from './gates.js';
import {
  createOrUpdatePr,
  dispatch,
  markReady,
  requiredChecks,
  workflowStatus,
  githubConfigured,
  repositoryToken,
} from './github.js';
import { hash } from './security.js';
import { callIntegration } from './mcp.js';
const planningShape = `{"scope":"string","steps":["string"],"dependencies":["string"],"estimatedEffort":"string","costEstimate":"string","schedule":["string"],"risks":["string"]}`;
const contractShape = `{"summary":"string","criteria":[{"id":"AC-1","description":"string","evidence":"test|review|human","checkIds":["check-id"],"category":"functional|security|performance|reliability|usability"}],"nonGoals":["string"],"assumptions":["string"],"risks":["string"],"clarification":null}`;
const designShape = `{"architecture":"string","apiContracts":["string"],"dataChanges":["string"],"uiBehavior":["string"],"security":["string"],"compatibility":"string","testStrategy":"string"}`;
const acceptanceShape = `{"files":[{"path":"acceptance.test.js","content":"complete test source"}],"command":{"id":"acceptance","label":"independent acceptance","argv":["node","/acceptance/acceptance.test.js"],"required":true,"kind":"acceptance","report":"exit","reportPath":"","timeoutSeconds":600,"baselineAllowed":false},"coveredCriteria":["AC-1"],"explanation":"string"}`;
const reviewShape = `{"summary":"string","findings":[{"id":"F-1","severity":"critical|high|medium|low","file":"path","line":1,"description":"string","correction":"string","criterionId":"AC-1 or null"}],"criteria":[{"id":"AC-1","satisfied":true,"evidence":"specific gate/diff evidence"}]}`;
const now = () => new Date().toISOString();
function contextText(run: Run) {
  return run.context
    .map((c) => `SOURCE ${c.id} (${c.title}, version ${c.version}, hash ${c.hash}):\n${c.excerpt}`)
    .join('\n\n');
}
function runFacts(run: Run) {
  return `Request: ${run.prompt}\nRepository: ${run.policy.owner}/${run.policy.repo}\nStack: ${run.policy.stack}\nConfigured checks: ${run.policy.checks.map((c) => c.id).join(', ')}\nCompany standards:\n${run.policy.standards}\nCompany context:\n${contextText(run)}`;
}
function template(value: unknown, run: Run): unknown {
  if (typeof value === 'string')
    return value.replaceAll('{{prompt}}', run.prompt).replaceAll('{{repo}}', `${run.policy.owner}/${run.policy.repo}`);
  if (Array.isArray(value)) return value.map((v) => template(v, run));
  if (value && typeof value === 'object')
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, template(item, run)]));
  return value;
}
export class Engine {
  private agents: Agents;
  private timer?: NodeJS.Timeout;
  private busy = new Set<string>();
  constructor(
    private store: Store,
    private runner: Runner,
    private maxActive = 2,
    private deploymentPollMs = 15_000,
  ) {
    this.agents = new Agents(runner);
  }
  start() {
    this.timer = setInterval(() => void this.tick(), 2000);
    void this.tick();
  }
  stop() {
    if (this.timer) clearInterval(this.timer);
  }
  wake() {
    void this.tick();
  }
  runOnce() {
    return this.tick();
  }
  private async tick() {
    const runs = await this.store.runs();
    const candidates = runs
      .filter((r) => {
        const active = ['queued', 'running', 'repairing'].includes(r.status);
        const isPollingDeployment = r.phase === 'deployment' && ['remote-ci', 'release'].includes(r.step);
        return (
          active && (!isPollingDeployment || Date.now() - new Date(r.updatedAt).getTime() >= this.deploymentPollMs)
        );
      })
      .slice(0, this.maxActive);
    await Promise.all(candidates.filter((run) => !this.busy.has(run.id)).map((run) => this.execute(run.id)));
    for (const run of runs.filter((r) => r.status === 'monitoring')) void this.monitor(run);
  }
  private async execute(id: string) {
    this.busy.add(id);
    const claim = await this.store.claim(id);
    if (!claim) {
      this.busy.delete(id);
      return;
    }
    const pulse = setInterval(() => void this.store.heartbeat(id, claim.token), 15_000);
    try {
      await this.step(claim.run, claim.token);
    } catch (error) {
      const run = await this.store.getRun(id);
      if (run && run.status !== 'cancelled') {
        run.status = 'failed';
        run.blocker = error instanceof Error ? error.message : String(error);
        await this.store.event(run, 'error', run.blocker);
        await this.store.saveRun(run, claim.token).catch(() => undefined);
      }
    } finally {
      clearInterval(pulse);
      await this.store.release(id, claim.token);
      this.busy.delete(id);
    }
  }
  private async save(run: Run, token: string, kind: string, message: string, data?: unknown) {
    await this.store.event(run, kind, message, data);
    await this.store.saveRun(run, token);
  }
  private async step(run: Run, token: string) {
    if (run.startedAt && Date.now() - new Date(run.startedAt).getTime() > run.limits.minutes * 60_000) {
      run.status = 'failed';
      run.blocker = `Run exceeded its ${run.limits.minutes}-minute limit`;
      return this.save(run, token, 'failed', run.blocker);
    }
    if (run.status === 'queued') {
      run.status = 'running';
      run.startedAt ||= now();
      run.step = 'preflight';
      await this.save(run, token, 'stage', 'Preflight started');
    }
    if (run.phase === 'planning') return this.planning(run, token);
    if (run.phase === 'requirements') return this.requirements(run, token);
    if (run.phase === 'design') return this.design(run, token);
    if (run.phase === 'coding') return this.coding(run, token);
    if (run.phase === 'testing') return this.testing(run, token);
    if (run.phase === 'deployment') return this.deployment(run, token);
    if (run.phase === 'maintenance') return this.enableMaintenance(run, token);
  }
  private async planning(run: Run, token: string) {
    if (run.step === 'preflight') {
      const ready = await this.runner.ready();
      if (!ready.ok) {
        run.status = 'blocked';
        run.blocker = `Execution environment not ready: ${JSON.stringify(ready)}`;
        return this.save(run, token, 'blocked', run.blocker);
      }
      if (!(await this.runner.codexStatus()).connected) {
        run.status = 'blocked';
        run.blocker = 'Codex is not connected. Open System setup and connect Codex.';
        return this.save(run, token, 'blocked', run.blocker);
      }
      if (!githubConfigured()) {
        run.status = 'blocked';
        run.blocker = 'GitHub repository credentials are not configured';
        return this.save(run, token, 'blocked', run.blocker);
      }
      run.baseSha = (
        await this.runner.prepare(run.id, run.policy.owner, run.policy.repo, run.policy.branch, await repositoryToken())
      ).sha;
      run.branch = `sdlc/${run.id}`;
      const documents = await this.store.searchDocuments(run.prompt);
      run.context = documents.map((d) => ({
        id: d.id,
        title: d.title,
        version: d.version,
        hash: d.hash,
        excerpt: d.content.slice(0, 12000),
      }));
      for (const integration of (await this.store.integrations()).filter((i) => i.enabled))
        for (const call of integration.contextCalls || []) {
          const args = template(call.arguments, run) as Record<string, unknown>;
          try {
            const result = await callIntegration(integration, call.tool, args);
            const excerpt = JSON.stringify(result).slice(0, 12000);
            run.context.push({
              id: `${integration.id}:${call.tool}`,
              title: `${integration.name} / ${call.tool}`,
              version: 1,
              hash: hash(excerpt),
              excerpt,
            });
          } catch (error) {
            run.status = 'blocked';
            run.blocker = `Required company integration ${integration.name}/${call.tool} failed: ${error instanceof Error ? error.message : String(error)}`;
            return this.save(run, token, 'blocked', run.blocker);
          }
        }
      run.step = 'baseline';
      await this.save(run, token, 'stage', `Workspace prepared at ${run.baseSha}`);
      return;
    }
    if (run.step === 'baseline') {
      run.baseline = [];
      for (const command of run.policy.checks) {
        const result = await this.runner.command(run.id, command);
        const gate = evaluate(command, result, run, true);
        run.baseline.push(gate);
        await this.store.artifact(run, `baseline-${command.id}.log`, `${result.stdout}\n${result.stderr}`);
      }
      const bad = run.baseline.filter((g) => g.required && !['pass', 'waived'].includes(g.status));
      if (bad.length) {
        run.status = 'blocked';
        run.blocker = `Required baseline checks failed: ${bad.map((g) => `${g.id} (${g.status})`).join(', ')}`;
        return this.save(run, token, 'blocked', run.blocker);
      }
      run.step = 'charter';
      await this.save(run, token, 'gate', 'Baseline established');
      return;
    }
    const { value, result } = await this.agents.structured(
      run,
      run.backend,
      'planning',
      `Act as an engineering delivery lead. Create the Planning phase artifact for this request. Define scope, implementation sequence, dependencies, realistic effort and external cost assumptions, a compact schedule, and risks. Do not invent known company facts. JSON shape: ${planningShape}\n\n${runFacts(run)}`,
      planSchema,
    );
    run.plan = value;
    await this.store.artifact(run, 'planning-agent.log', result.logs);
    await this.store.artifact(run, 'plan.json', JSON.stringify(value, null, 2));
    run.phase = 'requirements';
    run.step = 'analysis';
    await this.save(run, token, 'stage', 'Planning complete');
  }
  private async requirements(run: Run, token: string) {
    const { value, result } = await this.agents.structured(
      run,
      run.backend,
      'requirements',
      `Act as a business analyst and security requirements engineer. Produce functional and non-functional requirements for the request. Every criterion must be measurable and map to configured check IDs where automated evidence applies. Use evidence=human only for a consequential product decision. If a consequential ambiguity prevents a safe specification, place one concise question in clarification; otherwise use null and record routine assumptions. JSON shape: ${contractShape}\n\nPlan: ${JSON.stringify(run.plan)}\n${runFacts(run)}`,
      contractSchema,
    );
    const ids = new Set(run.policy.checks.map((c) => c.id));
    for (const c of value.criteria)
      if (c.checkIds.some((id) => !ids.has(id) && id !== 'acceptance'))
        throw new Error(`Requirement ${c.id} references an unknown check`);
    run.contract = value;
    await this.store.artifact(run, 'requirements-agent.log', result.logs);
    await this.store.artifact(run, 'requirements.json', JSON.stringify(value, null, 2));
    if (value.clarification) {
      run.status = 'needs_input';
      run.question = value.clarification;
      return this.save(run, token, 'question', value.clarification);
    }
    run.phase = 'design';
    run.step = 'blueprint';
    await this.save(run, token, 'stage', 'Requirements approved by policy checks');
  }
  private async design(run: Run, token: string) {
    if (run.step === 'blueprint') {
      const { value, result } = await this.agents.structured(
        run,
        run.backend,
        'design',
        `Act as the software architect. Inspect the repository and produce an implementation blueprint that follows existing architecture. Cover interfaces, data changes, UI behavior, security boundaries, compatibility, and the verification strategy. JSON shape: ${designShape}\n\nContract: ${JSON.stringify(run.contract)}\n${runFacts(run)}`,
        designSchema,
      );
      run.design = value;
      await this.store.artifact(run, 'design-agent.log', result.logs);
      await this.store.artifact(run, 'design.json', JSON.stringify(value, null, 2));
      run.step = 'acceptance-tests';
      await this.save(run, token, 'stage', 'Technical design complete');
      return;
    }
    const { value, result } = await this.agents.structured(
      run,
      run.reviewer,
      'acceptance-test-design',
      `Act as an independent test engineer. Inspect the repository, requirements, and design. Author focused black-box or contract acceptance tests before implementation. Files are mounted read-only at /acceptance during verification and must test /workspace. The command must use an argument array and execute those files. Cover all automatable criteria. Avoid tests that merely restate source implementation. JSON shape: ${acceptanceShape}\n\nContract: ${JSON.stringify(run.contract)}\nDesign: ${JSON.stringify(run.design)}\n${runFacts(run)}`,
      acceptanceSchema,
    );
    if (!value.command.argv.some((arg) => arg.startsWith('/acceptance/')))
      throw new Error('Independent acceptance command must execute protected /acceptance files');
    run.acceptance = value;
    for (const criterion of run.contract?.criteria || [])
      if (value.coveredCriteria.includes(criterion.id) && !criterion.checkIds.includes('acceptance'))
        criterion.checkIds.push('acceptance');
    await this.store.artifact(run, 'acceptance-author.log', result.logs);
    await this.store.artifact(
      run,
      'acceptance-manifest.json',
      JSON.stringify({ ...value, files: value.files.map((f) => ({ path: f.path, hash: hash(f.content) })) }, null, 2),
    );
    run.phase = 'coding';
    run.step = 'implementation';
    await this.save(run, token, 'stage', 'Design and independent acceptance tests complete');
  }
  private async coding(run: Run, token: string) {
    const feedback = run.blocker ? `\nRepair feedback from authoritative verification:\n${run.blocker}` : '';
    const result = await this.agents.implement(
      run,
      `${runFacts(run)}\nPlan: ${JSON.stringify(run.plan)}\nRequirements: ${JSON.stringify(run.contract)}\nDesign: ${JSON.stringify(run.design)}${feedback}`,
    );
    await this.store.artifact(run, `implementation-${run.attempt}.log`, `${result.stdout}\n${result.stderr}`);
    const commit = await this.runner.commit(
      run.id,
      `Implement ${run.contract?.summary || 'SDLC task'} (attempt ${run.attempt + 1})`,
      run.baseSha!,
    );
    const protectedChange = commit.changed.find((path) =>
      run.policy.protectedPaths.some((prefix) => path === prefix || path.startsWith(prefix)),
    );
    if (protectedChange) throw new Error(`Coding agent modified protected path ${protectedChange}`);
    run.candidateSha = commit.sha;
    run.gates = [];
    run.review = undefined;
    run.approval = undefined;
    run.blocker = undefined;
    run.phase = 'testing';
    run.step = 'verification';
    run.status = 'running';
    await this.save(run, token, 'candidate', `Candidate ${commit.sha} created`, { changed: commit.changed });
  }
  private async testing(run: Run, token: string) {
    if (run.step === 'verification') {
      const checks: { command: CheckCommand; files?: { path: string; content: string }[] }[] = run.policy.checks.map(
        (command) => ({ command }),
      );
      if (run.acceptance) checks.push({ command: run.acceptance.command, files: run.acceptance.files });
      run.gates = [];
      for (const check of checks) {
        const result = await this.runner.command(run.id, check.command, check.files);
        const gate = evaluate(check.command, result, run);
        const artifact = await this.store.artifact(
          run,
          `verification-${run.attempt}-${check.command.id}.log`,
          `${result.stdout}\n${result.stderr}\n${JSON.stringify(result.files)}`,
        );
        gate.artifactId = artifact.id;
        run.gates.push(gate);
      }
      const failed = run.gates.filter((g) => g.required && g.status !== 'pass');
      if (failed.length)
        return this.repair(run, token, failed.map((g) => `${g.id}: ${g.status}; ${g.findings.join('; ')}`).join('\n'));
      run.step = 'review';
      await this.save(run, token, 'gate', 'Automated verification passed');
      return;
    }
    const diff = (await this.runner.diff(run.id, run.baseSha!)).diff;
    const { value, result } = await this.agents.structured(
      run,
      run.reviewer,
      'independent-review',
      `Act as an independent senior code reviewer. You did not implement this change. Review the diff against every acceptance criterion, design, company standards, security, error handling, and tests. Cite concrete evidence. JSON shape: ${reviewShape}\n\nContract: ${JSON.stringify(run.contract)}\nDesign: ${JSON.stringify(run.design)}\nGates: ${JSON.stringify(run.gates)}\nDiff:\n${diff.slice(0, 300000)}`,
      reviewSchema,
    );
    run.review = value;
    await this.store.artifact(run, 'review-agent.log', result.logs);
    await this.store.artifact(run, 'review.json', JSON.stringify(value, null, 2));
    const failures = completionFailures(run);
    if (failures.length)
      return this.repair(
        run,
        token,
        failures.join('\n') +
          '\n' +
          value.findings
            .filter((f) => ['high', 'critical'].includes(f.severity))
            .map((f) => `${f.file}:${f.line} ${f.description}; correction: ${f.correction}`)
            .join('\n'),
      );
    run.phase = 'deployment';
    run.step = 'publish';
    await this.save(run, token, 'stage', 'Testing and independent review passed');
  }
  private async repair(run: Run, token: string, feedback: string) {
    const signature = hash(feedback);
    run.repeatedFailures = run.lastFailureSignature === signature ? run.repeatedFailures + 1 : 1;
    run.lastFailureSignature = signature;
    if (run.attempt >= run.limits.repairs || run.repeatedFailures >= 2) {
      run.status = 'failed';
      run.blocker = `Repair loop stopped after ${run.attempt} attempts.\n${feedback}`;
      return this.save(run, token, 'failed', run.blocker);
    }
    run.attempt += 1;
    run.status = 'repairing';
    run.phase = 'coding';
    run.step = 'repair';
    run.blocker = feedback;
    await this.save(run, token, 'repair', `Repair attempt ${run.attempt} requested`, { feedback });
  }
  private async deployment(run: Run, token: string) {
    if (run.step === 'publish') {
      await this.runner.push(run.id, run.branch!, await repositoryToken());
      const pr = await createOrUpdatePr(run);
      run.prNumber = pr.number;
      run.prUrl = pr.html_url;
      run.step = 'remote-ci';
      await this.save(run, token, 'delivery', `Draft PR created: ${pr.html_url}`);
      return;
    }
    if (run.step === 'remote-ci') {
      const ci = await requiredChecks(run.policy, run.candidateSha!);
      if (ci.state === 'pending') {
        await this.save(run, token, 'waiting', `Waiting for required CI: ${ci.details.join(', ')}`);
        return;
      }
      if (ci.state === 'failure') return this.repair(run, token, `Remote CI failed:\n${ci.details.join('\n')}`);
      await markReady(run.policy, run.prNumber!);
      if (!run.policy.deployment.enabled) {
        run.status = 'blocked';
        run.blocker = 'All seven phases require an administrator-configured deployment workflow and environment';
        return this.save(run, token, 'blocked', run.blocker);
      }
      run.approval = { digest: approvalDigest(run) };
      run.status = 'awaiting_approval';
      run.step = 'approval';
      return this.save(
        run,
        token,
        'approval',
        `Deployment approval required for ${run.policy.deployment.environment} at ${run.candidateSha}`,
      );
    }
    if (run.step === 'approval') {
      if (!validApproval(run)) {
        run.status = 'awaiting_approval';
        return this.save(run, token, 'approval', 'Deployment approval is missing or stale');
      }
      await dispatch(run.policy, run.policy.deployment.workflow, run.branch!, run.candidateSha!, run.id);
      run.step = 'release';
      run.status = 'running';
      await this.save(run, token, 'deployment', `Approved deployment started by ${run.approval?.approvedBy}`);
      return;
    }
    if (run.step === 'release') {
      const deployment = await workflowStatus(run.policy, run.policy.deployment.workflow, run.candidateSha!);
      if (deployment.state === 'pending') {
        await this.save(run, token, 'waiting', 'Waiting for deployment workflow');
        return;
      }
      if (deployment.state === 'failure') {
        run.status = 'failed';
        run.blocker = 'Deployment workflow failed';
        return this.save(run, token, 'failed', run.blocker);
      }
      run.deployment = { workflowRunId: deployment.run?.id, releasedAt: now(), healthy: false };
      run.step = 'smoke';
      await this.save(run, token, 'deployment', 'Deployment workflow passed; running health check');
      return;
    }
    if (run.step === 'smoke') {
      const healthy = await this.health(run);
      if (!healthy) {
        await dispatch(
          run.policy,
          run.policy.deployment.rollbackWorkflow,
          run.policy.branch,
          run.candidateSha!,
          run.id,
        );
        run.status = 'failed';
        run.blocker = 'Post-deployment health check failed; rollback workflow dispatched';
        return this.save(run, token, 'rollback', run.blocker);
      }
      run.deployment!.healthy = true;
      run.phase = 'maintenance';
      run.step = 'enable-monitoring';
      await this.save(run, token, 'deployment', 'Deployment health check passed');
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
  private async enableMaintenance(run: Run, token: string) {
    await this.store.monitor(run.id);
    run.status = 'monitoring';
    run.step = 'monitoring';
    const artifact = await this.store.artifact(run, 'evidence.md', report(run));
    await this.save(run, token, 'complete', `Seven SDLC phases active; evidence ${artifact.id}`);
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
    if (failures < 2 || state.incident_run_id) return;
    const incident: Run = {
      ...structuredClone(run),
      id: randomUUID(),
      prompt: `Investigate and fix production health failure for deployment ${run.candidateSha}. Original task: ${run.prompt}`,
      status: 'queued',
      phase: 'planning',
      step: 'preflight',
      attempt: 0,
      createdAt: now(),
      updatedAt: now(),
      startedAt: undefined,
      baseSha: undefined,
      candidateSha: undefined,
      branch: undefined,
      prUrl: undefined,
      prNumber: undefined,
      plan: undefined,
      contract: undefined,
      design: undefined,
      acceptance: undefined,
      baseline: [],
      gates: [],
      review: undefined,
      blocker: undefined,
      approval: undefined,
      deployment: undefined,
      parentRunId: run.id,
      repeatedFailures: 0,
    };
    try {
      await this.store.insertRun(incident);
      await this.store.updateMonitor(run.id, failures, incident.id);
      await this.store.event(run, 'incident', `Maintenance incident run ${incident.id} created`);
    } catch (error) {
      await this.store.event(run, 'incident-error', error instanceof Error ? error.message : String(error));
    }
  }
}
