import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Integration } from '../../../shared/types.js';
export async function inspectIntegration(integration: Integration) {
  const headers: Record<string, string> = {};
  for (const [header, envName] of Object.entries(integration.headersEnv)) { const value = process.env[envName]; if (!value) throw new Error(`Missing server environment variable ${envName}`); headers[header] = value; }
  const client = new Client({ name: 'sdlc-control-plane', version: '0.1.0' });
  const transport = new StreamableHTTPClientTransport(new URL(integration.url), { requestInit: { headers } });
  try { await client.connect(transport); const listed = await client.listTools(); return listed.tools.filter(t => integration.allowedTools.includes(t.name)).map(t => ({ name: t.name, description: t.description || '', inputSchema: t.inputSchema })); }
  finally { await client.close().catch(() => undefined); }
}
export async function callIntegration(integration: Integration, tool: string, args: Record<string, unknown>) {
  if (!integration.enabled || !integration.allowedTools.includes(tool)) throw new Error(`MCP tool ${tool} is not approved`);
  const headers: Record<string, string> = {}; for (const [header, envName] of Object.entries(integration.headersEnv)) { const value = process.env[envName]; if (!value) throw new Error(`Missing server environment variable ${envName}`); headers[header] = value; }
  const client = new Client({ name: 'sdlc-control-plane', version: '0.1.0' }); const transport = new StreamableHTTPClientTransport(new URL(integration.url), { requestInit: { headers } });
  try { await client.connect(transport); return await client.callTool({ name: tool, arguments: args }); } finally { await client.close().catch(() => undefined); }
}
