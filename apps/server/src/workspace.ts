import { randomUUID } from 'node:crypto';
import { mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import spawn from 'cross-spawn';
import type { CheckCommand, JobResult, WorkspaceState } from '../../../shared/types.js';

const outputLimit = 256_000;

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
  const [executable, ...args] = command.argv;
  const result = await execute(executable, args, root, command.timeoutSeconds, environment);
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
