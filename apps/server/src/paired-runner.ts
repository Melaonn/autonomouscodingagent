import { execFile, spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { finished } from 'node:stream/promises';
import { z } from 'zod';

const exec = promisify(execFile);

const reasoningEffortSchema = z.enum(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra']);

export const pairedRunSchema = z.object({
  name: z.string().min(1),
  harnessRevision: z.string().regex(/^[0-9a-f]{40}$/),
  model: z.string().min(1),
  reasoningEffort: reasoningEffortSchema,
  externalIsolation: z.boolean().default(false),
  executionVariant: z.enum(['both', 'baseline', 'harness']).default('both'),
  sourceCodexHome: z.string().min(1).optional(),
  outputDirectory: z.string().min(1),
  harness: z.object({
    instructionsFile: z.string().min(1),
    mcpCommand: z.string().min(1),
    mcpArgs: z.array(z.string()).default([]),
    serverUrl: z.string().url(),
    tokenEnvironmentVariable: z.string().regex(/^[A-Z][A-Z0-9_]*$/),
  }),
  environmentInstructionsFile: z.string().min(1).optional(),
  tasks: z
    .array(
      z.object({
        id: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/),
        prompt: z.string().min(10).optional(),
        promptFile: z.string().min(1).optional(),
        baseSha: z.string().regex(/^[0-9a-f]{40}$/),
        baselineRoot: z.string().min(1),
        harnessRoot: z.string().min(1),
      }),
    )
    .min(1)
    .refine((tasks) => tasks.every((task) => Boolean(task.prompt) !== Boolean(task.promptFile)), {
      message: 'Each task needs exactly one of prompt or promptFile',
    }),
});

export type PairedRun = z.infer<typeof pairedRunSchema>;
export type PairedTask = PairedRun['tasks'][number];
export type Variant = 'baseline' | 'harness';

export interface CommandResult {
  exitCode: number;
  wallTimeMs: number;
  threadId?: string;
}

export interface HarnessState {
  runId?: string;
  status?: string;
  phase?: string;
  step?: string;
  attempt: number;
}

export interface VariantResult extends CommandResult {
  variant: Variant;
  root: string;
  jsonl: string;
  stderr: string;
  completed: boolean;
  harnessState?: HarnessState;
  reviewJsonl?: string;
  resumeJsonl?: string;
}

export interface TaskResult {
  id: string;
  prompt: string;
  baseSha: string;
  model: string;
  reasoningEffort: PairedRun['reasoningEffort'];
  baseline?: VariantResult;
  harness?: VariantResult;
}

function tomlString(value: string) {
  return JSON.stringify(value);
}

function localPath(base: string, value: string) {
  return isAbsolute(value) ? value : resolve(base, value);
}

export function parseThreadId(jsonl: string) {
  for (const line of jsonl.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const event = JSON.parse(line) as { type?: string; thread_id?: unknown };
      if (event.type === 'thread.started' && typeof event.thread_id === 'string') return event.thread_id;
    } catch {
      // Ignore non-JSON diagnostics; stderr is captured separately.
    }
  }
  return undefined;
}

function toolPayload(item: Record<string, unknown>) {
  const result = item.result;
  if (!result || typeof result !== 'object') return undefined;
  const content = (result as { content?: unknown }).content;
  if (!Array.isArray(content)) return undefined;
  for (const block of content) {
    if (!block || typeof block !== 'object' || (block as { type?: unknown }).type !== 'text') continue;
    const text = (block as { text?: unknown }).text;
    if (typeof text !== 'string') continue;
    try {
      return JSON.parse(text) as Record<string, unknown>;
    } catch {
      continue;
    }
  }
  return undefined;
}

export function parseHarnessState(jsonl: string): HarnessState {
  const state: HarnessState = { attempt: 0 };
  for (const line of jsonl.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const event = JSON.parse(line) as { type?: string; item?: unknown };
      if (event.type !== 'item.completed' || !event.item || typeof event.item !== 'object') continue;
      const item = event.item as Record<string, unknown>;
      if (item.type !== 'mcp_tool_call' || item.server !== 'sdlc') continue;
      const payload = toolPayload(item);
      if (!payload || typeof payload.error === 'string') continue;
      if (item.tool === 'sdlc_start' && typeof payload.runId === 'string') state.runId = payload.runId;
      if (typeof payload.status === 'string') state.status = payload.status;
      if (typeof payload.phase === 'string') state.phase = payload.phase;
      if (typeof payload.step === 'string') state.step = payload.step;
      if (typeof payload.attempt === 'number') state.attempt = Math.max(state.attempt, payload.attempt);
    } catch {
      // Ignore malformed lines and continue parsing the event stream.
    }
  }
  return state;
}

async function gitHead(root: string) {
  const result = await exec('git', ['rev-parse', 'HEAD'], { cwd: root, windowsHide: true });
  return result.stdout.trim();
}

