import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ChatClient } from './chat-client.js';
import { createChatServer } from './chat-mcp.js';

try {
  const client = new ChatClient(process.env.SDLC_CHAT_URL || 'http://127.0.0.1:4310');
  const server = createChatServer(client);
  await server.connect(new StdioServerTransport());
} catch {
  process.stderr.write(
    'SDLC chat could not start. Check the harness server, build output, and connect-codex.ps1 setup.\n',
  );
  process.exitCode = 1;
}
