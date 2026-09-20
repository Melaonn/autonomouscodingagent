import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import spawn from 'cross-spawn';
import type { CheckCommand, JobResult, WorkspaceState } from '../../../shared/types.js';

const outputLimit = 256_000;
const sourceExtensions = new Set([
  '.c',
  '.cjs',
  '.cpp',
  '.cs',
  '.go',
  '.h',
  '.html',
  '.java',
  '.js',
  '.json',
  '.jsx',
  '.mjs',
  '.php',
  '.ps1',
  '.py',
  '.rb',
  '.rs',
  '.sh',
  '.sql',
  '.toml',
  '.ts',
  '.tsx',
  '.vue',
  '.yaml',
  '.yml',
]);

type ProcessResult = Omit<JobResult, 'files'>;

async function execute(
  command: string,
  args: string[],
  cwd: string,
  timeoutSeconds: number,
  environment: NodeJS.ProcessEnv = process.env,
): Promise<ProcessResult> {
  const started = Date.now();
  return new Promise((resolveResult) => {
    let stdout = '';
    let stderr = '';
    let settled = false;
    let timedOut = false;
    const child = spawn(command, args, {
      cwd,
      env: environment,
      detached: process.platform !== 'win32',
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const append = (current: string, chunk: Buffer) => (current + chunk.toString('utf8')).slice(-outputLimit);
    child.stdout?.on('data', (chunk: Buffer) => {
      stdout = append(stdout, chunk);
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr = append(stderr, chunk);
    });
    const timer = setTimeout(() => {
      timedOut = true;
      if (child.pid && process.platform === 'win32')
        spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
      else if (child.pid) {
        try {
          process.kill(-child.pid, 'SIGKILL');
        } catch {
          child.kill('SIGKILL');
        }
      }
    }, timeoutSeconds * 1000);
    const finish = (exitCode: number) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolveResult({ exitCode: timedOut ? 124 : exitCode, stdout, stderr, durationMs: Date.now() - started });
    };
    child.on('error', (error) => {
      stderr = append(stderr, Buffer.from(error.message));
      finish(127);
    });
    child.on('close', (code) => finish(code ?? 1));
  });
}

async function git(root: string, args: string[], environment: NodeJS.ProcessEnv = process.env) {
  const result = await execute('git', args, root, 60, environment);
  if (result.exitCode !== 0) throw new Error(result.stderr.trim() || `git ${args[0]} failed`);
  return result.stdout.trim();
}

async function dependencyFingerprint(root: string) {
  const hash = createHash('sha256');
  let foundLock = false;
  for (const name of ['package.json', 'package-lock.json', 'npm-shrinkwrap.json']) {
    const content = await readFile(resolve(root, name)).catch(() => undefined);
    if (!content) continue;
    if (name !== 'package.json') foundLock = true;
    hash.update(name).update(content);
  }
  if (!foundLock) return undefined;
  hash.update(process.version).update(process.platform).update(process.arch);
  return hash.digest('hex');
}

async function npmInstallCache(root: string) {
  const fingerprint = await dependencyFingerprint(root);
  if (!fingerprint) return undefined;
  const marker = resolve(root, 'node_modules', '.sdlc-install-fingerprint');
  return { fingerprint, marker };
}

async function candidateSources(root: string) {
  const files = (await git(root, ['ls-files', '--cached', '--others', '--exclude-standard', '-z']))
    .split('\0')
    .filter(Boolean)
    .filter((file) => sourceExtensions.has(file.slice(file.lastIndexOf('.')).toLowerCase()));
  const sources: { file: string; text: string }[] = [];
  for (const file of files) {
    const content = await readFile(resolve(root, file)).catch(() => undefined);
    if (!content || content.length > 2_000_000 || content.includes(0)) continue;
    sources.push({ file: file.replaceAll('\\', '/'), text: content.toString('utf8') });
  }
  return sources;
}

async function builtinSecurityCheck(root: string, scanner: string, reportPath: string): Promise<JobResult> {
  const started = Date.now();
  const sources = await candidateSources(root);
  if (scanner === 'secrets') {
    const rules = [
      { id: 'private-key', pattern: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g },
      { id: 'github-token', pattern: /(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{50,})/g },
      { id: 'aws-access-key', pattern: /(?:AKIA|ASIA)[A-Z0-9]{16}/g },
      { id: 'stripe-live-key', pattern: /sk_live_[A-Za-z0-9]{20,}/g },
      { id: 'slack-token', pattern: /xox[baprs]-[A-Za-z0-9-]{20,}/g },
    ];
    const findings = sources.flatMap(({ file, text }) =>
      rules.flatMap((rule) =>
        [...text.matchAll(rule.pattern)].map((match) => ({
          RuleID: rule.id,
          File: file,
          StartLine: text.slice(0, match.index).split(/\r?\n/).length,
        })),
      ),
    );
    return {
      exitCode: findings.length ? 1 : 0,
      stdout: findings.length ? `Found ${findings.length} potential secret(s)` : 'No high-confidence secrets found',
      stderr: '',
      durationMs: Date.now() - started,
      files: { [reportPath]: JSON.stringify(findings) },
    };
  }
  if (scanner === 'sast') {
    const rules = [
      { id: 'dynamic-eval', pattern: /\beval\s*\(/g },
      { id: 'dynamic-function', pattern: /\bnew\s+Function\s*\(/g },
      { id: 'shell-execution', pattern: /\bshell\s*:\s*true\b/g },
      { id: 'disabled-tls-verification', pattern: /\brejectUnauthorized\s*:\s*false\b/g },
      { id: 'disabled-node-tls', pattern: /NODE_TLS_REJECT_UNAUTHORIZED\s*[:=]\s*['"]?0/g },
    ];
    const results = sources.flatMap(({ file, text }) =>
      rules.flatMap((rule) =>
        [...text.matchAll(rule.pattern)].map((match) => ({
          check_id: rule.id,
          path: file,
          start: { line: text.slice(0, match.index).split(/\r?\n/).length },
          extra: { severity: 'ERROR', message: `High-risk pattern: ${rule.id}` },
        })),
      ),
    );
    return {
      exitCode: results.length ? 1 : 0,
      stdout: results.length ? `Found ${results.length} high-risk pattern(s)` : 'No high-risk static patterns found',
      stderr: '',
      durationMs: Date.now() - started,
      files: { [reportPath]: JSON.stringify({ results, errors: [] }) },
    };
  }
  return {
    exitCode: 127,
    stdout: '',
    stderr: `Unknown built-in security scanner: ${scanner}`,
    durationMs: Date.now() - started,
    files: {},
  };
}

function repositoryFromRemote(remote: string) {
  const normalized = remote.replaceAll('\\', '/').replace(/\.git$/, '');
  if (!/^(?:https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)/i.test(normalized))
    throw new Error('The origin remote must be a GitHub repository');
  const match = normalized.match(/[/:]([^/:]+)\/([^/]+)$/);
  if (!match) throw new Error('The local checkout needs an origin remote that identifies owner/repository');
  return { owner: match[1], repo: match[2] };
}

async function treeDigest(root: string) {
  const index = resolve(tmpdir(), `sdlc-index-${randomUUID()}`);
  const environment = { ...process.env, GIT_INDEX_FILE: index };
  try {
    await git(root, ['read-tree', 'HEAD'], environment);
    await git(root, ['add', '-A', '--', '.'], environment);
    return await git(root, ['write-tree'], environment);
  } finally {
    await rm(index, { force: true }).catch(() => undefined);
  }
}

export type InspectedWorkspace = WorkspaceState & {
  root: string;
  owner: string;
  repo: string;
  changedPaths: string[];
};

export async function inspectWorkspace(path: string): Promise<InspectedWorkspace> {
  const requested = await realpath(path);
  const root = await realpath(await git(requested, ['rev-parse', '--show-toplevel']));
  const [remote, branch, headSha, status, changed, untracked, digest] = await Promise.all([
    git(root, ['remote', 'get-url', 'origin']),
    git(root, ['branch', '--show-current']),
    git(root, ['rev-parse', 'HEAD']),
    git(root, ['status', '--short', '--untracked-files=all']),
    git(root, ['diff', '--name-only', '--no-renames', '-z', 'HEAD']),
    git(root, ['ls-files', '--others', '--exclude-standard', '-z']),
    treeDigest(root),
  ]);
  const repository = repositoryFromRemote(remote);
  const changes = status ? status.split(/\r?\n/).filter(Boolean).slice(0, 500) : [];
  return {
    root,
    ...repository,
    branch,
    headSha,
    digest,
    dirty: changes.length > 0,
    changes,
    changedPaths: [...new Set(`${changed}\0${untracked}`.split('\0').filter(Boolean))],
  };
}

function reportFile(root: string, path: string) {
  const file = resolve(root, path);
  const relative = file.slice(root.length).replaceAll('\\', '/');
  if (!relative.startsWith('/') || relative.includes('/../')) throw new Error('Report path escaped the repository');
  return file;
}

export async function executeCheck(root: string, command: CheckCommand): Promise<JobResult> {
  const [executable, ...args] = command.argv;
  if (executable === '@sdlc/security') return builtinSecurityCheck(root, args[0], command.reportPath);
  const installCache =
    command.kind === 'setup' && executable === 'npm' && args.length === 1 && args[0] === 'ci'
      ? await npmInstallCache(root)
      : undefined;
  if (installCache) {
    const stored = await readFile(installCache.marker, 'utf8').catch(() => '');
    if (stored === installCache.fingerprint)
      return {
        exitCode: 0,
        stdout: 'Reused dependency installation; manifests, runtime, platform, and architecture are unchanged.',
        stderr: '',
        durationMs: 0,
        files: {},
        cached: true,
      };
  }
  let reportPath: string | undefined;
  let previousReport: Buffer | undefined;
  if (command.reportPath) {
    reportPath = reportFile(root, command.reportPath);
    previousReport = await readFile(reportPath).catch(() => undefined);
    await mkdir(dirname(reportPath), { recursive: true });
    await rm(reportPath, { force: true });
  }
  const environment = {
    ...process.env,
    CI: 'true',
    FORCE_COLOR: '0',
    ...(command.report === 'playwright' && reportPath ? { PLAYWRIGHT_JSON_OUTPUT_NAME: reportPath } : {}),
  };
  const result = await execute(executable, args, root, command.timeoutSeconds, environment);
  if (installCache && result.exitCode === 0) {
    await mkdir(dirname(installCache.marker), { recursive: true });
    await writeFile(installCache.marker, installCache.fingerprint, 'utf8');
  }
  const files: Record<string, string> = {};
  if (command.reportPath) {
    const content = reportPath ? await readFile(reportPath, 'utf8').catch(() => '') : '';
    files[command.reportPath] = (content || result.stdout).slice(-outputLimit);
    if (reportPath) {
      if (previousReport) await writeFile(reportPath, previousReport);
      else await rm(reportPath, { force: true });
    }
  }
  return { ...result, files };
}
