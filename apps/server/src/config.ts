import 'dotenv/config';
import { resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
export const config = {
  port: Number(process.env.PORT || 4310),
  host: process.env.HOST || '127.0.0.1',
  publicUrl: process.env.PUBLIC_URL || 'http://localhost:4310',
  production: process.env.NODE_ENV === 'production',
  secureCookies: process.env.COOKIE_SECURE
    ? process.env.COOKIE_SECURE === 'true'
    : process.env.NODE_ENV === 'production',
  dataDir: resolve(process.env.DATA_DIR || '../../.runtime'),
  databaseUrl: process.env.DATABASE_URL,
  sessionSecret: process.env.SESSION_SECRET || randomBytes(32).toString('hex'),
};
export function validateConfig() {
  if (config.production && (!config.databaseUrl || !process.env.SESSION_SECRET))
    throw new Error('Production requires DATABASE_URL and SESSION_SECRET');
  if (config.production && (!process.env.GITHUB_CLIENT_ID || !process.env.GITHUB_CLIENT_SECRET))
    throw new Error('Production requires GitHub OAuth');
  if (process.env.SESSION_SECRET && process.env.SESSION_SECRET.length < 32)
    throw new Error('SESSION_SECRET must have at least 32 characters');
}
