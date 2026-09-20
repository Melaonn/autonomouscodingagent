import { readFile } from 'node:fs/promises';
import { basename, resolve } from 'node:path';
import { repositorySchema, type CheckCommand, type RepositoryConfig } from '../../../shared/types.js';
import { inspectDefaultBranch, listWorkspaceFiles, type InspectedWorkspace } from './workspace.js';

type Stack = RepositoryConfig['stack'];
type Setup = RepositoryConfig['setup'];
type Capability = Setup['capabilities'][number];
type SetupTask = Setup['tasks'][number];

export interface RepositoryDiscovery {
  repository: RepositoryConfig;
  questions: string[];
}

export interface SetupDecision {
  e2e?: 'required' | 'not_applicable';
  ci?: 'create' | 'preserve' | 'waive';
  requiredCiChecks?: string[];
  ciWaiver?: string;
  deployment?: 'disabled' | 'create' | 'preserve';
  deploymentTarget?: string;
  healthUrl?: string;
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

const capability = (
  id: Capability['id'],
  label: string,
  status: Capability['status'],
  evidence: string[],
  required = true,
): Capability => ({ id, label, status, required, evidence });

const task = (
  id: string,
  title: string,
  reason: string,
  instructions: string[],
  files: string[],
  checkIds: string[],
): SetupTask => ({ id, title, reason, instructions, files, checkIds, status: 'pending' });

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
    files.flatMap((file) => {
      const segments = file.split('/');
      return segments.slice(0, -1).map((_, index) => segments.slice(0, index + 1).join('/'));
    }),
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

function nodeInstall(manager: string, packageManager?: string) {
  if (manager === 'npm') return ['npm', 'ci'];
  if (manager === 'pnpm') return ['pnpm', 'install', '--frozen-lockfile'];
  if (manager === 'yarn')
    return ['yarn', 'install', packageManager?.startsWith('yarn@1.') ? '--frozen-lockfile' : '--immutable'];
  return ['bun', 'install', '--frozen-lockfile'];
}

function nodeAudit(manager: string, packageManager?: string): Pick<CheckCommand, 'argv' | 'report' | 'reportPath'> {
  if (manager === 'npm')
    return { argv: ['npm', 'audit', '--json'], report: 'npm-audit', reportPath: '.reports/audit.json' };
  if (manager === 'pnpm') return { argv: ['pnpm', 'audit', '--json'], report: 'exit', reportPath: '' };
  if (manager === 'yarn')
    return {
      argv: packageManager?.startsWith('yarn@1.') ? ['yarn', 'audit', '--json'] : ['yarn', 'npm', 'audit', '--all'],
      report: 'exit',
      reportPath: '',
    };
  return { argv: ['bun', 'audit'], report: 'exit', reportPath: '' };
}

async function typescriptSetup(root: string, files: string[]) {
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
  const lockfile =
    manager === 'npm'
      ? files.find((file) => ['package-lock.json', 'npm-shrinkwrap.json'].includes(file))
      : manager === 'pnpm'
        ? files.find((file) => file === 'pnpm-lock.yaml')
        : manager === 'yarn'
          ? files.find((file) => file === 'yarn.lock')
          : files.find((file) => basename(file).startsWith('bun.lock'));
  const checks: CheckCommand[] = [gate('install', 'setup', nodeInstall(manager, pkg?.packageManager))];
  const capabilities: Capability[] = [];
  const tasks: SetupTask[] = [];
  const warnings: string[] = [];

  if (lockfile) capabilities.push(capability('dependencies', 'Dependencies', 'ready', [`Lockfile: ${lockfile}`]));
  else {
    capabilities.push(capability('dependencies', 'Dependencies', 'missing', [`Package manager: ${manager}`]));
    tasks.push(
      task(
        'dependency-lock',
        'Create a reproducible dependency lock',
        'Frozen installation cannot be verified without a committed lockfile.',
        [
          `Use the existing ${manager} package manager; do not switch package managers.`,
          'Add only tooling required by the accepted bootstrap plan and preserve application dependency ranges.',
          'Ensure generated dependency and report directories are excluded from Git without hiding source or test files.',
          'Generate and commit the package-manager lockfile, then confirm the frozen install succeeds.',
        ],
        [manager === 'npm' ? 'package-lock.json' : `${manager} lockfile`, '.gitignore'],
        ['install'],
      ),
    );
    warnings.push(`No ${manager} lockfile was found; Codex must create one before verification.`);
  }

  const addScript = (
    id: 'build' | 'lint' | 'typecheck' | 'unit' | 'integration' | 'e2e',
    label: string,
    kind: CheckCommand['kind'],
    candidates: string[],
    required: boolean,
    instructions: string[],
  ) => {
    const existing = candidates.find((candidate) => scripts[candidate]);
    const target = existing || candidates[0];
    if (!required && !existing) {
      capabilities.push(capability(id, label, 'not_applicable', ['No project signal requires this gate.'], false));
      return;
    }
    checks.push(gate(id, kind, nodeCommand(manager, target)));
    if (existing) {
      capabilities.push(capability(id, label, 'ready', [`package.json script: ${existing}`]));
      return;
    }
    capabilities.push(capability(id, label, 'missing', [`Expected package.json script: ${target}`]));
    tasks.push(
      task(
        `${id}-foundation`,
        `Create the ${label.toLowerCase()} foundation`,
        `The repository has no independently runnable ${label.toLowerCase()} command.`,
        [
          ...instructions,
          `Add a deterministic package.json script named ${target}; keep it non-interactive and CI-safe.`,
          'Run the command and fix its first real failures instead of weakening the configuration.',
        ],
        ['package.json'],
        [id],
      ),
    );
  };

  const typed = files.includes('tsconfig.json') || files.some((file) => /\.(?:ts|tsx)$/.test(file));
  addScript('build', 'Build', 'build', ['build'], typed || Boolean(scripts.build), [
    'Use the repository framework or TypeScript compiler already implied by the source tree.',
    'Produce the normal distributable or perform the framework production build; do not use a no-op script.',
  ]);
  addScript('lint', 'Lint', 'lint', ['lint'], true, [
    'Use the lint tool already installed or configure ESLint with rules appropriate to the detected runtime.',
  ]);
  addScript('typecheck', 'Type check', 'types', ['typecheck', 'type-check', 'check:types'], typed, [
    'Use the existing tsconfig and run TypeScript without emitting build output.',
  ]);
  addScript('unit', 'Unit tests', 'unit', ['test:unit', 'unit', 'test'], true, [
    'Prefer an existing test framework; otherwise configure a maintained framework compatible with the project.',
    'Write focused tests for deterministic domain and module behavior, including failure and boundary cases.',
  ]);
  addScript('integration', 'Integration tests', 'integration', ['test:integration', 'integration'], true, [
    'Exercise real module boundaries such as HTTP handlers, persistence adapters, or service integrations.',
    'Keep external services controlled with repository-standard fixtures or local test doubles.',
  ]);
  addScript('e2e', 'End-to-end tests', 'e2e', ['test:e2e', 'e2e'], true, [
    'For a browser application, use Playwright against the real application entry point.',
    'For a backend, exercise the running HTTP or worker boundary through its public interface.',
    'Add a minimal smoke path plus one meaningful failure path; avoid placeholder assertions.',
  ]);
  checks.push(...securityGates());
  capabilities.push(capability('security', 'Security scans', 'ready', ['Built-in secret and high-risk SAST scans']));
  const audit = nodeAudit(manager, pkg?.packageManager);
  checks.push(gate('dependency-audit', 'security', audit.argv, audit.report, audit.reportPath));

  return {
    checks,
    capabilities,
    tasks,
    warnings,
    evidence: [`Package manager: ${manager}`, `Scripts: ${Object.keys(scripts).sort().join(', ') || 'none'}`],
  };
}

async function pythonSetup(root: string, files: string[], directorySet: Set<string>) {
  const pyproject = await text(root, 'pyproject.toml');
  const manager = files.includes('uv.lock') ? 'uv' : files.includes('poetry.lock') ? 'poetry' : 'python';
  const run = (args: string[]) =>
    manager === 'uv'
      ? ['uv', 'run', '--no-sync', ...args]
      : manager === 'poetry'
        ? ['poetry', 'run', ...args]
        : ['python', '-m', ...args];
  const checks: CheckCommand[] = [];
  const capabilities: Capability[] = [];
  const tasks: SetupTask[] = [];
  const warnings: string[] = [];
  const dependencyFile = manager === 'python' ? 'requirements-dev.txt' : manager === 'uv' ? 'uv.lock' : 'poetry.lock';

  if (manager === 'uv') checks.push(gate('install', 'setup', ['uv', 'sync', '--frozen']));
  else if (manager === 'poetry') checks.push(gate('install', 'setup', ['poetry', 'install', '--no-interaction']));
  else checks.push(gate('install', 'setup', ['python', '-m', 'pip', 'install', '-r', 'requirements-dev.txt']));

  const dependencyReady = manager !== 'python' || files.includes('requirements-dev.txt');
  capabilities.push(
    capability(
      'dependencies',
      'Dependencies',
      dependencyReady ? 'ready' : files.includes('requirements.txt') ? 'partial' : 'missing',
      dependencyReady
        ? [`Dependency environment: ${manager}`]
        : [`Expected development dependency file: ${dependencyFile}`],
    ),
  );
  if (!dependencyReady) {
    tasks.push(
      task(
        'dependency-foundation',
        'Create reproducible development dependencies',
        'The active Python environment is not enough to reproduce quality checks on another machine.',
        [
          'Preserve the existing dependency manager and application requirements.',
          'Create requirements-dev.txt with the application requirements plus constrained pytest, Ruff, MyPy, and pip-audit tooling.',
          'Exclude virtual environments, Python caches, coverage, and generated reports without hiding source or tests.',
          'Keep installation non-interactive and verify the resulting environment with pip check.',
        ],
        ['requirements-dev.txt', '.gitignore'],
        ['install'],
      ),
    );
    warnings.push(
      'No uv or Poetry lock was found; Codex must create a reproducible development dependency definition.',
    );
  }

  if (pyproject.includes('[build-system]')) {
    checks.push(
      gate(
        'build',
        'build',
        manager === 'uv' ? ['uv', 'build'] : manager === 'poetry' ? ['poetry', 'build'] : ['python', '-m', 'build'],
      ),
    );
    capabilities.push(capability('build', 'Build', 'ready', ['pyproject.toml build-system']));
  } else
    capabilities.push(
      capability('build', 'Build', 'not_applicable', ['Application repository is not packaged.'], false),
    );

  const addTool = (
    id: 'lint' | 'typecheck',
    label: string,
    configured: boolean,
    args: string[],
    instructions: string[],
  ) => {
    checks.push(gate(id, id === 'lint' ? 'lint' : 'types', run(args)));
    capabilities.push(
      capability(id, label, configured ? 'ready' : 'missing', [
        configured ? `pyproject.toml configures ${args[0]}` : `Missing ${args[0]} configuration`,
      ]),
    );
    if (!configured)
      tasks.push(
        task(
          `${id}-foundation`,
          `Create the ${label.toLowerCase()} foundation`,
          `The repository has no configured ${label.toLowerCase()} gate.`,
          [
            ...instructions,
            'Add focused configuration to pyproject.toml and fix genuine findings without blanket ignores.',
          ],
          ['pyproject.toml', dependencyFile],
          [id],
        ),
      );
  };
  addTool(
    'lint',
    'Lint',
    pyproject.includes('ruff'),
    ['ruff', 'check', '.'],
    ['Configure Ruff for the supported Python version and exclude generated artifacts only.'],
  );
  addTool(
    'typecheck',
    'Type check',
    pyproject.includes('mypy'),
    ['mypy', '.'],
    ['Configure MyPy incrementally for the application source; document narrow third-party exceptions.'],
  );

  const addPytest = (id: 'unit' | 'integration' | 'e2e', label: string, path: string) => {
    checks.push(gate(id, id, run(['pytest', path, `--junitxml=.reports/${id}.xml`]), 'junit', `.reports/${id}.xml`));
    const ready = directorySet.has(path);
    capabilities.push(capability(id, label, ready ? 'ready' : 'missing', [ready ? `${path}/` : `Missing ${path}/`]));
    if (!ready)
      tasks.push(
        task(
          `${id}-foundation`,
          `Create the ${label.toLowerCase()} foundation`,
          `The repository has no isolated ${label.toLowerCase()} suite.`,
          [
            'Reuse pytest and existing fixtures instead of introducing a second test framework.',
            id === 'unit'
              ? 'Cover deterministic domain behavior, boundaries, and failure cases.'
              : id === 'integration'
                ? 'Exercise real application boundaries with controlled persistence and service dependencies.'
                : 'Exercise the application through its public HTTP, CLI, worker, or browser interface with a smoke path and a failure path.',
            'Use meaningful assertions against behavior; do not add placeholder tests merely to satisfy the gate.',
          ],
          [`${path}/`],
          [id],
        ),
      );
  };
  addPytest('unit', 'Unit tests', 'tests/unit');
  addPytest('integration', 'Integration tests', 'tests/integration');
  addPytest('e2e', 'End-to-end tests', 'tests/e2e');
  checks.push(...securityGates());
  capabilities.push(capability('security', 'Security scans', 'ready', ['Built-in secret and high-risk SAST scans']));
  checks.push(
    gate(
      'dependency-audit',
      'security',
      run([manager === 'python' ? 'pip_audit' : 'pip-audit', '--format=json']),
      'pip-audit',
      '.reports/audit.json',
    ),
  );

  return { checks, capabilities, tasks, warnings, evidence: [`Python environment: ${manager}`] };
}

function workflowEvidence(files: string[]) {
  const workflows = files.filter((file) => file.startsWith('.github/workflows/') && /\.ya?ml$/i.test(file));
  const deployment = workflows.find((file) => /(?:deploy|release)/i.test(basename(file)));
  return { workflows, deployment, evidence: workflows.map((file) => `GitHub workflow: ${file}`) };
}

function pathPolicy(files: string[], stack: Stack) {
  const dirs = folders(files);
  const sourceCandidates =
    stack === 'python'
      ? ['src/**', 'app/**', 'apps/**', '**/*.py']
      : ['src/**', 'app/**', 'apps/**', 'lib/**', 'packages/**/src/**', '**/*.ts', '**/*.tsx', '**/*.js', '**/*.jsx'];
  const testCandidates = ['test/**', 'tests/**', '**/__tests__/**', '**/*.test.*', '**/*.spec.*'];
  return {
    sourcePaths: sourceCandidates.filter((glob) => glob.startsWith('**') || dirs.has(glob.split('/')[0])),
    testPaths: testCandidates.filter((glob) => glob.startsWith('**') || dirs.has(glob.split('/')[0])),
  };
}

function replaceCapability(capabilities: Capability[], next: Capability) {
  return [...capabilities.filter((item) => item.id !== next.id), next];
}

export function configureRepositoryBootstrap(
  repository: RepositoryConfig,
  decision: SetupDecision = {},
): RepositoryConfig {
  let checks = [...repository.checks];
  let tasks = [...repository.setup.tasks];
  let capabilities = [...repository.setup.capabilities];
  if ((decision.e2e || 'required') === 'not_applicable') {
    checks = checks.filter((check) => check.id !== 'e2e');
    tasks = tasks.filter((item) => !item.checkIds.includes('e2e'));
    capabilities = replaceCapability(
      capabilities,
      capability('e2e', 'End-to-end tests', 'not_applicable', ['Developer confirmed E2E is not applicable.'], false),
    );
  }

  let requiredCiChecks = repository.requiredCiChecks;
  let ciWaiver = repository.ciWaiver;
  const ci = decision.ci || 'create';
  if (ci === 'create') {
    requiredCiChecks = ['ci'];
    ciWaiver = '';
    checks = [
      ...checks.filter((check) => check.id !== 'ci-config'),
      gate('ci-config', 'acceptance', [
        '@sdlc/setup',
        'github-workflow',
        '.github/workflows/ci.yml',
        'ci',
        'pull_request',
      ]),
    ];
    tasks = [
      ...tasks.filter((item) => item.id !== 'ci-foundation'),
      task(
        'ci-foundation',
        'Create or reconcile GitHub Actions CI',
        'The pull request needs a stable remote quality check named ci.',
        [
          'Preserve useful existing workflows and create or update .github/workflows/ci.yml.',
          'Use a job whose check-run name is exactly ci and trigger it for pull requests and the default branch.',
          'Install dependencies reproducibly; run the repository build, lint, type, unit, integration, and E2E commands; and add CI-appropriate secret, static-analysis, and dependency checks.',
          'Use least-privilege workflow permissions and dependency caches keyed by committed lockfiles.',
        ],
        ['.github/workflows/ci.yml'],
        ['ci-config'],
      ),
    ];
    capabilities = replaceCapability(
      capabilities,
      capability(
        'ci',
        'Continuous integration',
        repository.setup.evidence.some((item) => item.startsWith('GitHub workflow:')) ? 'partial' : 'missing',
        ['Target check: ci'],
      ),
    );
  } else if (ci === 'preserve') {
    requiredCiChecks = (decision.requiredCiChecks || []).map((name) => name.trim()).filter(Boolean);
    if (!requiredCiChecks.length) throw new Error('Preserving CI requires the exact required GitHub check names');
    ciWaiver = '';
    capabilities = replaceCapability(
      capabilities,
      capability(
        'ci',
        'Continuous integration',
        'ready',
        requiredCiChecks.map((name) => `Required check: ${name}`),
      ),
    );
  } else {
    requiredCiChecks = [];
    ciWaiver = decision.ciWaiver?.trim() || 'Developer explicitly waived remote CI during automatic setup.';
    capabilities = replaceCapability(
      capabilities,
      capability('ci', 'Continuous integration', 'not_applicable', [`Waiver: ${ciWaiver}`], false),
    );
  }

  const deploymentChoice = decision.deployment || 'disabled';
  let deployment = { ...repository.deployment, enabled: false, target: '' };
  if (deploymentChoice !== 'disabled') {
    const target = decision.deploymentTarget?.trim();
    const healthUrl = decision.healthUrl?.trim();
    if (!target || !healthUrl)
      throw new Error('Deployment setup requires the target platform/environment and a staging health URL');
    try {
      new URL(healthUrl);
    } catch {
      throw new Error('Deployment health URL must be an absolute URL');
    }
    deployment = {
      ...repository.deployment,
      enabled: true,
      target,
      healthUrl,
      workflow: repository.deployment.workflow || 'deploy.yml',
      rollbackWorkflow: repository.deployment.rollbackWorkflow || 'rollback.yml',
    };
    const deployPath = `.github/workflows/${deployment.workflow}`;
    const rollbackPath = `.github/workflows/${deployment.rollbackWorkflow}`;
    checks = [
      ...checks.filter((check) => !['deployment-config', 'rollback-config'].includes(check.id)),
      gate('deployment-config', 'acceptance', ['@sdlc/setup', 'github-workflow', deployPath, '', 'workflow_dispatch']),
      gate('rollback-config', 'acceptance', ['@sdlc/setup', 'github-workflow', rollbackPath, '', 'workflow_dispatch']),
    ];
    tasks = [
      ...tasks.filter((item) => item.id !== 'deployment-foundation'),
      task(
        'deployment-foundation',
        `${deploymentChoice === 'create' ? 'Create' : 'Reconcile'} governed deployment for ${target}`,
        'Deployment and rollback must be executable, reviewable, and protected by explicit approval.',
        [
          `${deploymentChoice === 'create' ? 'Implement' : 'Preserve and verify'} ${deployPath} for ${target} using environment-scoped secrets and immutable candidate revisions.`,
          `${deploymentChoice === 'create' ? 'Implement' : 'Preserve and verify'} ${rollbackPath} so a failed health check can restore the previous known-good revision.`,
          `Expose and document the health endpoint ${healthUrl}.`,
          'Do not place credentials in the repository; document the exact environment secrets the operator must configure.',
        ],
        [deployPath, rollbackPath],
        ['deployment-config', 'rollback-config'],
      ),
    ];
    capabilities = replaceCapability(
      capabilities,
      capability('deployment', 'Deployment and rollback', deploymentChoice === 'create' ? 'missing' : 'partial', [
        `Target: ${target}`,
        `Health: ${healthUrl}`,
      ]),
    );
  } else {
    capabilities = replaceCapability(
      capabilities,
      capability(
        'deployment',
        'Deployment and rollback',
        'not_applicable',
        ['Developer chose pull-request delivery only.'],
        false,
      ),
    );
  }

  return repositorySchema.parse({
    ...repository,
    checks,
    requiredCiChecks,
    ciWaiver,
    deployment,
    setup: {
      ...repository.setup,
      status: tasks.length ? 'bootstrapping' : 'confirmed',
      confirmedAt: new Date().toISOString(),
      capabilities,
      tasks,
    },
  });
}

export async function discoverRepository(workspace: InspectedWorkspace): Promise<RepositoryDiscovery> {
  const files = await listWorkspaceFiles(workspace.root);
  const directorySet = folders(files);
  const detected = detectStack(files);
  const stackResult =
    detected.stack === 'typescript'
      ? await typescriptSetup(workspace.root, files)
      : detected.stack === 'python'
        ? await pythonSetup(workspace.root, files, directorySet)
        : {
            checks: securityGates(),
            capabilities: [
              capability('security', 'Security scans', 'ready', ['Built-in secret and high-risk SAST scans']),
              capability('unit', 'Unit tests', 'needs_input', ['Unknown project stack']),
              capability('integration', 'Integration tests', 'needs_input', ['Unknown project stack']),
              capability('e2e', 'End-to-end tests', 'needs_input', ['Unknown project stack']),
            ],
            tasks: [] as SetupTask[],
            warnings: ['The project stack and executable quality commands need developer input.'],
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
    warnings.push('No GitHub Actions workflow was detected; Codex will create CI by default.');
  else warnings.push('Existing workflow check names need confirmation, or Codex can reconcile a stable ci check.');
  if (workflow.deployment)
    warnings.push(`Deployment workflow ${workflow.deployment} needs its target and health endpoint confirmed.`);
  const evidence = [
    `Remote: ${workspace.owner}/${workspace.repo}`,
    `Base branch: ${branch}`,
    `Stack markers: ${detected.evidence.join(', ') || 'none'}`,
    ...stackResult.evidence,
    ...workflow.evidence,
  ];
  const capabilities = [
    ...stackResult.capabilities,
    capability(
      'ci',
      'Continuous integration',
      workflow.workflows.length ? 'partial' : 'missing',
      workflow.workflows.length ? workflow.workflows : ['No GitHub Actions workflow'],
    ),
    capability(
      'deployment',
      'Deployment and rollback',
      'needs_input',
      workflow.deployment ? [workflow.deployment] : ['No deployment workflow detected'],
      false,
    ),
  ];
  const repository = repositorySchema.parse({
    name: workspace.repo,
    owner: workspace.owner,
    repo: workspace.repo,
    branch,
    stack: detected.stack,
    standards: '',
    checks: stackResult.checks,
    requiredCiChecks: [],
    ciWaiver: 'Automatic setup is awaiting the CI decision.',
    protectedPaths: ['.github/workflows/', '.sdlc/'],
    setup: {
      source: 'detected',
      status: 'needs_confirmation',
      confidence: detected.confidence,
      detectedAt: new Date().toISOString(),
      confirmedAt: null,
      evidence,
      warnings,
      capabilities,
      tasks: stackResult.tasks,
    },
    review: {},
    testEvidence: {
      requiredForSourceChanges: true,
      sourcePaths: paths.sourcePaths.length ? paths.sourcePaths : ['src/**', 'app/**', '**/*.*'],
      testPaths: paths.testPaths.length ? paths.testPaths : ['tests/**', 'test/**', '**/*.test.*', '**/*.spec.*'],
    },
    deployment: {
      enabled: false,
      target: '',
      environment: 'staging',
      workflow: workflow.deployment ? basename(workflow.deployment) : 'deploy.yml',
      rollbackWorkflow: 'rollback.yml',
      healthUrl: '',
      monitorIntervalSeconds: 300,
    },
  });
  const gaps = capabilities.filter((item) => ['missing', 'partial', 'needs_input'].includes(item.status));
  const questions = [
    `I found ${gaps.length} SDLC capability gaps. Should Codex create every missing local build, lint, type, unit, integration, and applicable E2E foundation listed in the dashboard?`,
    workflow.workflows.length
      ? 'Should Codex reconcile a stable GitHub check named ci, preserve exact existing check names, or record an explicit CI waiver?'
      : 'Should Codex create a least-privilege GitHub Actions workflow with a required check named ci?',
    workflow.deployment
      ? `What platform/environment does ${workflow.deployment} deploy to, and what staging health URL proves success?`
      : 'Is deployment required? If yes, provide the target platform/environment and staging health URL; otherwise delivery will stop after pull-request CI.',
  ];
  return { repository, questions };
}
