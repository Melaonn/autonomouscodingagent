/** Local-only API adapter. Credentials and cookies never enter tool results. */
export class ChatClient {
  private cookie = '';
  private csrf = '';
  private loginTask?: Promise<void>;
  readonly url: string;

  constructor(
    url: string,
    private password: string,
  ) {
    const parsed = new URL(url);
    if (
      parsed.protocol !== 'http:' ||
      !['127.0.0.1', '[::1]'].includes(parsed.hostname) ||
      parsed.username ||
      parsed.password ||
      parsed.pathname !== '/' ||
      parsed.search ||
      parsed.hash
    ) {
      throw new Error('SDLC chat requires a loopback HTTP URL, such as http://127.0.0.1:4310');
    }
    this.url = parsed.origin;
  }

  private async login() {
    if (!this.password) throw new Error('Harness login is missing. Complete local setup first.');
    const response = await fetch(`${this.url}/auth/password`, {
      method: 'POST',
      redirect: 'error',
      signal: AbortSignal.timeout(15_000),
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password: this.password }),
    });
    if (!response.ok) throw new Error(`Harness login failed (${response.status}). Check your local setup.`);
    this.cookie =
      response.headers
        .getSetCookie()
        .find((value) => value.startsWith('sdlc_session='))
        ?.split(';')[0] || '';
    if (!this.cookie) throw new Error('Harness did not establish a session.');
    const me = await fetch(`${this.url}/api/me`, {
      headers: { cookie: this.cookie },
      redirect: 'error',
      signal: AbortSignal.timeout(15_000),
    });
    if (!me.ok) throw new Error('Unable to read harness session.');
    this.csrf = ((await me.json()) as { csrf: string }).csrf;
  }

  async request<T>(path: string, body?: unknown): Promise<T> {
    // Deliberately exclude approval, credentials, policy writes and arbitrary URLs.
    const allowed = [
      /^\/api\/readiness$/,
      /^\/api\/repositories$/,
      /^\/api\/runs$/,
      /^\/api\/runs\/[\w-]+$/,
      /^\/api\/runs\/[\w-]+\/(plan|requirements|design|progress|verify|review|publish|sync|answer|cancel|resume|report)$/,
    ];
    if (!allowed.some((pattern) => pattern.test(path))) throw new Error('Unsupported chat operation.');
    if (!this.cookie) {
      this.loginTask ||= this.login().finally(() => {
        this.loginTask = undefined;
      });
      await this.loginTask;
    }
    const response = await fetch(`${this.url}${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      redirect: 'error',
      signal: AbortSignal.timeout(path.endsWith('/verify') ? 60 * 60_000 : 40_000),
      headers: { cookie: this.cookie, 'x-csrf-token': this.csrf, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!response.ok) {
      if (response.status === 401) {
        this.cookie = '';
        this.csrf = '';
      }
      // Never retry mutations automatically: a timed-out start may already exist.
      throw new Error(
        `Harness request failed (${response.status}). Inspect sdlc_runs before retrying a start; use the dashboard for details.`,
      );
    }
    return (path.endsWith('/report') ? response.text() : response.json()) as Promise<T>;
  }
}
