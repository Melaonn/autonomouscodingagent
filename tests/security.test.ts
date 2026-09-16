import { describe, expect, it } from 'vitest';
import { openSecret, sealSecret } from '../apps/server/src/security.js';

describe('stored setup credentials', () => {
  it('round-trips with the server secret and rejects a different key', () => {
    const sealed = sealSecret('github_pat_example-secret-value', 'a'.repeat(32));
    expect(sealed).not.toContain('github_pat_example-secret-value');
    expect(openSecret(sealed, 'a'.repeat(32))).toBe('github_pat_example-secret-value');
    expect(() => openSecret(sealed, 'b'.repeat(32))).toThrow();
  });
});
