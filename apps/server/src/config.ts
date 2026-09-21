import 'dotenv/config';
import { resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
const inferredPublicUrl = process.env.RENDER_EXTERNAL_HOSTNAME
  ? `https://${process.env.RENDER_EXTERNAL_HOSTNAME}`
  : 'http://localhost:4310';
export const config = {
  port: Number(process.env.PORT || 4310),
  host: process.env.HOST || '127.0.0.1',
  publicUrl: process.env.PUBLIC_URL || inferredPublicUrl,
  production: process.env.NODE_ENV === 'production',
  secureCookies: process.env.COOKIE_SECURE
    ? process.env.COOKIE_SECURE === 'true'
    : process.env.NODE_ENV === 'production',
  dataDir: resolve(process.env.DATA_DIR || '../../.runtime'),
  databaseUrl: process.env.DATABASE_URL,
  sessionSecret: process.env.SESSION_SECRET || randomBytes(32).toString('hex'),
  localMcpToken: process.env.LOCAL_MCP_TOKEN || '',
};
export function validateConfig() {
  if (config.production && (!config.databaseUrl || !process.env.SESSION_SECRET))
    throw new Error('Production requires DATABASE_URL and SESSION_SECRET');
  if (config.production && (!process.env.GITHUB_CLIENT_ID || !process.env.GITHUB_CLIENT_SECRET))
    throw new Error('Production requires GitHub OAuth');
  if (config.production && (!process.env.GITHUB_ALLOWED_USERS || !process.env.GITHUB_ADMIN_USERS))
    throw new Error('Production requires GitHub user and administrator allowlists');
  if (config.production && config.localMcpToken.length < 32)
    throw new Error('Production requires LOCAL_MCP_TOKEN with at least 32 characters');
  if (process.env.SESSION_SECRET && process.env.SESSION_SECRET.length < 32)
    throw new Error('SESSION_SECRET must have at least 32 characters');
  if (config.localMcpToken && config.localMcpToken.length < 32)
    throw new Error('LOCAL_MCP_TOKEN must have at least 32 characters');
}
