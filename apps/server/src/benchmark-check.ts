import { execFile, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { z } from 'zod';

const exec = promisify(execFile);

export const benchmarkCheckSchema = z.object({
  image: z
    .string()
    .min(1)
    .max(300)
    .regex(/^[a-zA-Z0-9][a-zA-Z0-9./_:@-]*$/),
  commands: z
    .array(
      z.object({
        label: z.string().min(1).max(120),
        command: z.string().min(1).max(20_000),
      }),
    )
    .min(1)
    .max(20),
  relatedTests: z
    .object({
      label: z.string().min(1).max(120),
      argv: z.array(z.string().min(1).max(1_000)).min(1).max(20),
      baselineCommands: z.array(z.string().min(1).max(20_000)).max(10).default([]),
      extensions: z
        .array(z.string().regex(/^\.[a-zA-Z0-9]+$/))
        .min(1)
        .max(20)
        .default(['.js', '.jsx', '.ts', '.tsx', '.svelte']),
    })
    .optional(),
  timeoutSeconds: z.number().int().min(30).max(3600).default(1800),
});

export type BenchmarkCheck = z.infer<typeof benchmarkCheckSchema>;

interface ProcessResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

async function processResult(command: string, args: string[], cwd: string, timeoutMs: number): Promise<ProcessResult> {
  const child = spawn(command, args, {
    cwd,
    env: process.env,
    shell: false,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
  child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
  const timer = setTimeout(() => child.kill(), timeoutMs);
  const exitCode = await new Promise<number>((resolvePromise, reject) => {
    child.once('error', reject);
    child.once('close', (code) => resolvePromise(code ?? 1));
  }).finally(() => clearTimeout(timer));
  return {
    exitCode,
    stdout: Buffer.concat(stdout).toString('utf8'),
    stderr: Buffer.concat(stderr).toString('utf8'),
  };
}

async function workspacePatch(root: string, patchPath: string) {
  const untracked = (
    await exec('git', ['ls-files', '--others', '--exclude-standard', '-z'], {
      cwd: root,
      windowsHide: true,
      encoding: 'buffer',
      maxBuffer: 20 * 1024 * 1024,
    })
  ).stdout
    .toString('utf8')
    .split('\0')
    .filter(Boolean);
  if (untracked.length)
    await exec('git', ['add', '--intent-to-add', '--', ...untracked], { cwd: root, windowsHide: true });
  try {
    const [patch, names] = await Promise.all([
      exec('git', ['diff', '--binary', 'HEAD'], {
        cwd: root,
        windowsHide: true,
        encoding: 'buffer',
        maxBuffer: 100 * 1024 * 1024,
      }),
      exec('git', ['diff', '--name-only', '--diff-filter=ACMRT', '-z', 'HEAD'], {
        cwd: root,
        windowsHide: true,
        encoding: 'buffer',
        maxBuffer: 20 * 1024 * 1024,
      }),
    ]);
    await writeFile(patchPath, patch.stdout);
    return {
      bytes: patch.stdout.length,
      changedFiles: names.stdout.toString('utf8').split('\0').filter(Boolean),
    };
  } finally {
    if (untracked.length) await exec('git', ['reset', '--quiet', '--', ...untracked], { cwd: root, windowsHide: true });
  }
}

function tail(value: string, max = 12_000) {
  return value.length <= max ? value : value.slice(-max);
}

async function startContainer(container: string, image: string, root: string, timeoutMs: number) {
  const created = await processResult(
    'docker',
    ['run', '--detach', '--interactive', '--tty', '--name', container, '--workdir', '/testbed', image, '/bin/bash'],
    root,
    timeoutMs,
  );
  if (created.exitCode !== 0) throw new Error(`Docker task container failed to start:\n${tail(created.stderr)}`);
}

export function vitestFailures(raw: string) {
  const report = JSON.parse(raw) as {
    testResults?: Array<{
      name?: string;
      status?: string;
      message?: string;
      assertionResults?: Array<{ status?: string; fullName?: string; title?: string }>;
    }>;
  };
  const failures = new Set<string>();
  for (const suite of report.testResults || []) {
    let assertionFailure = false;
    for (const assertion of suite.assertionResults || []) {
      if (assertion.status !== 'failed') continue;
      assertionFailure = true;
      failures.add(`test:${suite.name || 'unknown'}:${assertion.fullName || assertion.title || 'unknown'}`);
    }
    if (suite.status === 'failed' && !assertionFailure) {
      const message = (suite.message || 'suite failed')
        .replaceAll('\u001b', '')
        .replace(/\[[0-9;]*m/g, '')
        .split(/\r?\n/, 1)[0];
      failures.add(`suite:${suite.name || 'unknown'}:${message}`);
    }
  }
  return failures;
}

async function runVitestReport(
  container: string,
  argv: string[],
  changedFiles: string[],
  root: string,
  timeoutMs: number,
) {
  const reportPath = '/tmp/sdlc-related-tests.json';
  await processResult('docker', ['exec', container, 'rm', '-f', reportPath], root, timeoutMs);
  const test = await processResult(
    'docker',
    ['exec', container, ...argv, '--reporter=json', `--outputFile=${reportPath}`, ...changedFiles],
    root,
    timeoutMs,
  );
  const report = await processResult('docker', ['exec', container, 'cat', reportPath], root, timeoutMs);
  if (report.exitCode !== 0 || !report.stdout.trim()) {
    throw new Error(`Related tests did not produce a Vitest JSON report:\n${tail(test.stderr || test.stdout)}`);
  }
  return vitestFailures(report.stdout);
}

export async function runBenchmarkCheck(config: BenchmarkCheck, root = process.cwd()) {
  const checked = benchmarkCheckSchema.parse(config);
  const id = randomUUID();
  const container = `sdlc-public-check-${id}`;
  const baselineContainer = `sdlc-public-base-${id}`;
  const scratch = resolve(tmpdir(), 'sdlc-public-checks', id);
  const patchPath = join(scratch, 'candidate.diff');
  await mkdir(scratch, { recursive: true });
  const patch = await workspacePatch(root, patchPath);
  if (!patch.bytes) throw new Error('The benchmark checkout has no candidate patch to verify');
  const timeoutMs = checked.timeoutSeconds * 1_000;
  try {
    await startContainer(container, checked.image, root, timeoutMs);
    const copied = await processResult(
      'docker',
      ['cp', patchPath, `${container}:/tmp/candidate.diff`],
      root,
      timeoutMs,
    );
    if (copied.exitCode !== 0)
      throw new Error(`Candidate patch could not enter the container:\n${tail(copied.stderr)}`);
    const applied = await processResult(
      'docker',
      ['exec', container, 'git', 'apply', '--whitespace=nowarn', '/tmp/candidate.diff'],
      root,
      timeoutMs,
    );
    if (applied.exitCode !== 0)
      throw new Error(
        `Candidate patch does not apply to the benchmark base:\n${tail(applied.stderr || applied.stdout)}`,
      );
    for (const check of checked.commands) {
      const result = await processResult(
        'docker',
        ['exec', container, '/bin/bash', '-lc', check.command],
        root,
        timeoutMs,
      );
      process.stdout.write(tail(result.stdout));
      process.stderr.write(tail(result.stderr));
      if (result.exitCode !== 0) return { passed: false, failedLabel: check.label, exitCode: result.exitCode };
    }
    if (checked.relatedTests) {
      const related = patch.changedFiles.filter((path) =>
        checked.relatedTests!.extensions.some((extension) => path.toLowerCase().endsWith(extension.toLowerCase())),
      );
      if (related.length) {
        await startContainer(baselineContainer, checked.image, root, timeoutMs);
        for (const command of checked.relatedTests.baselineCommands) {
          const setup = await processResult(
            'docker',
            ['exec', baselineContainer, '/bin/bash', '-lc', command],
            root,
            timeoutMs,
          );
          if (setup.exitCode !== 0)
            throw new Error(`Baseline test setup failed:\n${tail(setup.stderr || setup.stdout)}`);
        }
        const baselineFailures = await runVitestReport(
          baselineContainer,
          checked.relatedTests.argv,
          related,
          root,
          timeoutMs,
        );
        const candidateFailures = await runVitestReport(container, checked.relatedTests.argv, related, root, timeoutMs);
        const regressions = [...candidateFailures].filter((failure) => !baselineFailures.has(failure));
        if (regressions.length) {
          process.stderr.write(`New related-test failures:\n${regressions.slice(0, 20).join('\n')}\n`);
          return { passed: false, failedLabel: checked.relatedTests.label, exitCode: 1 };
        }
        process.stdout.write(
          `Related tests introduced no new failures (${candidateFailures.size} candidate, ${baselineFailures.size} baseline).\n`,
        );
      }
    }
    return { passed: true, exitCode: 0 };
  } finally {
    await processResult('docker', ['rm', '--force', container], root, 30_000).catch(() => undefined);
    await processResult('docker', ['rm', '--force', baselineContainer], root, 30_000).catch(() => undefined);
    await rm(scratch, { recursive: true, force: true });
  }
}

export async function readBenchmarkCheck(path: string) {
  return benchmarkCheckSchema.parse(JSON.parse(await readFile(path, 'utf8')));
}
