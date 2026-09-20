import { readFile } from 'node:fs/promises';
import { basename, resolve } from 'node:path';
import { repositorySchema, type CheckCommand, type RepositoryConfig } from '../../../shared/types.js';
import { inspectDefaultBranch, listWorkspaceFiles, type InspectedWorkspace } from './workspace.js';

type Stack = RepositoryConfig['stack'];

export interface RepositoryDiscovery {
  repository: RepositoryConfig;
  questions: string[];
}

const gate = (
  id: string,
  kind: CheckCommand['kind'],
  argv: string[],
  report: CheckCommand['report'] = 'exit',
  reportPath = '',
): CheckCommand => ({
  id,
  label: id.replaceAll('-', ' '),
  argv,
  required: true,
  kind,
  report,
  reportPath,
  timeoutSeconds: 600,
});

const securityGates = () => [
  gate('secrets', 'security', ['@sdlc/security', 'secrets'], 'gitleaks', '.reports/secrets.json'),
  gate('sast', 'security', ['@sdlc/security', 'sast'], 'semgrep', '.reports/sast.json'),
];

async function text(root: string, path: string) {
  return readFile(resolve(root, path), 'utf8').catch(() => '');
}

async function json<T>(root: string, path: string): Promise<T | undefined> {
  try {
    return JSON.parse(await readFile(resolve(root, path), 'utf8')) as T;
  } catch {
    return undefined;
  }
}

function folders(files: string[]) {
  return new Set(
    files.flatMap((file) =>
      file
        .split('/')
        .slice(0, -1)
        .map((_, index) =>
          file
            .split('/')
            .slice(0, index + 1)
            .join('/'),
        ),
    ),
  );
}

function detectStack(files: string[]): { stack: Stack; confidence: 'high' | 'medium' | 'low'; evidence: string[] } {
  const typescript = [
    'package.json',
    'package-lock.json',
    'npm-shrinkwrap.json',
    'tsconfig.json',
    'pnpm-lock.yaml',
    'yarn.lock',
    'bun.lock',
    'bun.lockb',
  ].filter((file) => files.includes(file));
  const python = ['pyproject.toml', 'uv.lock', 'poetry.lock', 'requirements.txt'].filter((file) =>
    files.includes(file),
  );
  if (typescript.length && !python.length) return { stack: 'typescript', confidence: 'high', evidence: typescript };
  if (python.length && !typescript.length) return { stack: 'python', confidence: 'high', evidence: python };
  if (typescript.length > python.length)
    return { stack: 'typescript', confidence: 'medium', evidence: [...typescript, ...python] };
  if (python.length > typescript.length)
    return { stack: 'python', confidence: 'medium', evidence: [...python, ...typescript] };
  return { stack: 'custom', confidence: 'low', evidence: files.slice(0, 8) };
}

type PackageJson = {
  scripts?: Record<string, string>;
  packageManager?: string;
};

function nodeCommand(manager: string, script: string) {
  if (manager === 'npm' && script === 'test') return ['npm', 'test'];
  return [manager, 'run', script];
}