async function gitStatus(root: string) {
  const result = await exec('git', ['status', '--porcelain=v1', '--untracked-files=all'], {
    cwd: root,
    windowsHide: true,
  });
  return result.stdout.trim();
}

async function assertStart(root: string, baseSha: string) {
  const [head, status] = await Promise.all([gitHead(root), gitStatus(root)]);
  if (head !== baseSha) throw new Error(`${root} starts at ${head}, expected ${baseSha}`);
  if (status) throw new Error(`${root} is not clean before the trial`);
}

interface ProcessFiles {
  stdoutPath: string;
  stderrPath: string;
}

async function runProcess(
  command: string,
  args: string[],
  cwd: string,
  environment: NodeJS.ProcessEnv,
  stdoutPath?: string,
  stderrPath?: string,
) {
  const files: ProcessFiles = {
    stdoutPath: stdoutPath || join(cwd, `.paired-stdout-${process.pid}-${Date.now()}.log`),
    stderrPath: stderrPath || join(cwd, `.paired-stderr-${process.pid}-${Date.now()}.log`),
  };
  await mkdir(dirname(files.stdoutPath), { recursive: true });
  const started = performance.now();
  const child = spawn(command, args, {
    cwd,
    env: environment,
    windowsHide: true,
    shell: false,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const stdout = createWriteStream(files.stdoutPath);
  const stderr = createWriteStream(files.stderrPath);
  child.stdout.pipe(stdout);
  child.stderr.pipe(stderr);
  const exitCode = await new Promise<number>((resolvePromise, reject) => {
    child.once('error', reject);
    child.once('close', (code) => resolvePromise(code ?? 1));
  });
  await Promise.all([finished(stdout), finished(stderr)]);
  return { exitCode, wallTimeMs: Math.round(performance.now() - started), ...files };
}

async function createCodexHome(root: string, source: string, instructions: string, config: string) {
  await mkdir(root, { recursive: true });
  const sourceAuth = join(source, 'auth.json');
  try {
    await copyFile(sourceAuth, join(root, 'auth.json'));
  } catch {
    throw new Error(`Codex authentication is missing at ${sourceAuth}; run codex login first`);
  }
  await Promise.all([
    writeFile(join(root, 'AGENTS.md'), instructions.trim() ? `${instructions.trim()}\n` : '', 'utf8'),
    writeFile(join(root, 'config.toml'), `${config.trim()}\n`, 'utf8'),
  ]);
}

function codexConfig(run: PairedRun, variant: Variant, token: string) {
  const common = [
    `model = ${tomlString(run.model)}`,
    `model_reasoning_effort = ${tomlString(run.reasoningEffort)}`,
    '',
    '[features]',
    'multi_agent = false',
  ];
  if (variant === 'baseline') return common.join('\n');
  return [
    ...common,
    '',
    '[mcp_servers.sdlc]',
    `command = ${tomlString(run.harness.mcpCommand)}`,
    `args = [${run.harness.mcpArgs.map(tomlString).join(', ')}]`,
    'tool_timeout_sec = 3600',
    '',
    '[mcp_servers.sdlc.env]',
    `SDLC_CHAT_URL = ${tomlString(run.harness.serverUrl)}`,
    `SDLC_CHAT_TOKEN = ${tomlString(token)}`,
  ].join('\n');
}

const headlessInstructions = `
## Controlled noninteractive run

MANDATORY: your first tool call must be sdlc_start with this checkout's absolute repository root and the complete benchmark request. Do not inspect, edit, or run repository commands before that call. If sdlc_start is unavailable or fails, stop and report the blocker.

This is a pre-authorized, noninteractive paired evaluation. The benchmark request itself is the developer's acceptance of a faithful implementation plan, so continue in this same session without pausing for plan approval. After implementation, call sdlc_verify with the required lifecycle checkpoint, repair every returned failure, and stop when verification asks for native review or reaches a verified delivery state. The repository policy is already prepared. Do all implementation work yourself; do not spawn, delegate, or use collaboration tools. Do not commit, push, publish, or deploy.
`;

function isolationArgs(run: PairedRun) {
  return run.externalIsolation
    ? ['--dangerously-bypass-approvals-and-sandbox']
    : ['-c', 'approval_policy="never"', '--sandbox', 'workspace-write'];
}

function commonCodexArgs(run: PairedRun, root: string) {
  return [
    '--json',
    '--model',
    run.model,
    '-c',
    `model_reasoning_effort=${JSON.stringify(run.reasoningEffort)}`,
    ...isolationArgs(run),
    '--cd',
    root,
  ];
}

async function runInitial(
  run: PairedRun,
  task: PairedTask,
  variant: Variant,
  root: string,
  home: string,
  prompt: string,
  outputDirectory: string,
) {
  const prefix = join(outputDirectory, `${task.id}-${variant}`);
  const result = await runProcess(
    'codex',
    ['exec', ...commonCodexArgs(run, root), prompt],
    root,
    { ...process.env, CODEX_HOME: home },
    `${prefix}.jsonl`,
    `${prefix}.stderr.log`,
  );
  const jsonl = await readFile(result.stdoutPath, 'utf8');
  const harnessState = variant === 'harness' ? parseHarnessState(jsonl) : undefined;
  return {
    variant,
    root,
    jsonl: result.stdoutPath,
    stderr: result.stderrPath,
    exitCode: result.exitCode,
    wallTimeMs: result.wallTimeMs,
    threadId: parseThreadId(jsonl),
    completed: result.exitCode === 0 && (variant === 'baseline' || implementationComplete(harnessState)),
    harnessState,
  } satisfies VariantResult;
}

function implementationComplete(state?: HarnessState) {
  if (!state?.status) return false;
  if (['completed', 'awaiting_approval'].includes(state.status)) return true;
  return state.phase === 'deployment' && ['publish', 'remote-ci'].includes(state.step || '');
}

const reviewSchema = {
  type: 'object',
  properties: {
    summary: { type: 'string' },
    findings: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          severity: { type: 'string', enum: ['critical', 'high', 'medium', 'low'] },
          file: { type: 'string' },
          line: { type: 'integer', minimum: 0 },
          description: { type: 'string' },
          correction: { type: 'string' },
          criterionId: { type: ['string', 'null'] },
        },
        required: ['id', 'severity', 'file', 'line', 'description', 'correction', 'criterionId'],
        additionalProperties: false,
      },
    },
  },
  required: ['summary', 'findings'],
  additionalProperties: false,
};

