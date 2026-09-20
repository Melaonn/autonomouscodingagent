import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  githubOAuthConfigured,
  markReady,
  oauthUrl,
  oauthUser,
  setRepositoryToken,
} from '../apps/server/src/github.js';
import type { Repository } from '../shared/types.js';

afterEach(() => {
  setRepositoryToken('');
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('GitHub browser authorization', () => {
  it('requests identity without repository or workflow scopes', () => {
    vi.stubEnv('GITHUB_CLIENT_ID', 'client-id');
    vi.stubEnv('GITHUB_CLIENT_SECRET', 'client-secret');

    const redirectUri = 'http://localhost:4310/auth/github/callback';
    const url = new URL(oauthUrl('state-value', redirectUri));

    expect(githubOAuthConfigured()).toBe(true);
    expect(url.origin + url.pathname).toBe('https://github.com/login/oauth/authorize');
    expect(url.searchParams.get('client_id')).toBe('client-id');
    expect(url.searchParams.get('redirect_uri')).toBe(redirectUri);
    expect(url.searchParams.has('scope')).toBe(false);
    expect(url.searchParams.get('state')).toBe('state-value');
  });

  it('exchanges the temporary code only to identify the user', async () => {
    vi.stubEnv('GITHUB_CLIENT_ID', 'client-id');
    vi.stubEnv('GITHUB_CLIENT_SECRET', 'client-secret');
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

    const redirectUri = 'http://localhost:4310/auth/github/callback';
    const identity = await oauthUser('temporary-code', redirectUri);

    expect(identity).toEqual({
      login: 'octocat',
      scopes: [],
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
