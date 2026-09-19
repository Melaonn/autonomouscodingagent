import { describe, expect, it } from 'vitest';
import { acceptanceWrites } from '../apps/server/src/acceptance-files.js';

describe('acceptance file staging', () => {
  it('preserves distinct filenames and large Unicode sources without shell interpolation', () => {
    const content = 'const value = "你好😀$()";\n'.repeat(15000);
    const writes = acceptanceWrites('acceptance.test.js', content);
    expect(writes.length).toBeGreaterThan(1);
    const restored = Buffer.concat(
      writes.map((w) => Buffer.from(w.env[1].slice('SDLC_DATA='.length), 'base64')),
    ).toString();
    expect(restored).toBe(content);
    for (const write of writes) {
      expect(write.env[0]).toBe('SDLC_FILE=acceptance.test.js');
      expect(write.env[1].length).toBeLessThan(40000);
      expect(write.argv[0]).toBe('node');
    }
    expect(acceptanceWrites('second.js', '')[0].env[0]).toBe('SDLC_FILE=second.js');
    expect(writes.at(-1)!.argv[2]).toContain('chmodSync');
  });
  it('rejects escaping paths', () => {
    for (const path of ['../escape.js', '/absolute.js', 'nested/test.js'])
      expect(() => acceptanceWrites(path, '')).toThrow();
  });
});
