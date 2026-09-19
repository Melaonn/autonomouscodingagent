import { expect, test } from '@playwright/test';
test('local operator reaches native Codex and GitHub onboarding', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Connect and start' })).toBeVisible();
  await expect(page.getByText('Connected', { exact: true }).first()).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Use your Codex app or CLI' })).toBeVisible();
  await expect(page.getByText('There is no second Codex login')).toBeVisible();
  await page.getByRole('button', { name: 'Runs', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Work in progress' })).toBeVisible();
  await expect(page.getByText('See what Codex is doing, what passed, and when you need to act.')).toBeVisible();
  await page.getByRole('button', { name: 'Repositories' }).click();
  await expect(page.getByRole('heading', { name: 'Repositories' })).toBeVisible();
  await expect(page.getByText('Connect GitHub first')).toBeVisible();
});

test('run detail presents complete work, verification, and history without overflow', async ({ page }) => {
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

  const navigation = page.getByRole('navigation', { name: 'Run detail sections' });
  await expect(navigation.getByRole('link', { name: 'Overview' })).toBeVisible();
  await expect(navigation.getByRole('link', { name: 'Work definition' })).toBeVisible();
  await expect(navigation.getByRole('link', { name: 'Verification' })).toBeVisible();
  await expect(navigation.getByRole('link', { name: 'History' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'What Codex is building' })).toBeVisible();
  await expect(page.getByText('Keep the full history available through progressive disclosure.')).toBeVisible();
  await expect(page.getByText('Fourth acceptance criterion remains visible.')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Checks and review evidence' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Activity and evidence files' })).toBeVisible();

  await page.getByRole('button', { name: 'Show all activity' }).click();
  await expect(page.getByRole('button', { name: 'Show recent' }).first()).toBeVisible();
  await page.getByRole('button', { name: 'Show all files' }).click();
  await expect(page.getByText('plan.json')).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(
    true,
  );

  await page.setViewportSize({ width: 540, height: 900 });
  await expect(page.getByRole('heading', { name: 'What Codex is building' })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(
    true,
  );
  expect(runId).toMatch(/^[0-9a-f-]{36}$/);
});
