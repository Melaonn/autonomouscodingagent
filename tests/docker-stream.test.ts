import { describe, expect, it } from 'vitest';
import { dockerLogText } from '../apps/server/src/docker-stream.js';

function frame(stream: 1 | 2, text: string) {
  const payload = Buffer.from(text);
  const header = Buffer.alloc(8);
  header[0] = stream;
  header.writeUInt32BE(payload.length, 4);
  return Buffer.concat([header, payload]);
}

describe('Docker log decoding', () => {
  it('removes multiplex headers from every frame', () => {
    expect(dockerLogText(Buffer.concat([frame(1, 'first\n'), frame(1, 'second\n')]))).toBe('first\nsecond\n');
  });

  it('preserves plain output', () => {
    expect(dockerLogText('plain output\n')).toBe('plain output\n');
  });
});
