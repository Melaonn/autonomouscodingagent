import { createCipheriv, createDecipheriv, createHash, randomBytes, timingSafeEqual } from 'node:crypto';
export const hash = (text: string) => createHash('sha256').update(text).digest('hex');
export const nonce = () => randomBytes(32).toString('hex');
function encryptionKey(secret: string) { return createHash('sha256').update(secret).digest(); }
export function sealSecret(value: string, secret: string) {
  const iv = randomBytes(12); const cipher = createCipheriv('aes-256-gcm', encryptionKey(secret), iv);
  const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  return `v1.${iv.toString('base64url')}.${cipher.getAuthTag().toString('base64url')}.${encrypted.toString('base64url')}`;
}
export function openSecret(value: string, secret: string) {
  const [version, iv, tag, encrypted] = value.split('.');
  if (version !== 'v1' || !iv || !tag || !encrypted) throw new Error('Stored credential is invalid');
  const decipher = createDecipheriv('aes-256-gcm', encryptionKey(secret), Buffer.from(iv, 'base64url'));
  decipher.setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([decipher.update(Buffer.from(encrypted, 'base64url')), decipher.final()]).toString('utf8');
}
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
