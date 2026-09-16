import { expect, test } from '@playwright/test';
test('local operator can reach the governed run ledger and onboarding form', async ({ page }) => {
  await page.goto('/');
  await page.getByLabel('Local operator token').fill('local-development-token-123456789');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', { name: 'Development runs' })).toBeVisible();
  await page.getByRole('button', { name: 'Repositories' }).click();
  await expect(page.getByRole('heading', { name: 'Repositories' })).toBeVisible();
  await page.getByRole('button', { name: 'Onboard repository' }).click();
  await expect(page.getByRole('heading', { name: 'Onboard a repository' })).toBeVisible();
  await expect(page.getByLabel('Health URL')).toBeVisible();
  await expect(page.getByLabel('Rollback workflow')).toHaveValue('rollback.yml');
});
