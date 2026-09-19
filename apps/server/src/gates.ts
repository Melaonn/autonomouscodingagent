import type { CheckCommand, GateResult, JobResult, Run } from '../../../shared/types.js';
import { hash } from './security.js';
export function evaluate(command: CheckCommand, result: JobResult, run: Run): GateResult {
  const gate: GateResult = {
    id: command.id,
    label: command.label,
    required: command.required,
    status: result.exitCode === 0 ? 'pass' : 'fail',
    candidateDigest: run.candidateDigest || '',
    policyVersion: run.policy.version,
    exitCode: result.exitCode,
    durationMs: result.durationMs,
    tests: null,
    findings: [],
    cached: result.cached,
  };
  try {
    if (result.exitCode < 0 || result.exitCode === 124 || result.exitCode === 127) {
      gate.status = 'error';
      gate.findings.push('Verifier did not complete successfully');
    }
    if (command.report !== 'exit') {
      const text = result.files[command.reportPath];
      if (!text) throw new Error('Required machine-readable report missing');
      if (command.report === 'junit') {
        const matches = [...text.matchAll(/<testcase\b/g)];
        gate.tests = matches.length;
        if (/<(?:failure|error)\b/.test(text)) gate.status = 'fail';
        if (!/<testsuites?\b/.test(text)) throw new Error('Malformed JUnit report');
      } else {
        const data = JSON.parse(text);
        if (command.report === 'vitest') {
          if (!Number.isInteger(data.numTotalTests)) throw new Error('Invalid Vitest report');
          gate.tests = data.numTotalTests;
          if (data.numFailedTests > 0 || data.success !== true || data.numPendingTests >= data.numTotalTests)
            gate.status = 'fail';
        }
        if (command.report === 'playwright') {
          if (!data.stats) throw new Error('Invalid Playwright report');
          gate.tests = Number(data.stats.expected || 0) + Number(data.stats.unexpected || 0);
          if (data.stats.unexpected > 0 || data.stats.flaky > 0 || data.errors?.length) gate.status = 'fail';
        }
        if (command.report === 'semgrep') {
          if (!Array.isArray(data.results) || data.errors?.length)
            throw new Error('SAST report contains scanner errors');
          gate.findings = data.results
            .filter((x: { extra?: { severity?: string } }) => x.extra?.severity === 'ERROR')
            .map((x: { check_id: string; path: string }) => `${x.check_id}: ${x.path}`);
          if (gate.findings.length) gate.status = 'fail';
        }
        if (command.report === 'gitleaks') {
          if (!Array.isArray(data)) throw new Error('Invalid secrets report');
          gate.findings = data.map((x: { RuleID: string; File: string }) => `${x.RuleID}: ${x.File}`);
          if (gate.findings.length) gate.status = 'fail';
        }
        if (command.report === 'npm-audit') {
          if (data.error || !data.metadata?.vulnerabilities) throw new Error('Dependency scanner failed');
          const v = data.metadata.vulnerabilities;
          if (v.high + v.critical > 0) {
            gate.status = 'fail';
            gate.findings.push(`${v.high + v.critical} high/critical dependency vulnerabilities`);
          } else if (result.exitCode === 1) gate.status = 'pass';
        }
        if (command.report === 'pip-audit') {
          const deps = Array.isArray(data) ? data : data.dependencies;
          if (!Array.isArray(deps)) throw new Error('Invalid dependency report');
          gate.findings = deps.flatMap((d: { name: string; vulns?: { id: string }[] }) =>
            (d.vulns || []).map((v) => `${d.name}: ${v.id}`),
          );
          if (gate.findings.length) gate.status = 'fail';
        }
      }
      if (gate.tests === 0) {
        gate.status = 'fail';
        gate.findings.push('No required tests executed');
      }
    }
  } catch (error) {
    gate.status = 'error';
    gate.findings.push(error instanceof Error ? error.message : 'Invalid verification evidence');
  }
  return gate;
}
export function completionFailures(run: Run): string[] {
  const failures: string[] = [];
  for (const command of run.policy.checks) {
    const gate = run.gates.find((g) => g.id === command.id);
    if (
      command.required &&
      (!gate ||
        gate.status !== 'pass' ||
        gate.candidateDigest !== run.candidateDigest ||
        gate.policyVersion !== run.policy.version)
    )
      failures.push(`${command.id}: required evidence missing, failing, or stale`);
  }
  if (!run.plan || !run.contract || !run.design || !run.review)
    failures.push('Planning, requirements, design, or self-review evidence missing');
  for (const criterion of run.contract?.criteria || []) {
    const verdict = run.review?.criteria.find((c) => c.id === criterion.id);
    if (!verdict?.satisfied || !verdict.evidence.trim())
      failures.push(`${criterion.id}: acceptance criterion unresolved`);
    if (criterion.evidence === 'human' && !run.answer) failures.push(`${criterion.id}: human decision required`);
    if (
      criterion.evidence === 'test' &&
      (!criterion.checkIds.length ||
        criterion.checkIds.some(
          (id) =>
            !run.gates.some(
              (gate) =>
                gate.id === id &&
                gate.status === 'pass' &&
                gate.candidateDigest === run.candidateDigest &&
                gate.policyVersion === run.policy.version,
            ),
        ))
    )
      failures.push(`${criterion.id}: test evidence missing`);
  }
  if (run.review?.findings.some((f) => ['high', 'critical'].includes(f.severity)))
    failures.push('Blocking self-review findings');
  return failures;
}
export function approvalDigest(run: Run) {
  return hash(
    JSON.stringify({
      sha: run.candidateSha,
      policy: run.policy.version,
      environment: run.policy.deployment.environment,
      workflow: run.policy.deployment.workflow,
    }),
  );
}
export function validApproval(run: Run) {
  return !!run.approval?.approvedBy && !run.approval.rejected && run.approval.digest === approvalDigest(run);
}
export function report(run: Run) {
  return `# SDLC evidence report\n\nRun: ${run.id}\nStatus: ${run.status}\nPhase: ${run.phase}\nWorkspace digest: ${run.candidateDigest || 'not verified'}\nCommit: ${run.candidateSha || 'not published'}\nStarting commit: ${run.workspace.headSha}\nPolicy: ${run.policy.version}\n\n## Request\n${run.prompt}\n\n## Acceptance criteria\n${run.contract?.criteria.map((c) => `- ${c.id}: ${c.description}`).join('\n') || 'Not generated'}\n\n## Verification\n${run.gates.map((g) => `- ${g.label}: ${g.status} (${g.tests === null ? 'command' : `${g.tests} tests`}, workspace ${g.candidateDigest})`).join('\n') || 'No verification evidence'}\n\n## Self-review\n${run.review?.summary || 'Not performed'}\n\n## Company context\n${run.context.map((c) => `- ${c.title}, version ${c.version}, SHA256 ${c.hash}`).join('\n') || 'No matching documents'}\n\n## Delivery\n${run.prUrl || 'No PR published'}\nDeployment: ${run.deployment?.releasedAt || 'Not deployed'}\n\n## Limitations\n${run.blocker || 'Passing checks establishes configured acceptance; company production validation is separate.'}\n`;
}