async function completeHarnessReview(
  run: PairedRun,
  task: PairedTask,
  home: string,
  result: VariantResult,
  outputDirectory: string,
) {
  const state = result.harnessState;
  if (state?.status !== 'needs_review') return result;
  if (!state.runId || !result.threadId) throw new Error(`${task.id}: review requested without run and thread IDs`);
  const schemaPath = join(outputDirectory, 'native-review.schema.json');
  const reviewOutput = join(outputDirectory, `${task.id}-harness-review.json`);
  const reviewJsonl = join(outputDirectory, `${task.id}-harness-review.jsonl`);
  const reviewStderr = join(outputDirectory, `${task.id}-harness-review.stderr.log`);
  await writeFile(schemaPath, `${JSON.stringify(reviewSchema, null, 2)}\n`, 'utf8');
  const review = await runProcess(
    'codex',
    [
      'exec',
      'review',
      '--json',
      '--model',
      run.model,
      '-c',
      `model_reasoning_effort=${JSON.stringify(run.reasoningEffort)}`,
      ...isolationArgs(run),
      '--uncommitted',
      '--output-schema',
      schemaPath,
      '--output-last-message',
      reviewOutput,
      'Review the implementation for correctness, regressions, security, and missing requirements. Report only actionable findings.',
    ],
    result.root,
    { ...process.env, CODEX_HOME: home },
    reviewJsonl,
    reviewStderr,
  );
  if (review.exitCode !== 0) throw new Error(`${task.id}: native review failed; inspect ${reviewStderr}`);
  const reviewPayload = JSON.parse(await readFile(reviewOutput, 'utf8')) as Record<string, unknown>;
  const followUp = [
    `The independent native review for governed run ${state.runId} is complete.`,
    'Call sdlc_review once with scope uncommitted and the exact review below.',
    'If it returns repairing, fix every blocking finding and call sdlc_verify again without a checkpoint.',
    'Stop when the run is verified and ready for publication. Do not commit, push, publish, or deploy.',
    JSON.stringify(reviewPayload),
  ].join('\n\n');
  const resumeJsonl = join(outputDirectory, `${task.id}-harness-resume.jsonl`);
  const resumeStderr = join(outputDirectory, `${task.id}-harness-resume.stderr.log`);
  const resumed = await runProcess(
    'codex',
    [
      'exec',
      'resume',
      '--json',
      '--model',
      run.model,
      '-c',
      `model_reasoning_effort=${JSON.stringify(run.reasoningEffort)}`,
      ...isolationArgs(run),
      result.threadId,
      followUp,
    ],
    result.root,
    { ...process.env, CODEX_HOME: home },
    resumeJsonl,
    resumeStderr,
  );
  const resumedEvents = await readFile(resumeJsonl, 'utf8');
  const combined = `${await readFile(result.jsonl, 'utf8')}\n${await readFile(reviewJsonl, 'utf8')}\n${resumedEvents}`;
  await writeFile(result.jsonl, combined, 'utf8');
  const finalState = parseHarnessState(combined);
  return {
    ...result,
    exitCode: resumed.exitCode,
    wallTimeMs: result.wallTimeMs + review.wallTimeMs + resumed.wallTimeMs,
    completed: resumed.exitCode === 0 && implementationComplete(finalState),
    harnessState: finalState,
    reviewJsonl,
    resumeJsonl,
  };
}

