import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
export const hash = (text: string) => createHash('sha256').update(text).digest('hex');
export const nonce = () => randomBytes(32).toString('hex');
export function equalSecret(a: string, b: string) { const x = Buffer.from(a); const y = Buffer.from(b); return x.length === y.length && timingSafeEqual(x, y); }
export function safePath(path: string) {
  if (!path || path.startsWith('/') || path.includes('\\') || path.includes('\0') || path.split('/').some(x => x === '..' || x === '.git') || /^[A-Za-z]:/.test(path)) throw new Error('Path must remain inside the workspace');
  return path;
}
export function redact(text: string) {
  let result = text.replace(/(?:gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]+|sk-[A-Za-z0-9_-]{20,})/g, '[REDACTED]');
  for (const [key, value] of Object.entries(process.env)) if (/(?:TOKEN|SECRET|API_KEY|PASSWORD)$/.test(key) && value && value.length > 7) result = result.split(value).join('[REDACTED]');
  return result;
}
export function endpoint(url: string, allowLocal = false) {
  const parsed = new URL(url);
  if (!['https:', ...(allowLocal ? ['http:'] : [])].includes(parsed.protocol) || parsed.username || parsed.password || parsed.hash) throw new Error('Use an HTTPS endpoint without embedded credentials');
  return parsed.toString();
}
