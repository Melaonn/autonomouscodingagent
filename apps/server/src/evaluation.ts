import { readFile } from 'node:fs/promises';
import { z } from 'zod';

const lifecycleStages = ['planning', 'requirements', 'design', 'coding', 'testing', 'review', 'delivery'] as const;

export const evaluationCheckSchema = z.object({
  id: z.string().regex(/^[a-z][a-z0-9_-]*$/),
  label: z.string().min(1),
  argv: z.array(z.string()).min(1).max(40),
  kind: z.enum(['acceptance', 'held-out', 'security']),
  severity: z.enum(['critical', 'high', 'medium', 'low']).default('high'),
  weight: z.number().positive().max(100).default(1),
  timeoutSeconds: z.number().int().min(10).max(1800).default(600),
});

const variantInputSchema = z.object({
  root: z.string().min(1),
  codexJsonl: z.string().min(1).optional(),
  wallTimeMs: z.number().nonnegative().optional(),
  humanInterventions: z.number().int().nonnegative().default(0),
  repairIterations: z.number().int().nonnegative().default(0),
  lifecycleStages: z.array(z.enum(lifecycleStages)).default([]),
});

export const evaluationExperimentSchema = z.object({
  name: z.string().min(1),
  harnessRevision: z.string().min(1),
  policyRevision: z.string().min(1),
  thresholds: z
    .object({
      minimumPairedTrials: z.number().int().min(5).default(5),
      qualityNonInferiority: z.number().min(0).max(0.2).default(0.02),
      tokenReductionTarget: z.number().min(0).max(0.8).default(0.1),
    })
    .default({ minimumPairedTrials: 5, qualityNonInferiority: 0.02, tokenReductionTarget: 0.1 }),
  trials: z
    .array(
      z.object({
        id: z.string().min(1),
        task: z.string().min(1),
        model: z.string().min(1),
        reasoningEffort: z.enum(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra']),
        baseSha: z.string().regex(/^[0-9a-f]{40}$/),
        checks: z.array(evaluationCheckSchema).min(1),
        baseline: variantInputSchema,
        harness: variantInputSchema,
      }),
    )
    .min(1),
});

export type EvaluationExperiment = z.infer<typeof evaluationExperimentSchema>;
export type EvaluationCheck = z.infer<typeof evaluationCheckSchema>;

export interface CodexUsage {
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  reasoningOutputTokens: number;
  totalTokens: number;
  uncachedTokens: number;
  mcpToolCalls: number;
  commandExecutions: number;
}

export interface CheckMeasurement {
  id: string;
  label: string;
  kind: EvaluationCheck['kind'];
  severity: EvaluationCheck['severity'];
  weight: number;
  passed: boolean;
  exitCode: number;
  durationMs: number;
  findings: string[];
}

export interface VariantMeasurement {
  qualityScore: number;
  lifecycleScore: number;
  checks: CheckMeasurement[];
  usage?: CodexUsage;
  wallTimeMs?: number;
  humanInterventions: number;
  repairIterations: number;
  lifecycleStages: string[];
  workspaceChangedByEvaluator: boolean;
}

export interface TrialMeasurement {
  id: string;
  task: string;
  model: string;
  reasoningEffort: string;
  baseSha: string;
  valid: boolean;
  fairnessIssues: string[];
  baseline: VariantMeasurement;
  harness: VariantMeasurement;
  qualityDelta: number;
  totalTokenRatio?: number;
  uncachedTokenRatio?: number;
}

export interface EvaluationReport {
  name: string;
  harnessRevision: string;
  policyRevision: string;
  generatedAt: string;
  verdict: 'beneficial' | 'regressed' | 'inconclusive' | 'invalid';
  claim: string;
  pairedTrials: number;
  validTrials: number;
  quality: {
    baselineMean: number;
    harnessMean: number;
    meanDelta: number;
    confidence95: [number, number];
    wins: number;
    ties: number;
    losses: number;
    criticalRegressions: string[];
  };
  usage: {
    complete: boolean;
    baselineTotalTokens?: number;
    harnessTotalTokens?: number;
    totalTokenRatio?: number;
    baselineUncachedTokens?: number;
    harnessUncachedTokens?: number;
    uncachedTokenRatio?: number;
    baselineMcpToolCalls?: number;
    harnessMcpToolCalls?: number;
    baselineCommandExecutions?: number;
    harnessCommandExecutions?: number;
  };
  process: {
    baselineWallTimeMs?: number;
    harnessWallTimeMs?: number;
    baselineInterventions: number;
    harnessInterventions: number;
    baselineRepairIterations: number;
    harnessRepairIterations: number;
  };
  limitations: string[];
  trials: TrialMeasurement[];
}

const number = (value: unknown) => (typeof value === 'number' && Number.isFinite(value) ? value : 0);

export async function readCodexUsage(path?: string): Promise<CodexUsage | undefined> {
  if (!path) return undefined;
  const content = await readFile(path, 'utf8');
  const usage: CodexUsage = {
    inputTokens: 0,
    cachedInputTokens: 0,
    outputTokens: 0,
    reasoningOutputTokens: 0,
    totalTokens: 0,
    uncachedTokens: 0,
    mcpToolCalls: 0,
    commandExecutions: 0,
  };
  let completedTurns = 0;
  for (const line of content.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (event.type === 'turn.completed' && event.usage && typeof event.usage === 'object') {
      const turn = event.usage as Record<string, unknown>;
      usage.inputTokens += number(turn.input_tokens);
      usage.cachedInputTokens += number(turn.cached_input_tokens);
      usage.outputTokens += number(turn.output_tokens);
      usage.reasoningOutputTokens += number(turn.reasoning_output_tokens);
      completedTurns += 1;
    }
    if (event.type !== 'item.completed' || !event.item || typeof event.item !== 'object') continue;
    const itemType = (event.item as Record<string, unknown>).type;
    if (itemType === 'mcp_tool_call') usage.mcpToolCalls += 1;
    if (itemType === 'command_execution') usage.commandExecutions += 1;
  }
  if (!completedTurns) return undefined;
  usage.totalTokens = usage.inputTokens + usage.outputTokens;
  usage.uncachedTokens = Math.max(0, usage.inputTokens - usage.cachedInputTokens) + usage.outputTokens;
  return usage;
}

export function qualityScore(checks: CheckMeasurement[]) {
  const total = checks.reduce((sum, check) => sum + check.weight, 0);
  if (!total) return 0;
  return checks.reduce((sum, check) => sum + (check.passed ? check.weight : 0), 0) / total;
}

export function lifecycleScore(stages: string[]) {
  return new Set(stages).size / lifecycleStages.length;
}

function mean(values: number[]) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}