async function taskPrompt(task: PairedTask, base: string) {
  return task.prompt || (await readFile(localPath(base, task.promptFile!), 'utf8')).trim();
}

export async function runPairedExperiment(input: PairedRun, inputBase: string) {
  const outputDirectory = localPath(inputBase, input.outputDirectory);
  const sourceCodexHome = input.sourceCodexHome
    ? localPath(inputBase, input.sourceCodexHome)
    : process.env.CODEX_HOME || join(homedir(), '.codex');
  const environmentInstructions = input.environmentInstructionsFile
    ? await readFile(localPath(inputBase, input.environmentInstructionsFile), 'utf8')
    : '';
  const workflowInstructions = await readFile(localPath(inputBase, input.harness.instructionsFile), 'utf8');
  const token = process.env[input.harness.tokenEnvironmentVariable] || '';
  if (token.length < 32)
    throw new Error(`${input.harness.tokenEnvironmentVariable} must contain the local control-plane token`);
  await mkdir(outputDirectory, { recursive: true });
  const homesRoot = join(outputDirectory, 'codex-homes');
  const baselineHome = join(homesRoot, 'baseline');
  const harnessHome = join(homesRoot, 'harness');
  await Promise.all([
    createCodexHome(baselineHome, sourceCodexHome, environmentInstructions, codexConfig(input, 'baseline', token)),
    createCodexHome(
      harnessHome,
      sourceCodexHome,
      `${headlessInstructions}\n${workflowInstructions}\n${environmentInstructions}`,
      codexConfig(input, 'harness', token),
    ),
  ]);

  const results: TaskResult[] = [];
  for (const task of input.tasks) {
    const baselineRoot = localPath(inputBase, task.baselineRoot);
    const harnessRoot = localPath(inputBase, task.harnessRoot);
    const starts: Promise<void>[] = [];
    if (input.executionVariant !== 'harness') starts.push(assertStart(baselineRoot, task.baseSha));
    if (input.executionVariant !== 'baseline') starts.push(assertStart(harnessRoot, task.baseSha));
    await Promise.all(starts);
    const prompt = await taskPrompt(task, inputBase);
    const baseline =
      input.executionVariant === 'harness'
        ? undefined
        : await runInitial(input, task, 'baseline', baselineRoot, baselineHome, prompt, outputDirectory);
    let harness: VariantResult | undefined;
    if (input.executionVariant !== 'baseline') {
      harness = await runInitial(input, task, 'harness', harnessRoot, harnessHome, prompt, outputDirectory);
      harness = await completeHarnessReview(input, task, harnessHome, harness, outputDirectory);
    }
    results.push({
      id: task.id,
      prompt,
      baseSha: task.baseSha,
      model: input.model,
      reasoningEffort: input.reasoningEffort,
      baseline,
      harness,
    });
    await writeFile(join(outputDirectory, 'run-results.json'), `${JSON.stringify(results, null, 2)}\n`, 'utf8');
  }
  return results;
}

export function resolvePairedRun(raw: unknown, inputPath: string) {
  const parsed = pairedRunSchema.parse(raw);
  const base = dirname(resolve(inputPath));
  return {
    ...parsed,
    harness: {
      ...parsed.harness,
      instructionsFile: localPath(base, parsed.harness.instructionsFile),
      mcpCommand:
        isAbsolute(parsed.harness.mcpCommand) || parsed.harness.mcpCommand.startsWith('.')
          ? localPath(base, parsed.harness.mcpCommand)
          : parsed.harness.mcpCommand,
      mcpArgs: parsed.harness.mcpArgs.map((argument) =>
        argument.startsWith('./') || argument.startsWith('../') ? localPath(base, argument) : argument,
      ),
    },
    environmentInstructionsFile: parsed.environmentInstructionsFile
      ? localPath(base, parsed.environmentInstructionsFile)
      : undefined,
    outputDirectory: localPath(base, parsed.outputDirectory),
    tasks: parsed.tasks.map((task) => ({
      ...task,
      promptFile: task.promptFile ? localPath(base, task.promptFile) : undefined,
      baselineRoot: localPath(base, task.baselineRoot),
      harnessRoot: localPath(base, task.harnessRoot),
    })),
  };
}

export function resultLabel(result: VariantResult) {
  const state = result.harnessState?.status ? ` / ${result.harnessState.status}` : '';
  return `${basename(result.root)}: exit ${result.exitCode}${state}, ${(result.wallTimeMs / 1_000).toFixed(1)}s`;
}
