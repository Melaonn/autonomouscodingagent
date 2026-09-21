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

      const authorization = await app.inject({ method: 'GET', url: '/auth/github' });
      expect(authorization.statusCode).toBe(302);
      const location = new URL(authorization.headers.location!);
      const state = location.searchParams.get('state');
      expect(state).toBeTruthy();
      expect(location.searchParams.has('scope')).toBe(false);
      const stateCookie = authorization.cookies.find((cookie) => cookie.name === 'oauth_state');
      expect(stateCookie).toBeTruthy();

      const callback = await app.inject({
        method: 'GET',
        url: `/auth/github/callback?code=temporary-code&state=${encodeURIComponent(state!)}`,
        cookies: { oauth_state: stateCookie!.value },
      });
      expect(callback.statusCode).toBe(302);
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
});
