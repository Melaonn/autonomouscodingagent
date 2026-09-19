import { expect, test } from '@playwright/test';
test('local operator reaches the guided Codex and GitHub onboarding', async ({ page }) => {
  await page.goto('/');
  await page
    .getByLabel('Administrator password')
    .fill(process.env.DEV_AUTH_TOKEN || 'local-development-token-123456789');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', { name: 'Connect and start' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Connect Codex' })).toBeVisible();
  await page.getByRole('button', { name: 'Runs' }).click();
  await expect(page.getByRole('heading', { name: 'Development runs' })).toBeVisible();
  await page.getByRole('button', { name: 'Repositories' }).click();
  await expect(page.getByRole('heading', { name: 'Repositories' })).toBeVisible();
  await expect(page.getByText('Connect GitHub first')).toBeVisible();
});
