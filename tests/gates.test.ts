import { describe, expect, it } from 'vitest';
import { approvalDigest, completionFailures, evaluate, validApproval } from '../apps/server/src/gates.js';
import type { CheckCommand, Repository, Run } from '../shared/types.js';
const command: CheckCommand = {
  id: 'unit',
  label: 'unit',
  argv: ['test'],
  kind: 'unit',
  report: 'vitest',
  reportPath: '.reports/unit.json',
  required: true,
  timeoutSeconds: 60,
  baselineAllowed: false,
};
const policy: Repository = {
  id: 'repo',
  name: 'repo',
  owner: 'team',
  repo: 'service',
  branch: 'main',
  stack: 'typescript',
  standards: '',
  checks: [command],
  requiredCiChecks: ['ci'],
  ciWaiver: '',
  protectedPaths: ['.github/workflows/'],
  version: 3,
  createdAt: new Date().toISOString(),
  deployment: {
    enabled: true,
    environment: 'staging',
    workflow: 'deploy.yml',
    rollbackWorkflow: 'rollback.yml',
    healthUrl: 'https://example.com/health',
    monitorIntervalSeconds: 300,
  },
};
function fixture(): Run {
  const time = new Date().toISOString();
  return {
    id: 'run',
    repositoryId: policy.id,
    prompt: 'Implement a safe API behavior',
    backend: 'codex',
    reviewer: 'codex',
    status: 'running',
    phase: 'testing',
    step: 'review',
    attempt: 0,
    createdAt: time,
    updatedAt: time,
    baseSha: 'a'.repeat(40),
    candidateSha: 'b'.repeat(40),
    policy,
    context: [],
    baseline: [],
    gates: [],
    contract: {
      summary: 'Change API',
      criteria: [
        {
          id: 'AC-1',
          description: 'Returns expected result',
          evidence: 'test',
          checkIds: ['unit'],
          category: 'functional',
        },
      ],
      nonGoals: [],
      assumptions: [],
      risks: [],
      clarification: null,
    },
    review: { summary: 'okay', findings: [], criteria: [{ id: 'AC-1', satisfied: true, evidence: 'unit gate' }] },
    limits: { repairs: 3, minutes: 90, agentMinutes: 20 },
    usage: { inputTokens: 0, outputTokens: 0, costUsd: null },
    repeatedFailures: 0,
  };
}
describe('evidence gates', () => {
  it('fails closed when a machine-readable report is missing', () => {
    const run = fixture();
    const gate = evaluate(command, { exitCode: 0, stdout: '', stderr: '', durationMs: 4, files: {} }, run);
    expect(gate.status).toBe('error');
    expect(gate.findings).toContain('Required machine-readable report missing');
  });
  it('rejects a successful runner invocation that executes zero tests', () => {
    const run = fixture();
    const gate = evaluate(
      command,
      {
        exitCode: 0,
        stdout: '',
        stderr: '',
        durationMs: 4,
        files: {
          '.reports/unit.json': JSON.stringify({
            numTotalTests: 0,
            numFailedTests: 0,
            numPendingTests: 0,
            success: true,
          }),
        },
      },
      run,
    );
    expect(gate.status).toBe('fail');
    expect(gate.findings).toContain('No required tests executed');
  });
  it('does not accept stale evidence from another candidate', () => {
    const run = fixture();
    run.gates = [
      {
        id: 'unit',
        label: 'unit',
        required: true,
        status: 'pass',
        candidateSha: 'c'.repeat(40),
        policyVersion: 3,
        exitCode: 0,
        tests: 4,
        findings: [],
        durationMs: 3,
      },
    ];
    expect(completionFailures(run)).toContain('unit: required evidence missing, failing, or stale');
  });
  it('binds deployment approval to revision, policy, environment and workflow', () => {
    const run = fixture();
    run.approval = { digest: approvalDigest(run), approvedBy: 'operator', approvedAt: new Date().toISOString() };
    expect(validApproval(run)).toBe(true);
    run.candidateSha = 'd'.repeat(40);
    expect(validApproval(run)).toBe(false);
  });
});
