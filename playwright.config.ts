import 'dotenv/config';
import { defineConfig } from '@playwright/test';

const e2eToken = process.env.DEV_AUTH_TOKEN || 'local-development-token-123456789';

export default defineConfig({
  testDir: './tests/e2e',
  timeout: 30_000,
  webServer: [
    {
      command: 'npm run dev -w apps/server',
      url: 'http://127.0.0.1:4310/api/me',
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
      env: {
        DEV_AUTH_TOKEN: e2eToken,
        SESSION_SECRET: process.env.SESSION_SECRET || 'e2e-session-secret-with-at-least-32-characters',
        DATA_DIR: '.runtime/e2e',
        PUBLIC_URL: 'http://127.0.0.1:5173',
        GITHUB_TOKEN: '',
      },
    },
    {
      command: 'npm run dev -w apps/web',
      url: 'http://127.0.0.1:5173',
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
    },
  ],
  use: { baseURL: 'http://127.0.0.1:5173', headless: true, screenshot: 'only-on-failure', trace: 'retain-on-failure' },
});