async function typescriptChecks(root: string, files: string[]) {
  const warnings: string[] = [];
  const pkg = await json<PackageJson>(root, 'package.json');
  const scripts = pkg?.scripts || {};
  const declaredManager = pkg?.packageManager?.split('@')[0];
  const manager = files.includes('pnpm-lock.yaml')
    ? 'pnpm'
    : files.includes('yarn.lock')
      ? 'yarn'
      : files.some((file) => basename(file).startsWith('bun.lock'))
        ? 'bun'
        : declaredManager && ['npm', 'pnpm', 'yarn', 'bun'].includes(declaredManager)
          ? declaredManager
          : 'npm';
  const checks: CheckCommand[] = [];
  const hasLock =
    (manager === 'npm' && (files.includes('package-lock.json') || files.includes('npm-shrinkwrap.json'))) ||
    (manager === 'pnpm' && files.includes('pnpm-lock.yaml')) ||
    (manager === 'yarn' && files.includes('yarn.lock')) ||
    (manager === 'bun' && files.some((file) => basename(file).startsWith('bun.lock')));
  if (manager === 'npm' && hasLock) checks.push(gate('install', 'setup', ['npm', 'ci']));
  else if (manager === 'pnpm' && hasLock)
    checks.push(gate('install', 'setup', ['pnpm', 'install', '--frozen-lockfile']));
  else if (manager === 'yarn' && hasLock)
    checks.push(
      gate('install', 'setup', [
        'yarn',
        'install',
        pkg?.packageManager?.startsWith('yarn@1.') ? '--frozen-lockfile' : '--immutable',
      ]),
    );
  else if (manager === 'bun' && hasLock) checks.push(gate('install', 'setup', ['bun', 'install', '--frozen-lockfile']));
  else
    warnings.push(
      `No ${manager} lockfile was found; no non-reproducible dependency-install command was added. Codex should create or restore the lockfile if installation is required.`,
    );

  const script = (id: string, kind: CheckCommand['kind'], candidates: string[]) => {
    const name = candidates.find((candidate) => scripts[candidate]);
    if (name) checks.push(gate(id, kind, nodeCommand(manager, name)));
  };
  script('build', 'build', ['build']);
  script('lint', 'lint', ['lint']);
  script('typecheck', 'types', ['typecheck', 'type-check', 'check:types']);
  script('unit', 'unit', ['test:unit', 'unit']);
  script('integration', 'integration', ['test:integration', 'integration']);
  script('e2e', 'e2e', ['test:e2e', 'e2e']);
  if (!checks.some((check) => ['unit', 'integration', 'e2e'].includes(check.kind))) {
    checks.push(gate('unit', 'unit', nodeCommand(manager, 'test')));
    if (!scripts.test)
      warnings.push('No test script was found; the required test gate will fail until Codex adds one.');
  }
  checks.push(...securityGates());
  if (manager === 'npm' && files.includes('package-lock.json'))
    checks.push(gate('dependencies', 'security', ['npm', 'audit', '--json'], 'npm-audit', '.reports/audit.json'));
  else warnings.push(`Dependency auditing for ${manager} needs confirmation or a company-specific gate.`);
  return {
    checks,
    warnings,
    evidence: [`Package manager: ${manager}`, `Scripts: ${Object.keys(scripts).sort().join(', ') || 'none'}`],
  };
}

async function pythonChecks(root: string, files: string[], directorySet: Set<string>) {
  const pyproject = await text(root, 'pyproject.toml');
  const manager = files.includes('uv.lock') ? 'uv' : files.includes('poetry.lock') ? 'poetry' : 'python';
  const run = (args: string[]) =>
    manager === 'uv'
      ? ['uv', 'run', '--no-sync', ...args]
      : manager === 'poetry'
        ? ['poetry', 'run', ...args]
        : ['python', '-m', ...args];
  const checks: CheckCommand[] = [];
  const warnings: string[] = [];
  if (manager === 'uv') checks.push(gate('install', 'setup', ['uv', 'sync', '--frozen']));
  else if (manager === 'poetry') checks.push(gate('install', 'setup', ['poetry', 'install', '--no-interaction']));
  else warnings.push('No uv.lock or poetry.lock was found; automatic setup will use the active Python environment.');

  if (pyproject.includes('[build-system]'))
    checks.push(gate('build', 'build', manager === 'uv' ? ['uv', 'build'] : ['python', '-m', 'build']));
  if (pyproject.includes('ruff')) checks.push(gate('lint', 'lint', run(['ruff', 'check', '.'])));
  if (pyproject.includes('mypy')) checks.push(gate('typecheck', 'types', run(['mypy', '.'])));

  const pytest = (id: string, kind: CheckCommand['kind'], path: string) =>
    gate(id, kind, run(['pytest', path, `--junitxml=.reports/${id}.xml`]), 'junit', `.reports/${id}.xml`);
  if (directorySet.has('tests/unit')) checks.push(pytest('unit', 'unit', 'tests/unit'));
  if (directorySet.has('tests/integration')) checks.push(pytest('integration', 'integration', 'tests/integration'));
  if (directorySet.has('tests/e2e')) checks.push(pytest('e2e', 'e2e', 'tests/e2e'));
  if (!checks.some((check) => ['unit', 'integration', 'e2e'].includes(check.kind))) {
    checks.push(pytest('unit', 'unit', 'tests'));
    if (!directorySet.has('tests'))
      warnings.push('No tests directory was found; the required test gate will fail until Codex adds tests.');
  }
  checks.push(...securityGates());
  if (pyproject.includes('pip-audit')) {
    const audit =
      manager === 'python'
        ? ['python', '-m', 'pip_audit', '--format=json']
        : manager === 'uv'
          ? ['uv', 'run', '--no-sync', 'pip-audit', '--format=json']
          : ['poetry', 'run', 'pip-audit', '--format=json'];
    checks.push(gate('dependencies', 'security', audit, 'pip-audit', '.reports/audit.json'));
  } else warnings.push('No Python dependency-audit command was detected; add one in repository policy if required.');
  return { checks, warnings, evidence: [`Python environment: ${manager}`] };
}

