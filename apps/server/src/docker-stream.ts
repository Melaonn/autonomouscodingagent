export function dockerLogText(value: Buffer | string) {
  const buffer = Buffer.isBuffer(value) ? value : Buffer.from(value);
  const chunks: Buffer[] = [];
  let offset = 0;

  while (offset + 8 <= buffer.length) {
    const stream = buffer[offset];
    const framed =
      (stream === 1 || stream === 2) &&
      buffer[offset + 1] === 0 &&
      buffer[offset + 2] === 0 &&
      buffer[offset + 3] === 0;
    if (!framed) return buffer.toString('utf8');
    const length = buffer.readUInt32BE(offset + 4);
    const end = offset + 8 + length;
    if (end > buffer.length) return buffer.toString('utf8');
    chunks.push(buffer.subarray(offset + 8, end));
    offset = end;
  }

  if (offset !== buffer.length || !chunks.length) return buffer.toString('utf8');
  return Buffer.concat(chunks).toString('utf8');
}
