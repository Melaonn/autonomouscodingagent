import 'dotenv/config';
import { defineConfig } from '@playwright/test';

const apiPort = Number(process.env.E2E_API_PORT || 4410);
const webPort = Number(process.env.E2E_WEB_PORT || 5174);
const apiUrl = `http://127.0.0.1:${apiPort}`;
const webUrl = `http://127.0.0.1:${webPort}`;
const jsonReport = process.env.PLAYWRIGHT_JSON_OUTPUT_NAME;

export default defineConfig({
  testDir: './tests/e2e',
  timeout: 30_000,
  reporter: jsonReport ? [['json', { outputFile: jsonReport }]] : undefined,
  webServer: [
    {
      command: 'npm run dev -w apps/server',
      url: `${apiUrl}/api/me`,
      reuseExistingServer: false,
      timeout: 120_000,
      env: {
        PORT: String(apiPort),
        HOST: '127.0.0.1',
        SESSION_SECRET: process.env.SESSION_SECRET || 'e2e-session-secret-with-at-least-32-characters',
        DATA_DIR: `.runtime/e2e-${process.pid}`,
        PUBLIC_URL: webUrl,
        GITHUB_TOKEN: '',
        GITHUB_CLIENT_ID: '',
        GITHUB_CLIENT_SECRET: '',
      },
    },
    {
      command: 'npm run dev -w apps/web',
      url: webUrl,
      reuseExistingServer: false,
      timeout: 120_000,
      env: { VITE_PORT: String(webPort), VITE_API_URL: apiUrl },
    },
  ],
  use: { baseURL: webUrl, headless: true, screenshot: 'only-on-failure', trace: 'retain-on-failure' },
});
