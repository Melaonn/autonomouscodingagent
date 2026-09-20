import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  availableRepositories,
  githubOAuthConfigured,
  markReady,
  oauthUrl,
  oauthUser,
  setRepositoryOAuth,
  setRepositoryToken,
} from '../apps/server/src/github.js';
import type { Repository } from '../shared/types.js';

afterEach(() => {
  setRepositoryToken('');
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('GitHub browser authorization', () => {
  it('requests repository and workflow access through the OAuth consent page', () => {
    vi.stubEnv('GITHUB_CLIENT_ID', 'client-id');
    vi.stubEnv('GITHUB_CLIENT_SECRET', 'client-secret');

    const redirectUri = 'http://localhost:4310/auth/github/callback';
    const url = new URL(oauthUrl('state-value', redirectUri));

    expect(githubOAuthConfigured()).toBe(true);
    expect(url.origin + url.pathname).toBe('https://github.com/login/oauth/authorize');
    expect(url.searchParams.get('client_id')).toBe('client-id');
    expect(url.searchParams.get('redirect_uri')).toBe(redirectUri);
    expect(url.searchParams.get('scope')?.split(' ')).toEqual(['read:user', 'repo', 'workflow']);
    expect(url.searchParams.get('state')).toBe('state-value');
  });

  it('exchanges the temporary code and returns the user with the OAuth credential', async () => {
    vi.stubEnv('GITHUB_CLIENT_ID', 'client-id');
    vi.stubEnv('GITHUB_CLIENT_SECRET', 'client-secret');
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ access_token: 'oauth-access-token', scope: 'repo,workflow,read:user' }), {
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

    const redirectUri = 'http://localhost:4310/auth/github/callback';
    const identity = await oauthUser('temporary-code', redirectUri);

    expect(identity).toEqual({
      login: 'octocat',
      credential: { accessToken: 'oauth-access-token' },
      scopes: ['repo', 'workflow', 'read:user'],
    });
    const exchange = JSON.parse(String(fetchMock.mock.calls[0][1]?.body));
    expect(exchange).toMatchObject({
      client_id: 'client-id',
      client_secret: 'client-secret',
      code: 'temporary-code',
      redirect_uri: redirectUri,
    });
    expect(fetchMock.mock.calls[1][1]?.headers).toMatchObject({ authorization: 'Bearer oauth-access-token' });
  });

  it('refreshes and persists an expired OAuth credential before repository access', async () => {
    vi.stubEnv('GITHUB_CLIENT_ID', 'client-id');
    vi.stubEnv('GITHUB_CLIENT_SECRET', 'client-secret');
    const persist = vi.fn(async () => undefined);
    setRepositoryOAuth(
      {
        accessToken: 'expired-token',
        expiresAt: Date.now() - 1,
        refreshToken: 'refresh-token',
        refreshTokenExpiresAt: Date.now() + 60_000,
      },
      persist,
    );
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            access_token: 'refreshed-token',
            expires_in: 28_800,
            refresh_token: 'next-refresh-token',
            refresh_token_expires_in: 15_897_600,
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify([]), { status: 200, headers: { 'content-type': 'application/json' } }),
      );
    vi.stubGlobal('fetch', fetchMock);

    await expect(availableRepositories()).resolves.toEqual([]);

    const refresh = JSON.parse(String(fetchMock.mock.calls[0][1]?.body));
    expect(refresh).toMatchObject({
      client_id: 'client-id',
      client_secret: 'client-secret',
      grant_type: 'refresh_token',
      refresh_token: 'refresh-token',
    });
    expect(fetchMock.mock.calls[1][1]?.headers).toMatchObject({ authorization: 'Bearer refreshed-token' });
    expect(persist).toHaveBeenCalledWith(
      expect.objectContaining({ accessToken: 'refreshed-token', refreshToken: 'next-refresh-token' }),
    );
  });
});

describe('GitHub pull request delivery', () => {
  it('marks a draft ready through the supported GraphQL mutation', async () => {
    setRepositoryToken('test-token');
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ node_id: 'PR_node', draft: true }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            data: { markPullRequestReadyForReview: { pullRequest: { isDraft: false } } },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
      );
    vi.stubGlobal('fetch', fetchMock);

    await markReady({ owner: 'team', repo: 'project' } as Repository, 7);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0][0]).toBe('https://api.github.com/repos/team/project/pulls/7');
    expect(fetchMock.mock.calls[1][0]).toBe('https://api.github.com/graphql');
    const request = JSON.parse(String(fetchMock.mock.calls[1][1]?.body));
    expect(request.variables).toEqual({ pullRequestId: 'PR_node' });
    expect(request.query).toContain('markPullRequestReadyForReview');
  });
});
