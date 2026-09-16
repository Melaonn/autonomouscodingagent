import type { Backend, CheckCommand, JobResult } from '../../../shared/types.js';
import { config } from './config.js';
export interface AgentJob { runId: string; backend: Backend; prompt: string; timeoutSeconds: number; phase: string }
export interface Runner {
  ready(): Promise<{ ok: boolean; docker: string; image: boolean; agents: { codex: string } }>;
  prepare(runId: string, owner: string, repo: string, branch: string, githubToken?: string): Promise<string>;
  agent(job: AgentJob): Promise<JobResult>;
  command(runId: string, command: CheckCommand, acceptanceFiles?: { path: string; content: string }[]): Promise<JobResult>;
  commit(runId: string, message: string, baseSha: string): Promise<{ sha: string; changed: string[] }>;
  diff(runId: string, baseSha: string): Promise<string>;
  push(runId: string, branch: string, githubToken?: string): Promise<void>;
  destroy(runId: string): Promise<void>;
  codexStatus(): Promise<{ connected: boolean }>;
  startCodexLogin(): Promise<{ id: string }>;
  codexLogin(id: string): Promise<{ id: string; status: 'starting' | 'waiting' | 'connected' | 'failed'; loginUrl?: string; code?: string; error?: string }>;
}
export class HttpRunner implements Runner {
  constructor(private url = config.runnerUrl, private token = config.runnerToken) {}
  private async request<T>(path: string, body?: unknown, timeoutMs = 35 * 60_000): Promise<T> {
    const response = await fetch(`${this.url}${path}`, { method: body ? 'POST' : 'GET', headers: { 'content-type': 'application/json', authorization: `Bearer ${this.token}` }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(timeoutMs) });
    if (!response.ok) throw new Error(`Runner ${path} failed: ${response.status} ${(await response.text()).slice(0, 500)}`);
    return response.json() as Promise<T>;
  }
  ready() { return this.request<Awaited<ReturnType<Runner['ready']>>>('/ready', undefined, 5000); }
  prepare(runId: string, owner: string, repo: string, branch: string, githubToken?: string) { return this.request<string>('/prepare', { runId, owner, repo, branch, githubToken }); }
  agent(job: AgentJob) { return this.request<JobResult>('/agent', job); }
  command(runId: string, command: CheckCommand, acceptanceFiles?: { path: string; content: string }[]) { return this.request<JobResult>('/command', { runId, command, acceptanceFiles }); }
  commit(runId: string, message: string, baseSha: string) { return this.request<{ sha: string; changed: string[] }>('/commit', { runId, message, baseSha }); }
  diff(runId: string, baseSha: string) { return this.request<string>('/diff', { runId, baseSha }); }
  async push(runId: string, branch: string, githubToken?: string) { await this.request('/push', { runId, branch, githubToken }); }
  async destroy(runId: string) { await this.request('/destroy', { runId }); }
  codexStatus() { return this.request<{ connected: boolean }>('/auth/codex/status', undefined, 30_000); }
  startCodexLogin() { return this.request<{ id: string }>('/auth/codex/start', {}); }
  codexLogin(id: string) { return this.request<{ id: string; status: 'starting' | 'waiting' | 'connected' | 'failed'; loginUrl?: string; code?: string; error?: string }>(`/auth/codex/${id}`, undefined, 10_000); }
}
