import { createPrivateKey, createSign } from 'node:crypto';
import type { Repository, Run } from '../../../shared/types.js';
import { readFile } from 'node:fs/promises';
let cached: { token: string; expires: number } | undefined;
let configuredToken = '';
export function setRepositoryToken(token: string) {
  configuredToken = token;
}
const base64url = (value: string | Buffer) => Buffer.from(value).toString('base64url');
async function installationToken() {
  if (configuredToken || process.env.GITHUB_TOKEN) return configuredToken || process.env.GITHUB_TOKEN!;
  if (!process.env.GITHUB_APP_ID || !process.env.GITHUB_INSTALLATION_ID || !process.env.GITHUB_APP_PRIVATE_KEY_FILE)
    throw new Error('GitHub repository credentials are not configured');
  if (cached && cached.expires > Date.now() + 60_000) return cached.token;
  const now = Math.floor(Date.now() / 1000);
  const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const payload = base64url(JSON.stringify({ iat: now - 60, exp: now + 540, iss: process.env.GITHUB_APP_ID }));
  const signer = createSign('RSA-SHA256');
  signer.update(`${header}.${payload}`);
  const key = createPrivateKey(await readFile(process.env.GITHUB_APP_PRIVATE_KEY_FILE));
  const jwt = `${header}.${payload}.${signer.sign(key).toString('base64url')}`;
  const response = await fetch(
    `https://api.github.com/app/installations/${process.env.GITHUB_INSTALLATION_ID}/access_tokens`,
    { method: 'POST', headers: headers(jwt) },
  );
  if (!response.ok) throw new Error(`GitHub App authentication failed: ${response.status}`);
  const data = (await response.json()) as { token: string; expires_at: string };
  cached = { token: data.token, expires: Date.parse(data.expires_at) };
  return data.token;
}
export const repositoryToken = installationToken;
function headers(token: string) {
  return {
    accept: 'application/vnd.github+json',
    authorization: `Bearer ${token}`,
    'x-github-api-version': '2022-11-28',
    'user-agent': 'sdlc-control-plane',
  };
}
async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const token = await installationToken();
  const response = await fetch(`https://api.github.com${path}`, {
    ...init,
    headers: { ...headers(token), ...init.headers },
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok)
    throw new Error(`GitHub ${path} failed: ${response.status} ${(await response.text()).slice(0, 500)}`);
  return response.status === 204 ? (undefined as T) : (response.json() as Promise<T>);
}