function tCritical95(degreesOfFreedom: number) {
  const values = [Infinity, 12.706, 4.303, 3.182, 2.776, 2.571, 2.447, 2.365, 2.306, 2.262, 2.228];
  if (degreesOfFreedom <= 10) return values[Math.max(1, degreesOfFreedom)];
  if (degreesOfFreedom <= 15) return 2.131;
  if (degreesOfFreedom <= 20) return 2.086;
  if (degreesOfFreedom <= 30) return 2.042;
  return 1.96;
}

export function confidence95(values: number[]): [number, number] {
  const average = mean(values);
  if (values.length < 2) return [-1, 1];
  const variance = values.reduce((sum, value) => sum + (value - average) ** 2, 0) / (values.length - 1);
  const margin = tCritical95(values.length - 1) * Math.sqrt(variance / values.length);
  return [Math.max(-1, average - margin), Math.min(1, average + margin)];
}

const ratio = (numerator: number, denominator: number) => (denominator > 0 ? numerator / denominator : undefined);

export function buildEvaluationReport(experiment: EvaluationExperiment, trials: TrialMeasurement[]): EvaluationReport {
  const valid = trials.filter((trial) => trial.valid);
  const deltas = valid.map((trial) => trial.qualityDelta);
  const confidence = confidence95(deltas);
  const criticalRegressions = valid.flatMap((trial) =>
    trial.harness.checks
      .filter(
        (check) =>
          check.severity === 'critical' &&
          !check.passed &&
          trial.baseline.checks.find((baseline) => baseline.id === check.id)?.passed,
      )
      .map((check) => `${trial.id}/${check.id}`),
  );
  const usageComplete = valid.length > 0 && valid.every((trial) => trial.baseline.usage && trial.harness.usage);
  const baselineTotalTokens = usageComplete
    ? valid.reduce((sum, trial) => sum + trial.baseline.usage!.totalTokens, 0)
    : undefined;
  const harnessTotalTokens = usageComplete
    ? valid.reduce((sum, trial) => sum + trial.harness.usage!.totalTokens, 0)
    : undefined;
  const baselineUncachedTokens = usageComplete
    ? valid.reduce((sum, trial) => sum + trial.baseline.usage!.uncachedTokens, 0)
    : undefined;
  const harnessUncachedTokens = usageComplete
    ? valid.reduce((sum, trial) => sum + trial.harness.usage!.uncachedTokens, 0)
    : undefined;
  const totalTokenRatio =
    baselineTotalTokens === undefined || harnessTotalTokens === undefined
      ? undefined
      : ratio(harnessTotalTokens, baselineTotalTokens);
  const uncachedTokenRatio =
    baselineUncachedTokens === undefined || harnessUncachedTokens === undefined
      ? undefined
      : ratio(harnessUncachedTokens, baselineUncachedTokens);
  const baselineMcpToolCalls = usageComplete
    ? valid.reduce((sum, trial) => sum + trial.baseline.usage!.mcpToolCalls, 0)
    : undefined;
  const harnessMcpToolCalls = usageComplete
    ? valid.reduce((sum, trial) => sum + trial.harness.usage!.mcpToolCalls, 0)
    : undefined;
  const baselineCommandExecutions = usageComplete
    ? valid.reduce((sum, trial) => sum + trial.baseline.usage!.commandExecutions, 0)
    : undefined;
  const harnessCommandExecutions = usageComplete
    ? valid.reduce((sum, trial) => sum + trial.harness.usage!.commandExecutions, 0)
    : undefined;
  const wallTimeComplete =
    valid.length > 0 &&
    valid.every((trial) => trial.baseline.wallTimeMs !== undefined && trial.harness.wallTimeMs !== undefined);
  const baselineWallTimeMs = wallTimeComplete
    ? valid.reduce((sum, trial) => sum + trial.baseline.wallTimeMs!, 0)
    : undefined;
  const harnessWallTimeMs = wallTimeComplete
    ? valid.reduce((sum, trial) => sum + trial.harness.wallTimeMs!, 0)
    : undefined;
  const enoughTrials = valid.length >= experiment.thresholds.minimumPairedTrials;
  const qualityProven = enoughTrials && confidence[0] > 0 && !criticalRegressions.length;
  const efficientAndNonInferior =
    enoughTrials &&
    confidence[0] >= -experiment.thresholds.qualityNonInferiority &&
    totalTokenRatio !== undefined &&
    totalTokenRatio <= 1 - experiment.thresholds.tokenReductionTarget &&
    !criticalRegressions.length;
  const qualityRegressed =
    criticalRegressions.length > 0 || (enoughTrials && confidence[1] < -experiment.thresholds.qualityNonInferiority);

  let verdict: EvaluationReport['verdict'] = 'inconclusive';
  let claim = 'The available paired evidence is inconclusive; no benefit claim is justified yet.';
  if (!valid.length) {
    verdict = 'invalid';
    claim = 'No valid paired trials were measured.';
  } else if (qualityRegressed) {
    verdict = 'regressed';
    claim = 'The harness regressed quality on the paired benchmark and must not be presented as beneficial.';
  } else if (qualityProven) {
    verdict = 'beneficial';
    if (totalTokenRatio === undefined) {
      claim = 'The harness produced a statistically supported quality improvement; token cost is unavailable.';
    } else if (totalTokenRatio > 1) {
      claim = 'The harness produced a statistically supported quality improvement, with a measured token cost.';
    } else {
      claim = 'The harness produced a statistically supported quality improvement without increasing measured tokens.';
    }
  } else if (efficientAndNonInferior) {
    verdict = 'beneficial';
    claim = 'Quality was non-inferior and measured token usage met the configured reduction target.';
  }

  const limitations: string[] = [
    'The evaluator cannot prove that held-out checks were concealed from both agents; the experiment operator must preserve blinding.',
  ];
  if (!enoughTrials)
    limitations.push(
      `Only ${valid.length} valid paired ${valid.length === 1 ? 'trial is' : 'trials are'} available; ${experiment.thresholds.minimumPairedTrials} are required.`,
    );
  if (!usageComplete)
    limitations.push('Codex JSONL usage is missing for one or more variants; efficiency is unproven.');
  if (!wallTimeComplete) limitations.push('Wall time is missing for one or more variants; speed is unproven.');
  if (valid.some((trial) => trial.baseline.lifecycleStages.length === 0 || trial.harness.lifecycleStages.length === 0))
    limitations.push('Lifecycle completion was not recorded for one or more variants.');
  if (trials.some((trial) => !trial.valid))
    limitations.push('Invalid trials were excluded; inspect their fairness issues.');

  return {
    name: experiment.name,
    harnessRevision: experiment.harnessRevision,
    policyRevision: experiment.policyRevision,
    generatedAt: new Date().toISOString(),
    verdict,
    claim,
    pairedTrials: trials.length,
    validTrials: valid.length,
    quality: {
      baselineMean: mean(valid.map((trial) => trial.baseline.qualityScore)),
      harnessMean: mean(valid.map((trial) => trial.harness.qualityScore)),
      meanDelta: mean(deltas),
      confidence95: confidence,
      wins: deltas.filter((delta) => delta > 0.001).length,
      ties: deltas.filter((delta) => Math.abs(delta) <= 0.001).length,
      losses: deltas.filter((delta) => delta < -0.001).length,
      criticalRegressions,
    },
    usage: {
      complete: usageComplete,
      baselineTotalTokens,
      harnessTotalTokens,
      totalTokenRatio,
      baselineUncachedTokens,
      harnessUncachedTokens,
      uncachedTokenRatio,
      baselineMcpToolCalls,
      harnessMcpToolCalls,
      baselineCommandExecutions,
      harnessCommandExecutions,
    },
    process: {
      baselineWallTimeMs,
      harnessWallTimeMs,
      baselineInterventions: valid.reduce((sum, trial) => sum + trial.baseline.humanInterventions, 0),
      harnessInterventions: valid.reduce((sum, trial) => sum + trial.harness.humanInterventions, 0),
      baselineRepairIterations: valid.reduce((sum, trial) => sum + trial.baseline.repairIterations, 0),
      harnessRepairIterations: valid.reduce((sum, trial) => sum + trial.harness.repairIterations, 0),
    },
    limitations,
    trials,
  };
}