function workflowEvidence(files: string[]) {
  const workflows = files.filter((file) => file.startsWith('.github/workflows/') && /\.ya?ml$/i.test(file));
  const deployment = workflows.find((file) => /(?:deploy|release)/i.test(basename(file)));
  return {
    workflows,
    deployment,
    evidence: workflows.map((file) => `GitHub workflow: ${file}`),
  };
}

function pathPolicy(files: string[], stack: Stack) {
  const dirs = folders(files);
  const sourceCandidates =
    stack === 'python'
      ? ['src/**', 'app/**', 'apps/**', '**/*.py']
      : ['src/**', 'app/**', 'apps/**', 'lib/**', 'packages/**/src/**', '**/*.ts', '**/*.tsx', '**/*.js', '**/*.jsx'];
  const testCandidates = ['test/**', 'tests/**', '**/__tests__/**', '**/*.test.*', '**/*.spec.*'];
  const sourcePaths = sourceCandidates.filter((glob) => glob.startsWith('**') || dirs.has(glob.split('/')[0]));
  const testPaths = testCandidates.filter((glob) => glob.startsWith('**') || dirs.has(glob.split('/')[0]));
  return {
    sourcePaths: sourcePaths.length ? sourcePaths : sourceCandidates,
    testPaths: testPaths.length ? testPaths : testCandidates,
  };
}

export async function discoverRepository(workspace: InspectedWorkspace): Promise<RepositoryDiscovery> {
  const files = await listWorkspaceFiles(workspace.root);
  const directorySet = folders(files);
  const detected = detectStack(files);
  const stackResult =
    detected.stack === 'typescript'
      ? await typescriptChecks(workspace.root, files)
      : detected.stack === 'python'
        ? await pythonChecks(workspace.root, files, directorySet)
        : {
            checks: securityGates(),
            warnings: ['The project stack and test command could not be detected. Review advanced quality gates.'],
            evidence: [] as string[],
          };
  const workflow = workflowEvidence(files);
  const defaultBranch = await inspectDefaultBranch(workspace.root, workspace.branch || 'main');
  const branch = defaultBranch.branch;
  const paths = pathPolicy(files, detected.stack);
  const warnings = [...stackResult.warnings];
  if (!defaultBranch.verified)
    warnings.push(`The remote default branch could not be verified; ${branch} was copied from the current checkout.`);
  if (!workflow.workflows.length)
    warnings.push('No GitHub Actions workflow was detected; remote CI is waived until confirmed.');
  else
    warnings.push('Required GitHub check names must be confirmed because workflow filenames do not prove check names.');
  if (workflow.deployment)
    warnings.push(
      `Deployment workflow ${workflow.deployment} was detected but remains disabled until explicitly configured.`,
    );
  const evidence = [
    `Remote: ${workspace.owner}/${workspace.repo}`,
    `Base branch: ${branch}`,
    `Stack markers: ${detected.evidence.join(', ') || 'none'}`,
    ...stackResult.evidence,
    ...workflow.evidence,
  ];
  const detectedAt = new Date().toISOString();
  const repository = repositorySchema.parse({
    name: workspace.repo,
    owner: workspace.owner,
    repo: workspace.repo,
    branch,
    stack: detected.stack,
    standards: '',
    checks: stackResult.checks,
    requiredCiChecks: [],
    ciWaiver: 'Automatic setup found no confirmed required GitHub check; review this before production use.',
    protectedPaths: ['.github/workflows/', '.sdlc/'],
    setup: {
      source: 'detected',
      status: 'needs_confirmation',
      confidence: detected.confidence,
      detectedAt,
      confirmedAt: null,
      evidence,
      warnings,
    },
    review: {},
    testEvidence: { requiredForSourceChanges: true, ...paths },
    deployment: {
      enabled: false,
      environment: 'staging',
      workflow: workflow.deployment ? basename(workflow.deployment) : 'deploy.yml',
      rollbackWorkflow: 'rollback.yml',
      healthUrl: '',
      monitorIntervalSeconds: 300,
    },
  });
  const questions = [
    `I detected ${detected.stack} (${detected.confidence} confidence) and ${repository.checks.length} local quality gates. Is that correct?`,
    workflow.workflows.length
      ? `Which GitHub check names are required before merge? Detected workflows: ${workflow.workflows.join(', ')}.`
      : 'Does this repository use remote CI, or should the detected CI waiver remain?',
    workflow.deployment
      ? `A deployment workflow was found at ${workflow.deployment}. Keep deployment disabled, or configure it in the dashboard with a health URL?`
      : 'Should delivery stop after pull-request CI, or is deployment automation required?',
  ];
  return { repository, questions };
}
