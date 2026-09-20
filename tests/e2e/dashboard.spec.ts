import { expect, test } from '@playwright/test';

test('GitHub is the default dashboard login when OAuth is configured', async ({ page }) => {
  await page.route('**/api/me', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ user: null, csrf: '', githubOAuth: true }),
    }),
  );
  await page.goto('/');
  const login = page.getByRole('link', { name: 'Continue with GitHub' });
  await expect(login).toBeVisible();
  await expect(login).toHaveAttribute('href', '/auth/github');
});

test('local operator reaches native Codex and GitHub onboarding', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Connect and start' })).toBeVisible();
  await expect(page.getByText('Connected', { exact: true }).first()).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Use your Codex app or CLI' })).toBeVisible();
  await expect(page.getByText('There is no second Codex login')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'GitHub identity and local Git' })).toBeVisible();
  await expect(page.getByText('End users never need to create an OAuth application')).toBeVisible();
  await expect(page.getByRole('link', { name: 'Create GitHub OAuth App' })).toHaveCount(0);
  await expect(page.getByLabel('GitHub token')).toHaveCount(0);
  await page.getByRole('button', { name: 'Runs', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Work in progress' })).toBeVisible();
  await expect(page.getByText('See what Codex is doing, what passed, and when you need to act.')).toBeVisible();
  await page.getByRole('button', { name: 'Repositories' }).click();
  await expect(page.getByRole('heading', { name: 'Repositories' })).toBeVisible();
  await expect(page.getByText('Connect GitHub first')).toBeVisible();
});

