import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parse } from 'dotenv';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ChatClient } from './chat-client.js';
import { createChatServer } from './chat-mcp.js';

// Absolute path supplied by installer; never load .env from the target repository.
try {
  const directory = process.argv[2];
  if (!directory) throw new Error('Missing harness directory. Run connect-codex.ps1 first.');
  const env = parse(await readFile(resolve(directory, process.argv[3] || '.env')));
  const client = new ChatClient(process.env.SDLC_CHAT_URL || 'http://127.0.0.1:4310', env.ADMIN_PASSWORD || env.DEV_AUTH_TOKEN || '');
  const server = createChatServer(client);
  await server.connect(new StdioServerTransport());
} catch {
  process.stderr.write('SDLC chat could not start. Check harness .env, build output, and connect-codex.ps1 setup.\n');
  process.exitCode = 1;
}
