import { afterEach, describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createChatServer } from '../apps/server/src/chat-mcp.js';
import { ChatClient } from '../apps/server/src/chat-client.js';
import { buildApi } from '../apps/server/src/api.js';
import { Store } from '../apps/server/src/store.js';
import { Engine } from '../apps/server/src/engine.js';
import type { Runner } from '../apps/server/src/runner.js';
import { config } from '../apps/server/src/config.js';
import { repositorySchema, type Repository } from '../shared/types.js';

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); vi.restoreAllMocks(); });

describe('Codex chat integration', () => {
  it('uses the actual API to start, recover, inspect and cancel a run without granting deployment approval', async () => {
    const store = await Store.open(); cleanup.push(() => store.close());
    const repo: Repository = { ...repositorySchema.parse({ name: 'Demo', owner: 'team', repo: 'demo', stack: 'custom', checks: [{ id: 'unit', label: 'unit', argv: ['node', '--test'], kind: 'unit', report: 'exit' }], requiredCiChecks: ['ci'] }), id: crypto.randomUUID(), version: 1, createdAt: new Date().toISOString() };
    await store.put('repository', repo);
    const runner = { destroy: vi.fn(async () => undefined) } as unknown as Runner;
    const engine = new Engine(store, runner);
    const wake = vi.spyOn(engine, 'wake').mockImplementation(() => undefined);
    const original = config.adminPassword;
    config.adminPassword = 'test-local-chat-password';
    cleanup.push(async () => { config.adminPassword = original; });
    const app = await buildApi(store, engine, runner); cleanup.push(() => app.close());
    const url = await app.listen({ host: '127.0.0.1', port: 0 });
    const api = new ChatClient(url, config.adminPassword);
    const server = createChatServer(api); cleanup.push(() => server.close());
    const client = new Client({ name: 'test-codex', version: '1' }); cleanup.push(() => client.close());
    const [a, b] = InMemoryTransport.createLinkedPair();
    await server.connect(a); await client.connect(b);
    const names = (await client.listTools()).tools.map(t => t.name);
    expect(names).toContain('sdlc_start'); expect(names.some(n => n.includes('approv'))).toBe(false);
    const call = async (name: string, args: Record<string, unknown>) => {
      const response = await client.callTool({ name, arguments: args });
      const content = response.content as { type: string; text: string }[];
      return { error: response.isError, data: JSON.parse(content[0].text) };
    };
    const input = { repository: 'team/demo', prompt: 'Add task priorities with validation' };
    const first = await call('sdlc_start', input);
    expect(first.error).toBeFalsy(); expect(first.data.status).toBe('queued'); expect(wake).toHaveBeenCalledOnce();
    const again = await call('sdlc_start', input);
    expect(again.data.id).toBe(first.data.id); expect(again.data.reused).toBe(true);
    expect((await store.runs())).toHaveLength(1);
    const other = await call('sdlc_start', { ...input, prompt: 'Make an unrelated change' });
    expect(other.error).toBe(true);
    expect((await call('sdlc_start', { ...input, repository: 'other/repo' })).error).toBe(true);
    const status = await call('sdlc_status', { runId: first.data.id });
    expect(status.data.phase).toBe('planning'); expect(status.data.gates).toEqual([]);
    expect((await call('sdlc_answer', { runId: first.data.id, answer: 'yes' })).error).toBe(true);
    const record = (await store.getRun(first.data.id))!;
    record.status = 'needs_input'; record.question = 'Which priority values?'; await store.saveRun(record);
    expect((await call('sdlc_answer', { runId: record.id, answer: 'low, medium, high' })).data.status).toBe('running');
    expect((await call('sdlc_cancel', { runId: record.id })).data.status).toBe('cancelled');
    expect(runner.destroy).toHaveBeenCalledWith(record.id);
    expect((await call('sdlc_runs', {})).data[0].id).toBe(record.id);
    await expect(api.request(`/api/runs/${record.id}/approval`, {})).rejects.toThrow('Unsupported');
  }, 20000);

  it('rejects external hosts and redirects before leaking a password, and does not retry failed mutations', async () => {
    expect(() => new ChatClient('https://example.com', 'secret')).toThrow('loopback');
    expect(() => new ChatClient('http://127.0.0.1:4310/path', 'secret')).toThrow('loopback');
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response('{}', { headers: { 'set-cookie': 'sdlc_session=test; HttpOnly; Path=/' } }))
      .mockResolvedValueOnce(Response.json({ csrf: 'test-csrf' }))
      .mockResolvedValueOnce(Response.json({ error: 'private internal secret' }, { status: 500 }));
    const api = new ChatClient('http://127.0.0.1:4310', 'private-password');
    await expect(api.request('/api/runs', {})).rejects.toThrow('Harness request failed (500)');
    expect(fetchMock).toHaveBeenCalledTimes(3);
    for (const [, init] of fetchMock.mock.calls) expect(init?.redirect).toBe('error');
  });
});
