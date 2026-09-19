import { afterEach, describe, expect, it, vi } from 'vitest';
import { markReady, setRepositoryToken } from '../apps/server/src/github.js';
import type { Repository } from '../shared/types.js';

afterEach(() => {
  setRepositoryToken('');
  vi.unstubAllGlobals();
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