test('run detail explains the work in the seven SDLC phases without overflow', async ({ page }) => {
  await page.goto('/');
  const runId = await page.evaluate(async () => {
    const meResponse = await fetch('/api/me');
    const me = (await meResponse.json()) as { csrf: string };
    const post = async <T>(path: string, body: unknown): Promise<T> => {
      const response = await fetch(path, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-csrf-token': me.csrf },
        body: JSON.stringify(body),
      });
      if (!response.ok) throw new Error(`${path}: ${await response.text()}`);
      return response.json() as Promise<T>;
    };

    const repository = await post<{ id: string }>('/api/repositories', {
      name: 'Run detail fixture',
      owner: 'e2e-team',
      repo: 'run-detail-fixture',
      branch: 'main',
      stack: 'custom',
      standards: 'Show complete lifecycle evidence.',
      checks: [
        {
          id: 'unit',
          label: 'unit test',
          argv: ['node', '-e', 'process.exit(0)'],
          required: true,
          kind: 'unit',
          report: 'exit',
          reportPath: '',
          timeoutSeconds: 30,
        },
      ],
      requiredCiChecks: [],
      ciWaiver: 'The E2E fixture does not publish.',
      protectedPaths: [],
      deployment: {
        enabled: false,
        target: '',
        environment: 'staging',
        workflow: 'deploy.yml',
        rollbackWorkflow: 'rollback.yml',
        healthUrl: '',
        monitorIntervalSeconds: 300,
      },
    });
    const created = await post<{ run: { id: string } }>('/api/runs', {
      repositoryId: repository.id,
      prompt: 'Improve the run detail hierarchy and preserve all lifecycle evidence.',
      mode: 'delivery',
      workspace: {
        branch: 'main',
        headSha: 'a'.repeat(40),
        digest: 'b'.repeat(40),
        dirty: false,
        changes: [],
      },
    });
    const id = created.run.id;
    await post(`/api/runs/${id}/plan`, {
      source: 'codex-plan-mode',
      scope: 'Make every part of a governed run easy to understand.',
      steps: [
        'Create a stable section navigator.',
        'Present the complete work definition.',
        'Combine quality gates with review evidence.',
        'Keep the full history available through progressive disclosure.',
      ],
      dependencies: ['Existing run evidence API'],
      estimatedEffort: 'One focused implementation',
      costEstimate: 'No new infrastructure',
      schedule: ['Implement', 'Verify'],
      risks: ['Long content must wrap on narrow screens'],
    });
    await post(`/api/runs/${id}/requirements`, {
      summary: 'Run detail hierarchy test fixture',
      criteria: [
        {
          id: 'AC1',
          description: 'Section navigation is visible.',
          evidence: 'review',
          checkIds: [],
          category: 'usability',
        },
        {
          id: 'AC2',
          description: 'Every plan step remains visible.',
          evidence: 'test',
          checkIds: ['unit'],
          category: 'functional',
        },
        {
          id: 'AC3',
          description: 'Verification evidence is grouped clearly.',
          evidence: 'review',
          checkIds: [],
          category: 'usability',
        },
        {
          id: 'AC4',
          description: 'Fourth acceptance criterion remains visible.',
          evidence: 'test',
          checkIds: ['unit'],
          category: 'functional',
        },
      ],
      nonGoals: ['Change the lifecycle API'],
      assumptions: ['Run evidence already exists'],
      risks: ['Dense content can be hard to scan'],
      clarification: null,
    });
    await post(`/api/runs/${id}/design`, {
      architecture: 'RunDetail remains the polling owner and renders four stable information sections.',
      apiContracts: ['No API changes'],
      dataChanges: ['No persistence changes'],
      uiBehavior: ['Recent history expands on demand'],
      security: ['Artifact links remain server-authorized'],
      compatibility: 'Existing lifecycle actions remain available.',
      testStrategy: 'Seed a representative run and assert desktop and narrow viewport behavior.',
    });
    for (let index = 1; index <= 10; index += 1) {
      await post(`/api/runs/${id}/progress`, {
        phase: 'coding',
        step: `implementation-${index}`,
        message: `Implementation update ${index}`,
      });
    }
    for (let index = 1; index <= 6; index += 1) {
      await post(`/api/runs/${id}/verify`, {
        candidateDigest: 'b'.repeat(40),
        changedPaths: ['apps/web/src/main.tsx', 'tests/e2e/dashboard.spec.ts'],
        results: [
          {
            commandId: 'unit',
            result: {
              exitCode: 0,
              stdout: `verification ${index} passed`,
              stderr: '',
              durationMs: index,
              files: {},
            },
          },
        ],
      });
    }
    return id;
  });

  await page.getByRole('button', { name: 'Runs', exact: true }).click();
  await page.getByRole('button', { name: /Run detail hierarchy test fixture/ }).click();

  const navigation = page.getByRole('navigation', { name: 'Seven SDLC phases' });
  for (const label of [
    '1 Planning',
    '2 Requirements',
    '3 Design',
    '4 Coding',
    '5 Testing',
    '6 Deployment',
    '7 Maintenance',
  ]) {
    await expect(navigation.getByRole('link', { name: label })).toBeVisible();
  }
  expect(await page.locator('.phase-section h2').allTextContents()).toEqual([
    'Planning',
    'Requirements',
    'Design',
    'Coding',
    'Testing',
    'Deployment',
    'Maintenance',
  ]);

  const planning = page.locator('#phase-planning');
  await expect(planning.getByText('Keep the full history available through progressive disclosure.')).toBeVisible();
  await expect(planning.getByText('Dependencies', { exact: true })).toBeVisible();
  await expect(planning.getByText('Native Codex Plan mode', { exact: true })).toBeVisible();
  const requirements = page.locator('#phase-requirements');
  await expect(requirements.getByText('Fourth acceptance criterion remains visible.')).toBeVisible();
  await expect(requirements.getByText('Assumptions', { exact: true })).toBeVisible();
  const design = page.locator('#phase-design');
  await expect(design.getByText('API contracts', { exact: true })).toBeVisible();
  await expect(design.getByText('Test strategy', { exact: true })).toHaveCount(0);
  await expect(page.locator('#phase-coding').getByText('Candidate tree', { exact: true })).toBeVisible();
  const testing = page.locator('#phase-testing');
  await expect(testing.getByText('Test strategy', { exact: true })).toBeVisible();
  await expect(testing.getByText('Quality gates', { exact: true })).toBeVisible();
  await expect(page.getByText('Codex native review required', { exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Run Codex native review' })).toBeVisible();

  await page.evaluate(async (id) => {
    const meResponse = await fetch('/api/me');
    const me = (await meResponse.json()) as { csrf: string };
    const response = await fetch(`/api/runs/${id}/review`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-csrf-token': me.csrf },
      body: JSON.stringify({
        source: 'codex-native-review',
        scope: 'uncommitted',
        summary: 'Native reviewer found no blocking issues.',
        findings: [],
        criteria: [
          { id: 'AC1', satisfied: true, evidence: 'Native review confirmed the section navigation.' },
          { id: 'AC2', satisfied: true, evidence: 'Unit evidence covers every plan step.' },
          { id: 'AC3', satisfied: true, evidence: 'Native review confirmed the verification grouping.' },
          { id: 'AC4', satisfied: true, evidence: 'Unit evidence covers the fourth acceptance criterion.' },
        ],
      }),
    });
    if (!response.ok) throw new Error(await response.text());
  }, runId);
  await expect(testing.getByText('Codex /review', { exact: true })).toBeVisible({ timeout: 7_000 });
  await expect(testing.getByText('Scope: uncommitted', { exact: true })).toBeVisible();
  await expect(testing.getByText('Native reviewer found no blocking issues.')).toBeVisible();
  await expect(page.locator('#phase-deployment').getByText('1 · Publication', { exact: true })).toBeVisible();

  const maintenance = page.locator('#phase-maintenance');
  await maintenance.getByRole('button', { name: 'Show all activity' }).click();
  await expect(page.getByRole('button', { name: 'Show recent' }).first()).toBeVisible();
  await maintenance.getByRole('button', { name: 'Show all files' }).click();
  await expect(page.getByText('plan.json')).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(
    true,
  );

  await page.setViewportSize({ width: 540, height: 900 });
  await expect(page.getByRole('heading', { name: 'Planning', exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Maintenance', exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(
    true,
  );
  expect(runId).toMatch(/^[0-9a-f-]{36}$/);
});

test('auto-detected repository setup is clearly presented for confirmation', async ({ page }) => {
  await page.goto('/');
  await page.evaluate(async () => {
    const me = (await (await fetch('/api/me')).json()) as { csrf: string };
    const response = await fetch('/api/repositories', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-csrf-token': me.csrf },
      body: JSON.stringify({
        name: 'Detected service',
        owner: 'e2e-team',
        repo: 'detected-service',
        branch: 'main',
        stack: 'python',
        standards: '',
        checks: [
          {
            id: 'unit',
            label: 'unit',
            argv: ['python', '-m', 'pytest'],
            required: true,
            kind: 'unit',
            report: 'exit',
            reportPath: '',
            timeoutSeconds: 30,
          },
        ],
        requiredCiChecks: [],
        ciWaiver: 'Awaiting confirmation',
        protectedPaths: ['.github/workflows/', '.sdlc/'],
        setup: {
          source: 'detected',
          status: 'needs_confirmation',
          confidence: 'high',
          detectedAt: new Date().toISOString(),
          confirmedAt: null,
          evidence: ['Remote: e2e-team/detected-service', 'Python environment: uv'],
          warnings: ['Required GitHub check names must be confirmed.'],
          capabilities: [
            {
              id: 'unit',
              label: 'Unit tests',
              status: 'ready',
              required: true,
              evidence: ['tests/unit/'],
            },
            {
              id: 'e2e',
              label: 'End-to-end tests',
              status: 'missing',
              required: true,
              evidence: ['Missing tests/e2e/'],
            },
          ],
          tasks: [
            {
              id: 'e2e-foundation',
              title: 'Create the end-to-end test foundation',
              reason: 'No E2E suite was found.',
              instructions: ['Exercise the public application boundary.'],
              files: ['tests/e2e/'],
              checkIds: ['e2e'],
              status: 'pending',
            },
          ],
        },
        deployment: {
          enabled: false,
          target: '',
          environment: 'staging',
          workflow: 'deploy.yml',
          rollbackWorkflow: 'rollback.yml',
          healthUrl: '',
          monitorIntervalSeconds: 300,
        },
      }),
    });
    if (!response.ok) throw new Error(await response.text());
  });

  await page.getByRole('button', { name: 'Repositories' }).click();
  await expect(page.getByRole('heading', { name: 'Detected service' })).toBeVisible();
  await expect(page.getByText('review setup', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Review detected setup' }).click();
  await expect(page.getByRole('heading', { name: 'Review detected project setup' })).toBeVisible();
  await expect(page.getByText('Codex filled this from the local checkout')).toBeVisible();
  await expect(page.getByText(/Python environment: uv/)).toBeVisible();
  await expect(page.getByText('Detected SDLC capabilities')).toBeVisible();
  await page.getByText('1 bootstrap tasks proposed').click();
  await expect(page.getByText('Create the end-to-end test foundation')).toBeVisible();
  await expect(page.getByLabel('GitHub repository')).toHaveValue('e2e-team/detected-service');
  await page.getByRole('button', { name: 'Save reviewed setup' }).click();
  await expect(page.getByRole('heading', { name: 'Review detected project setup' })).not.toBeVisible();
  await expect(page.getByText('review setup', { exact: true })).not.toBeVisible();
  const confirmedSetup = await page.evaluate(async () => {
    const repositories = (await (await fetch('/api/repositories')).json()) as {
      repo: string;
      setup?: { source: string; status: string; evidence: string[]; confirmedAt: string | null };
    }[];
    return repositories.find((repository) => repository.repo === 'detected-service')?.setup;
  });
  expect(confirmedSetup).toMatchObject({
    source: 'detected',
    status: 'reviewed',
    evidence: expect.arrayContaining(['Python environment: uv']),
    confirmedAt: null,
  });
});