async function graphql<T>(query: string, variables: Record<string, unknown>) {
  const response = await api<{ data?: T; errors?: { message: string }[] }>('/graphql', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ query, variables }),
  });
  if (response.errors?.length)
    throw new Error(`GitHub GraphQL failed: ${response.errors.map((e) => e.message).join('; ')}`);
  if (!response.data) throw new Error('GitHub GraphQL returned no data');
  return response.data;
}
export async function createOrUpdatePr(run: Run) {
  const repo = run.policy;
  const head = `${repo.owner}:${run.branch}`;
  const existing = await api<{ number: number; html_url: string }[]>(
    `/repos/${repo.owner}/${repo.repo}/pulls?state=open&head=${encodeURIComponent(head)}`,
  );
  const body = `Native Codex SDLC run \`${run.id}\`. Planning, requirements, design, configured verification, same-session review, deployment approval, and maintenance evidence are tracked by the control plane.\n\nCandidate: \`${run.candidateSha}\``;
  if (existing[0]) {
    await api(`/repos/${repo.owner}/${repo.repo}/pulls/${existing[0].number}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ body }),
    });
    return existing[0];
  }
  return api<{ number: number; html_url: string }>(`/repos/${repo.owner}/${repo.repo}/pulls`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      title: run.contract?.summary || run.prompt.slice(0, 70),
      head: run.branch,
      base: repo.branch,
      body,
      draft: true,
    }),
  });
}
export async function requiredChecks(repo: Repository, sha: string) {
  if (!repo.requiredCiChecks.length)
    return repo.ciWaiver
      ? { state: 'success' as const, details: [`CI waiver: ${repo.ciWaiver}`] }
      : { state: 'failure' as const, details: ['No required remote CI checks or explicit waiver configured'] };
  const data = await api<{
    check_runs: { name: string; status: string; conclusion: string | null; html_url: string }[];
  }>(`/repos/${repo.owner}/${repo.repo}/commits/${sha}/check-runs?filter=latest&per_page=100`);
  const details: string[] = [];
  let pending = false;
  let failed = false;
  for (const name of repo.requiredCiChecks) {
    const run = data.check_runs.find((c) => c.name === name);
    if (!run || run.status !== 'completed') {
      pending = true;
      details.push(`${name}: pending or missing`);
    } else if (run.conclusion !== 'success' && run.conclusion !== 'neutral' && run.conclusion !== 'skipped') {
      failed = true;
      details.push(`${name}: ${run.conclusion}`);
    } else details.push(`${name}: ${run.conclusion}`);
  }
  return { state: failed ? ('failure' as const) : pending ? ('pending' as const) : ('success' as const), details };
}
export async function markReady(repo: Repository, number: number) {
  const pull = await api<{ node_id: string; draft: boolean }>(`/repos/${repo.owner}/${repo.repo}/pulls/${number}`);
  if (!pull.draft) return;
  const data = await graphql<{ markPullRequestReadyForReview: { pullRequest: { isDraft: boolean } } }>(
    `
      mutation MarkPullRequestReady($pullRequestId: ID!) {
        markPullRequestReadyForReview(input: { pullRequestId: $pullRequestId }) {
          pullRequest {
            isDraft
          }
        }
      }
    `,
    { pullRequestId: pull.node_id },
  );
  if (data.markPullRequestReadyForReview.pullRequest.isDraft)
    throw new Error('GitHub left the pull request in draft state');
}
export async function dispatch(repo: Repository, workflow: string, ref: string, candidateSha: string, runId: string) {
  await api(`/repos/${repo.owner}/${repo.repo}/actions/workflows/${encodeURIComponent(workflow)}/dispatches`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      ref,
      inputs: { sdlc_run_id: runId, candidate_sha: candidateSha, environment: repo.deployment.environment },
    }),
  });
}
export async function workflowStatus(repo: Repository, workflow: string, sha: string) {
  const data = await api<{
    workflow_runs: { id: number; head_sha: string; status: string; conclusion: string | null; html_url: string }[];
  }>(
    `/repos/${repo.owner}/${repo.repo}/actions/workflows/${encodeURIComponent(workflow)}/runs?event=workflow_dispatch&per_page=30`,
  );
  const run = data.workflow_runs.find((r) => r.head_sha === sha);
  if (!run) return { state: 'pending' as const };
  return {
    state:
      run.status !== 'completed'
        ? ('pending' as const)
        : run.conclusion === 'success'
          ? ('success' as const)
          : ('failure' as const),
    run,
  };
}
export async function oauthUser(code: string) {
  if (!process.env.GITHUB_CLIENT_ID || !process.env.GITHUB_CLIENT_SECRET)
    throw new Error('GitHub OAuth is not configured');
  const response = await fetch('https://github.com/login/oauth/access_token', {
    method: 'POST',
    headers: { accept: 'application/json', 'content-type': 'application/json' },
    body: JSON.stringify({
      client_id: process.env.GITHUB_CLIENT_ID,
      client_secret: process.env.GITHUB_CLIENT_SECRET,
      code,
    }),
  });
  const auth = (await response.json()) as { access_token?: string; error_description?: string };
  if (!auth.access_token) throw new Error(auth.error_description || 'OAuth exchange failed');
  const userResponse = await fetch('https://api.github.com/user', { headers: headers(auth.access_token) });
  if (!userResponse.ok) throw new Error('Unable to read GitHub user');
  return userResponse.json() as Promise<{ login: string }>;
}
export async function validateRepositoryToken(token: string) {
  const response = await fetch('https://api.github.com/user', {
    headers: headers(token),
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(`GitHub rejected this token (${response.status})`);
  const user = (await response.json()) as { login: string };
  if (!user.login) throw new Error('GitHub token did not identify a user');
  return user.login;
}
export async function availableRepositories() {
  const repositories = await api<
    {
      name: string;
      full_name: string;
      private: boolean;
      default_branch: string;
      language: string | null;
      permissions?: { push?: boolean };
    }[]
  >('/user/repos?affiliation=owner,collaborator,organization_member&sort=updated&per_page=100');
  return repositories
    .filter((repo) => repo.permissions?.push !== false)
    .map((repo) => ({
      name: repo.name,
      fullName: repo.full_name,
      private: repo.private,
      defaultBranch: repo.default_branch,
      language: repo.language,
    }));
}
export function oauthUrl(state: string) {
  return `https://github.com/login/oauth/authorize?client_id=${encodeURIComponent(process.env.GITHUB_CLIENT_ID || '')}&scope=read:user&state=${encodeURIComponent(state)}`;
}
export function githubConfigured() {
  return !!(
    configuredToken ||
    process.env.GITHUB_TOKEN ||
    (process.env.GITHUB_APP_ID && process.env.GITHUB_INSTALLATION_ID && process.env.GITHUB_APP_PRIVATE_KEY_FILE)
  );
}
