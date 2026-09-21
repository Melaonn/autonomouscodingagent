import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildApi } from '../apps/server/src/api.js';
import { setRepositoryToken } from '../apps/server/src/github.js';
import { RunService } from '../apps/server/src/run-service.js';
import { Store } from '../apps/server/src/store.js';

afterEach(() => {
  setRepositoryToken('');
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('dashboard authentication', () => {
  it('exposes a public deployment health check', async () => {
    const store = await Store.open();
    const app = await buildApi(store, new RunService(store));

    try {
      const response = await app.inject({ method: 'GET', url: '/healthz' });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ status: 'ok' });
    } finally {
      await app.close();
      await store.close();
    }
  });

  it('pairs a local Codex device without sharing the installation administrator token', async () => {
    vi.stubEnv('GITHUB_CLIENT_ID', '');
    vi.stubEnv('GITHUB_CLIENT_SECRET', '');
    const store = await Store.open();
    const app = await buildApi(store, new RunService(store));

    try {
      const started = await app.inject({
        method: 'POST',
        url: '/api/pairing/start',
        payload: { clientName: 'Codex test device' },
      });
      expect(started.statusCode).toBe(201);
      const pairing = started.json<{ deviceCode: string; userCode: string; verificationUri: string }>();
      expect(pairing.deviceCode).toHaveLength(64);
      expect(pairing.userCode).toMatch(/^[A-F0-9]{4}(?:-[A-F0-9]{4}){2}$/);
      expect(pairing.verificationUri).toContain(`pair=${pairing.userCode}`);

      const browser = await app.inject({ method: 'GET', url: '/api/me' });
      const browserSession = browser.cookies.find((cookie) => cookie.name === 'sdlc_session');
      const csrf = browser.json<{ csrf: string }>().csrf;
      const approved = await app.inject({
        method: 'POST',
        url: '/api/pairing/approve',
        cookies: { sdlc_session: browserSession!.value },
        headers: { 'x-csrf-token': csrf },
        payload: { userCode: pairing.userCode },
      });
      expect(approved.statusCode).toBe(200);

      const polled = await app.inject({
        method: 'POST',
        url: '/api/pairing/poll',
        payload: { deviceCode: pairing.deviceCode },
      });
      const credential = polled.json<{ status: string; accessToken: string }>();
      expect(credential.status).toBe('approved');
      expect(credential.accessToken).toMatch(/^sdlc_[a-f0-9]{64}$/);

      const mcp = await app.inject({
        method: 'GET',
        url: '/api/me',
        headers: { authorization: `Bearer ${credential.accessToken}` },
      });
      expect(mcp.json()).toMatchObject({ user: { login: 'local-operator', role: 'admin' } });
      expect(mcp.cookies.some((cookie) => cookie.name === 'sdlc_session')).toBe(true);
    } finally {
      await app.close();
      await store.close();
    }
  });

  it('replaces an existing local browser session when OAuth becomes available', async () => {
    vi.stubEnv('GITHUB_CLIENT_ID', '');
    vi.stubEnv('GITHUB_CLIENT_SECRET', '');
    const store = await Store.open();
    const app = await buildApi(store, new RunService(store));

    try {
      const local = await app.inject({ method: 'GET', url: '/api/me' });
      expect(local.json()).toMatchObject({ user: { login: 'local-operator' } });
      const session = local.cookies.find((cookie) => cookie.name === 'sdlc_session');
      expect(session).toBeTruthy();

      vi.stubEnv('GITHUB_CLIENT_ID', 'client-id');
      vi.stubEnv('GITHUB_CLIENT_SECRET', 'client-secret');
      const oauthRequired = await app.inject({
        method: 'GET',
        url: '/api/me',
        cookies: { sdlc_session: session!.value },
      });
      expect(oauthRequired.json()).toMatchObject({ user: null, githubOAuth: true });
    } finally {
      await app.close();
      await store.close();
    }
  });

  it('uses the GitHub consent callback for identity without repository access', async () => {
    vi.stubEnv('GITHUB_CLIENT_ID', 'client-id');
    vi.stubEnv('GITHUB_CLIENT_SECRET', 'client-secret');
    vi.stubEnv('GITHUB_ALLOWED_USERS', 'octocat');
    vi.stubEnv('GITHUB_ADMIN_USERS', 'octocat');
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ access_token: 'oauth-access-token', scope: '' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ login: 'octocat' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      );
    vi.stubGlobal('fetch', fetchMock);
    const store = await Store.open();
    const app = await buildApi(store, new RunService(store));

    try {
      const anonymous = await app.inject({ method: 'GET', url: '/api/me' });
      expect(anonymous.json()).toMatchObject({ user: null, githubOAuth: true });

      const authorization = await app.inject({
        method: 'GET',
        url: '/auth/github?pair=ABCD-EF12-3456',
      });
      expect(authorization.statusCode).toBe(302);
      const location = new URL(authorization.headers.location!);
      const state = location.searchParams.get('state');
      expect(state).toBeTruthy();
      expect(location.searchParams.has('scope')).toBe(false);
      const stateCookie = authorization.cookies.find((cookie) => cookie.name === 'oauth_state');
      const pairCookie = authorization.cookies.find((cookie) => cookie.name === 'oauth_pair');
      expect(stateCookie).toBeTruthy();
      expect(pairCookie).toBeTruthy();

      const callback = await app.inject({
        method: 'GET',
        url: `/auth/github/callback?code=temporary-code&state=${encodeURIComponent(state!)}`,
        cookies: { oauth_state: stateCookie!.value, oauth_pair: pairCookie!.value },
      });
      expect(callback.statusCode).toBe(302);
      expect(callback.headers.location).toContain('/?pair=ABCD-EF12-3456');
      const session = callback.cookies.find((cookie) => cookie.name === 'sdlc_session');
      expect(session).toBeTruthy();

      const setup = await app.inject({
        method: 'GET',
        url: '/api/setup',
        cookies: { sdlc_session: session!.value },
      });
      expect(setup.json()).toMatchObject({ github: false, githubOAuth: true, githubLogin: 'octocat' });
      expect(await store.secret('github-oauth-token')).toBeUndefined();
    } finally {
      await app.close();
      await store.close();
    }
  });

  it('allows any GitHub identity as an operator when the allowlist is a wildcard', async () => {
    vi.stubEnv('GITHUB_CLIENT_ID', 'client-id');
    vi.stubEnv('GITHUB_CLIENT_SECRET', 'client-secret');
    vi.stubEnv('GITHUB_ALLOWED_USERS', '*');
    vi.stubEnv('GITHUB_ADMIN_USERS', 'admin-user');
    vi.stubGlobal(
      'fetch',
      vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ access_token: 'oauth-access-token', scope: '' }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
        )
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ login: 'public-tester' }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
        ),
    );
    const store = await Store.open();
    const app = await buildApi(store, new RunService(store));

    try {
      const authorization = await app.inject({ method: 'GET', url: '/auth/github' });
      const location = new URL(authorization.headers.location!);
      const state = location.searchParams.get('state');
      const stateCookie = authorization.cookies.find((cookie) => cookie.name === 'oauth_state');
      const callback = await app.inject({
        method: 'GET',
        url: `/auth/github/callback?code=temporary-code&state=${encodeURIComponent(state!)}`,
        cookies: { oauth_state: stateCookie!.value },
      });
      const session = callback.cookies.find((cookie) => cookie.name === 'sdlc_session');
      const me = await app.inject({
        method: 'GET',
        url: '/api/me',
        cookies: { sdlc_session: session!.value },
      });

      expect(me.json()).toMatchObject({ user: { login: 'public-tester', role: 'operator' } });
    } finally {
      await app.close();
      await store.close();
    }
  });

  it('isolates repositories, runs, reports, artifacts, and mutations by GitHub user', async () => {
    const store = await Store.open();
    const app = await buildApi(store, new RunService(store));
    const alice = { session: 'alice-session', csrf: 'alice-csrf' };
    const bob = { session: 'bob-session', csrf: 'bob-csrf' };
    const repositoryInput = {
      name: 'Shared repository name',
      owner: 'example-company',
      repo: 'service',
      branch: 'main',
      stack: 'typescript',
      standards: '',
      checks: [
        {
          id: 'unit',
          label: 'Unit tests',
          argv: ['npm', 'test'],
          required: true,
          kind: 'unit',
          report: 'exit',
          reportPath: '',
          timeoutSeconds: 60,
        },
      ],
      requiredCiChecks: [],
      ciWaiver: 'Isolation test does not publish.',
      protectedPaths: [],
      deployment: {
        enabled: false,
        target: '',
        environment: 'staging',
        workflow: 'deploy.yml',
        rollbackWorkflow: 'rollback.yml',
        healthUrl: '',
        monitorIntervalSeconds: 300,
      },
    };
    const request = (identity: typeof alice, method: 'GET' | 'POST', url: string, payload?: Record<string, unknown>) =>
      app.inject({
        method,
        url,
        cookies: { sdlc_session: identity.session },
        headers: method === 'POST' ? { 'x-csrf-token': identity.csrf } : undefined,
        payload,
      });

    try {
      await store.setSession(alice.session, { login: 'Alice', role: 'operator' }, alice.csrf);
      await store.setSession(bob.session, { login: 'Bob', role: 'operator' }, bob.csrf);

      const aliceRepositoryResponse = await request(alice, 'POST', '/api/repositories', repositoryInput);
      const bobRepositoryResponse = await request(bob, 'POST', '/api/repositories', repositoryInput);
      expect(aliceRepositoryResponse.statusCode).toBe(200);
      expect(bobRepositoryResponse.statusCode).toBe(200);
      const aliceRepository = aliceRepositoryResponse.json<{ id: string; tenantId: string }>();
      const bobRepository = bobRepositoryResponse.json<{ id: string; tenantId: string }>();
      expect(aliceRepository).toMatchObject({ tenantId: 'alice' });
      expect(bobRepository).toMatchObject({ tenantId: 'bob' });
      expect(bobRepository.id).not.toBe(aliceRepository.id);

      const aliceRepositories = (await request(alice, 'GET', '/api/repositories')).json<{ id: string }[]>();
      const bobRepositories = (await request(bob, 'GET', '/api/repositories')).json<{ id: string }[]>();
      expect(aliceRepositories.map(({ id }) => id)).toEqual([aliceRepository.id]);
      expect(bobRepositories.map(({ id }) => id)).toEqual([bobRepository.id]);

      const createRun = await request(alice, 'POST', '/api/runs', {
        repositoryId: aliceRepository.id,
        prompt: 'Add user isolation to every lifecycle record.',
        mode: 'delivery',
        workspace: {
          branch: 'main',
          headSha: 'a'.repeat(40),
          digest: 'b'.repeat(40),
          dirty: false,
          changes: [],
        },
      });
      expect(createRun.statusCode).toBe(200);
      const run = createRun.json<{ run: { id: string; tenantId: string } }>().run;
      expect(run.tenantId).toBe('alice');
      const storedRun = await store.getRun(run.id);
      const artifact = await store.artifact(storedRun!, 'private.txt', 'alice-only evidence');

      expect((await request(alice, 'GET', '/api/runs')).json<{ id: string }[]>()).toHaveLength(1);
      expect((await request(bob, 'GET', '/api/runs')).json<{ id: string }[]>()).toHaveLength(0);
      expect((await request(alice, 'GET', `/api/runs/${run.id}`)).statusCode).toBe(200);
      expect((await request(bob, 'GET', `/api/runs/${run.id}`)).statusCode).toBe(404);
      expect((await request(bob, 'GET', `/api/runs/${run.id}/report`)).statusCode).toBe(404);
      expect((await request(bob, 'GET', `/api/artifacts/${artifact.id}`)).statusCode).toBe(404);
      expect((await request(alice, 'GET', `/api/artifacts/${artifact.id}`)).body).toBe('alice-only evidence');
      expect((await request(bob, 'POST', `/api/runs/${run.id}/cancel`, {})).statusCode).toBe(404);

      const crossTenantCreate = await request(bob, 'POST', '/api/runs', {
        repositoryId: aliceRepository.id,
        prompt: 'Attempt to use a repository owned by another user.',
        mode: 'delivery',
        workspace: {
          branch: 'main',
          headSha: 'a'.repeat(40),
          digest: 'b'.repeat(40),
          dirty: false,
          changes: [],
        },
      });
      expect(crossTenantCreate.statusCode).toBe(404);
    } finally {
      await app.close();
      await store.close();
    }
  });
});
