import { execFile } from 'node:child_process';
import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, resolve } from 'node:path';
import { promisify } from 'node:util';
import {
  buildEvaluationReport,
  evaluationExperimentSchema,
  lifecycleScore,
  markdownReport,
  qualityScore,
  readCodexUsage,
  type CheckMeasurement,
  type EvaluationCheck,
  type EvaluationExperiment,
  type TrialMeasurement,
  type VariantMeasurement,
} from './evaluation.js';
import { executeCheck } from './workspace.js';

const exec = promisify(execFile);

function option(name: string) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function help(): never {
  console.error(
    'Usage: npm run evaluate -- --input <experiment.json> [--out <report-prefix>]\n\n' +
      'Runs the same hidden checks in paired baseline and harness checkouts, parses Codex JSONL usage, and emits JSON and Markdown evidence. It never launches an agent.',
  );
  process.exit(2);
}

function localPath(base: string, value?: string) {
  if (!value) return undefined;
  return isAbsolute(value) ? value : resolve(base, value);
}

async function git(root: string, args: string[]) {
  const result = await exec('git', args, { cwd: root, windowsHide: true, maxBuffer: 10 * 1024 * 1024 });
  return result.stdout.trim();
}

async function baseIsAncestor(root: string, baseSha: string) {
  try {
    await git(root, ['merge-base', '--is-ancestor', baseSha, 'HEAD']);
    return true;
  } catch {
    return false;
  }
}

async function checkWorkspaceState(root: string) {
  return git(root, ['status', '--porcelain=v1', '--untracked-files=all']);
}

function findings(stdout: string, stderr: string) {
  const output = `${stderr}\n${stdout}`.trim();
  if (!output) return ['Command failed without diagnostic output'];
  return output.split(/\r?\n/).filter(Boolean).slice(-12);
}

async function measureChecks(root: string, checks: EvaluationCheck[]) {
  const measured: CheckMeasurement[] = [];
  for (const check of checks) {
    const result = await executeCheck(root, {
      id: check.id,
      label: check.label,
      argv: check.argv,
      required: true,
      kind: 'acceptance',
      report: 'exit',
      reportPath: '',
      timeoutSeconds: check.timeoutSeconds,
    });
    measured.push({
      id: check.id,
      label: check.label,
      kind: check.kind,
      severity: check.severity,
      weight: check.weight,
      passed: result.exitCode === 0,
      exitCode: result.exitCode,
      durationMs: result.durationMs,
      findings: result.exitCode === 0 ? [] : findings(result.stdout, result.stderr),
    });
  }
  return measured;
}

async function measureVariant(
  trial: EvaluationExperiment['trials'][number],
  variant: EvaluationExperiment['trials'][number]['baseline'],
  base: string,
) {
  const root = await realpath(localPath(base, variant.root)!);
  const stateBefore = await checkWorkspaceState(root);
  const [checks, usage] = await Promise.all([
    measureChecks(root, trial.checks),
    readCodexUsage(localPath(base, variant.codexJsonl)),
  ]);
  const stateAfter = await checkWorkspaceState(root);
  const measurement: VariantMeasurement = {
    qualityScore: qualityScore(checks),
    lifecycleScore: lifecycleScore(variant.lifecycleStages),
    checks,
    usage,
    wallTimeMs: variant.wallTimeMs,
    humanInterventions: variant.humanInterventions,
    repairIterations: variant.repairIterations,
    lifecycleStages: variant.lifecycleStages,
    workspaceChangedByEvaluator: stateBefore !== stateAfter,
  };
  return { root, measurement };
}

async function measureTrial(trial: EvaluationExperiment['trials'][number], base: string): Promise<TrialMeasurement> {
  // Run the paired checkouts separately so tests cannot compete for ports,
  // databases, CPU, or other machine-level resources and distort the result.
  const baseline = await measureVariant(trial, trial.baseline, base);
  const harness = await measureVariant(trial, trial.harness, base);
  const fairnessIssues: string[] = [];
  if (baseline.root.toLowerCase() === harness.root.toLowerCase())
    fairnessIssues.push('Baseline and harness resolve to the same checkout');
  if (!(await baseIsAncestor(baseline.root, trial.baseSha)))
    fairnessIssues.push('Baseline checkout does not descend from the declared base commit');
  if (!(await baseIsAncestor(harness.root, trial.baseSha)))
    fairnessIssues.push('Harness checkout does not descend from the declared base commit');
  if (baseline.measurement.workspaceChangedByEvaluator)
    fairnessIssues.push('Evaluation commands modified the baseline checkout');
  if (harness.measurement.workspaceChangedByEvaluator)
    fairnessIssues.push('Evaluation commands modified the harness checkout');
  const baselineTokens = baseline.measurement.usage?.totalTokens;
  const harnessTokens = harness.measurement.usage?.totalTokens;
  const baselineUncached = baseline.measurement.usage?.uncachedTokens;
  const harnessUncached = harness.measurement.usage?.uncachedTokens;
  return {
    id: trial.id,
    task: trial.task,
    model: trial.model,
    reasoningEffort: trial.reasoningEffort,
    baseSha: trial.baseSha,
    valid: fairnessIssues.length === 0,
    fairnessIssues,
    baseline: baseline.measurement,
    harness: harness.measurement,
    qualityDelta: harness.measurement.qualityScore - baseline.measurement.qualityScore,
    totalTokenRatio:
      baselineTokens !== undefined && harnessTokens !== undefined && baselineTokens > 0
        ? harnessTokens / baselineTokens
        : undefined,
    uncachedTokenRatio:
      baselineUncached !== undefined && harnessUncached !== undefined && baselineUncached > 0
        ? harnessUncached / baselineUncached
        : undefined,
  };
}

const input = option('--input');
if (!input) help();
const inputPath = resolve(input);
const base = dirname(inputPath);
const experiment = evaluationExperimentSchema.parse(JSON.parse(await readFile(inputPath, 'utf8')));
const trials: TrialMeasurement[] = [];
for (const trial of experiment.trials) {
  process.stderr.write(`Measuring ${trial.id}...\n`);
  trials.push(await measureTrial(trial, base));
}
const report = buildEvaluationReport(experiment, trials);
const outputPrefix = resolve(option('--out') || resolve(base, 'evaluation-report'));
await mkdir(dirname(outputPrefix), { recursive: true });
await Promise.all([
  writeFile(`${outputPrefix}.json`, `${JSON.stringify(report, null, 2)}\n`, 'utf8'),
  writeFile(`${outputPrefix}.md`, markdownReport(report), 'utf8'),
]);
console.log(`${report.verdict.toUpperCase()}: ${report.claim}`);
console.log(`JSON: ${outputPrefix}.json`);
console.log(`Markdown: ${outputPrefix}.md`);
if (report.verdict === 'invalid' || report.verdict === 'regressed') process.exitCode = 1;
