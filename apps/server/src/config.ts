import 'dotenv/config';
import { resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
export const config = {
  port: Number(process.env.PORT || 4310), host: process.env.HOST || '127.0.0.1',
  publicUrl: process.env.PUBLIC_URL || 'http://localhost:5173', production: process.env.NODE_ENV === 'production',
  dataDir: resolve(process.env.DATA_DIR || '../../.runtime'), databaseUrl: process.env.DATABASE_URL,
  sessionSecret: process.env.SESSION_SECRET || randomBytes(32).toString('hex'), devToken: process.env.DEV_AUTH_TOKEN || '',
  runnerUrl: process.env.RUNNER_URL || 'http://127.0.0.1:4311', runnerToken: process.env.RUNNER_TOKEN || '',
  maxActive: Number(process.env.MAX_ACTIVE_RUNS || 2),
};
export function validateConfig() {
  if (config.production && (!config.databaseUrl || !process.env.SESSION_SECRET || !config.runnerToken)) throw new Error('Production requires DATABASE_URL, SESSION_SECRET and RUNNER_TOKEN');
  if (config.production && config.devToken) throw new Error('Development login must be disabled in production');
  if (config.devToken && !['localhost', '127.0.0.1', '::1'].includes(config.host)) throw new Error('Development login is loopback-only');
  if (process.env.SESSION_SECRET && process.env.SESSION_SECRET.length < 32) throw new Error('SESSION_SECRET must have at least 32 characters');
}