const percent = (value: number) => `${(value * 100).toFixed(1)}%`;
const tokenRatio = (value?: number) => (value === undefined ? 'unavailable' : `${value.toFixed(2)}x`);
const duration = (value?: number) => (value === undefined ? 'unavailable' : `${(value / 1000).toFixed(1)}s`);
const tableCell = (value: string) => value.replaceAll('|', '\\|').replaceAll(/\r?\n/g, ' ');

export function markdownReport(report: EvaluationReport) {
  const trialRows = report.trials
    .map(
      (trial) =>
        `| ${tableCell(trial.id)} | ${tableCell(`${trial.model} / ${trial.reasoningEffort}`)} | ${tableCell(trial.valid ? 'valid' : trial.fairnessIssues.join('; '))} | ${percent(trial.baseline.qualityScore)} | ${percent(trial.harness.qualityScore)} | ${trial.qualityDelta >= 0 ? '+' : ''}${percent(trial.qualityDelta)} | ${tokenRatio(trial.totalTokenRatio)} |`,
    )
    .join('\n');
  const failureRows = report.trials.flatMap((trial) =>
    (['baseline', 'harness'] as const).flatMap((variant) =>
      trial[variant].checks
        .filter((check) => !check.passed)
        .map(
          (check) =>
            `| ${tableCell(trial.id)} | ${variant} | ${tableCell(check.id)} | ${check.kind} | ${check.severity} | ${tableCell(check.findings.join('; '))} |`,
        ),
    ),
  );
  const failures = failureRows.length
    ? `| Trial | Variant | Check | Kind | Severity | Evidence |\n| --- | --- | --- | --- | --- | --- |\n${failureRows.join('\n')}`
    : 'No failed checks.';
  return `# ${report.name}\n\n**Verdict: ${report.verdict.toUpperCase()}**\n\n${report.claim}\n\n- Harness revision: ${report.harnessRevision}\n- Policy revision: ${report.policyRevision}\n\n## Quality\n\n| Metric | Baseline | Harness |\n| --- | ---: | ---: |\n| Mean held-out quality | ${percent(report.quality.baselineMean)} | ${percent(report.quality.harnessMean)} |\n| Paired wins / ties / losses | - | ${report.quality.wins} / ${report.quality.ties} / ${report.quality.losses} |\n| Mean quality delta | - | ${report.quality.meanDelta >= 0 ? '+' : ''}${percent(report.quality.meanDelta)} |\n| 95% confidence interval | - | ${percent(report.quality.confidence95[0])} to ${percent(report.quality.confidence95[1])} |\n| Critical regressions | - | ${report.quality.criticalRegressions.length} |\n\n## Usage and effort\n\n| Metric | Baseline | Harness | Ratio |\n| --- | ---: | ---: | ---: |\n| Total tokens | ${report.usage.baselineTotalTokens ?? 'unavailable'} | ${report.usage.harnessTotalTokens ?? 'unavailable'} | ${tokenRatio(report.usage.totalTokenRatio)} |\n| Uncached tokens | ${report.usage.baselineUncachedTokens ?? 'unavailable'} | ${report.usage.harnessUncachedTokens ?? 'unavailable'} | ${tokenRatio(report.usage.uncachedTokenRatio)} |\n| MCP tool calls | ${report.usage.baselineMcpToolCalls ?? 'unavailable'} | ${report.usage.harnessMcpToolCalls ?? 'unavailable'} | - |\n| Command executions | ${report.usage.baselineCommandExecutions ?? 'unavailable'} | ${report.usage.harnessCommandExecutions ?? 'unavailable'} | - |\n| Wall time | ${duration(report.process.baselineWallTimeMs)} | ${duration(report.process.harnessWallTimeMs)} | - |\n| Human interventions | ${report.process.baselineInterventions} | ${report.process.harnessInterventions} | - |\n| Repair iterations | ${report.process.baselineRepairIterations} | ${report.process.harnessRepairIterations} | - |\n\n## Paired trials\n\n| Trial | Model / effort | Fairness | Baseline quality | Harness quality | Delta | Token ratio |\n| --- | --- | --- | ---: | ---: | ---: | ---: |\n${trialRows}\n\n## Failed checks\n\n${failures}\n\n## Limitations\n\n${report.limitations.length ? report.limitations.map((item) => `- ${item}`).join('\n') : '- None recorded.'}\n`;
}
