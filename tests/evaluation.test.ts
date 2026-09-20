import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  buildEvaluationReport,
  evaluationExperimentSchema,
  markdownReport,
  readCodexUsage,
  type TrialMeasurement,
  type VariantMeasurement,
} from '../apps/server/src/evaluation.js';

const cleanup: string[] = [];
afterEach(async () => {
  for (const path of cleanup.splice(0)) await rm(path, { recursive: true, force: true });
});

function variant(qualityScore: number, totalTokens: number): VariantMeasurement {
  return {
    qualityScore,
    lifecycleScore: 1,
    checks: [
      {
        id: 'hidden',
        label: 'Hidden acceptance',
        kind: 'held-out',
        severity: 'high',
        weight: 1,
        passed: qualityScore === 1,
        exitCode: qualityScore === 1 ? 0 : 1,
        durationMs: 10,
        findings: qualityScore === 1 ? [] : ['failed'],
      },
    ],
    usage: {
      inputTokens: totalTokens - 10,
      cachedInputTokens: 0,
      outputTokens: 10,
      reasoningOutputTokens: 0,
      totalTokens,
      uncachedTokens: totalTokens,
      mcpToolCalls: 0,
      commandExecutions: 1,
    },
    wallTimeMs: 100,
    humanInterventions: 0,
    repairIterations: 0,
    lifecycleStages: ['planning', 'requirements', 'design', 'coding', 'testing', 'review', 'delivery'],
    workspaceChangedByEvaluator: false,
  };
}

function experiment(count: number) {
  return evaluationExperimentSchema.parse({
    name: 'Paired benchmark',
    harnessRevision: 'test-harness-revision',
    policyRevision: 'test-policy-revision',
    trials: Array.from({ length: count }, (_, index) => ({
      id: `trial-${index + 1}`,
      task: 'Fix the hidden defect',
      model: 'same-model',
      reasoningEffort: 'high',
      baseSha: 'a'.repeat(40),
      checks: [
        {
          id: 'hidden',
          label: 'Hidden acceptance',
          argv: ['node', '-e', 'process.exit(0)'],
          kind: 'held-out',
        },
      ],
      baseline: { root: 'baseline' },
      harness: { root: 'harness' },
    })),
  });
}

function trials(count: number, baselineQuality: number, harnessQuality: number, tokenRatio = 1) {
  return Array.from({ length: count }, (_, index): TrialMeasurement => {
    const baseline = variant(baselineQuality, 100);
    const harness = variant(harnessQuality, 100 * tokenRatio);
    return {
      id: `trial-${index + 1}`,
      task: 'Fix the hidden defect',
      model: 'same-model',
      reasoningEffort: 'high',
      baseSha: 'a'.repeat(40),
      valid: true,
      fairnessIssues: [],
      baseline,
      harness,
      qualityDelta: harnessQuality - baselineQuality,
      totalTokenRatio: tokenRatio,
      uncachedTokenRatio: tokenRatio,
    };
  });
}

describe('paired harness evaluation', () => {
  it('parses exact Codex JSONL usage and completed tool events', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sdlc-eval-'));
    cleanup.push(root);
    const log = join(root, 'codex.jsonl');
    await writeFile(
      log,
      [
        JSON.stringify({ type: 'item.completed', item: { type: 'mcp_tool_call' } }),
        JSON.stringify({ type: 'item.completed', item: { type: 'command_execution' } }),
        JSON.stringify({
          type: 'turn.completed',
          usage: { input_tokens: 100, cached_input_tokens: 60, output_tokens: 20, reasoning_output_tokens: 5 },
        }),
      ].join('\n'),
    );
    await expect(readCodexUsage(log)).resolves.toMatchObject({
      inputTokens: 100,
      cachedInputTokens: 60,
      outputTokens: 20,
      totalTokens: 120,
      uncachedTokens: 60,
      mcpToolCalls: 1,
      commandExecutions: 1,
    });
  });

  it('allows a quality benefit even when the harness costs more tokens', () => {
    const report = buildEvaluationReport(experiment(5), trials(5, 0, 1, 1.2));
    expect(report.verdict).toBe('beneficial');
    expect(report.claim).toContain('token cost');
    expect(report.quality.confidence95[0]).toBeGreaterThan(0);
  });

  it('reports unavailable token cost instead of implying no increase', () => {
    const measured = trials(5, 0, 1);
    for (const trial of measured) {
      trial.baseline.usage = undefined;
      trial.harness.usage = undefined;
    }
    const report = buildEvaluationReport(experiment(5), measured);
    expect(report.verdict).toBe('beneficial');
    expect(report.claim).toContain('token cost is unavailable');
  });

  it('accepts lower usage only when quality remains non-inferior', () => {
    const report = buildEvaluationReport(experiment(5), trials(5, 1, 1, 0.8));
    expect(report.verdict).toBe('beneficial');
    expect(report.claim).toContain('token usage');
  });

  it('refuses to claim a benefit from too few trials', () => {
    const report = buildEvaluationReport(experiment(2), trials(2, 0, 1, 0.5));
    expect(report.verdict).toBe('inconclusive');
    expect(report.limitations.some((limitation) => limitation.includes('5 are required'))).toBe(true);
  });

  it('rejects a new critical regression even when aggregate quality improves', () => {
    const measured = trials(5, 0, 1);
    measured[0].baseline.checks[0].severity = 'critical';
    measured[0].baseline.checks[0].passed = true;
    measured[0].harness.checks[0].severity = 'critical';
    measured[0].harness.checks[0].passed = false;
    measured[0].harness.checks[0].findings = ['critical regression'];
    const report = buildEvaluationReport(experiment(5), measured);
    expect(report.verdict).toBe('regressed');
    expect(report.quality.criticalRegressions).toEqual(['trial-1/hidden']);
    expect(markdownReport(report)).toContain(
      '| trial-1 | harness | hidden | held-out | critical | critical regression |',
    );
  });
});
