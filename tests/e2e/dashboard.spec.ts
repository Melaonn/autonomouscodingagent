import { expect, test } from '@playwright/test';
const e2eToken = process.env.DEV_AUTH_TOKEN || 'local-development-token-123456789';
test('local operator reaches native Codex and GitHub onboarding', async ({ page }) => {
  await page.goto('/');
  await page.getByLabel('Administrator password').fill(e2eToken);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', { name: 'Connect and start' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Use your Codex app or CLI' })).toBeVisible();
  await expect(page.getByText('There is no second Codex login')).toBeVisible();
  await page.getByRole('button', { name: 'Runs', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Development runs' })).toBeVisible();
  await page.getByRole('button', { name: 'Repositories' }).click();
  await expect(page.getByRole('heading', { name: 'Repositories' })).toBeVisible();
  await expect(page.getByText('Connect GitHub first')).toBeVisible();
});
