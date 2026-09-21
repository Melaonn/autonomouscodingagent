import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify';
import cookie from '@fastify/cookie';
import staticPlugin from '@fastify/static';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { z } from 'zod';
import {
  contractSchema,
  designSchema,
  phases,
  planSchema,
  repositorySchema,
  reviewSchema,
  runModeSchema,
  specificationSchema,
  workspaceStateSchema,
  type Document,
  type Integration,
  type Repository,
  type Role,
  type User,
} from '../../../shared/types.js';
import { config } from './config.js';
import type { Store } from './store.js';
import type { RunService } from './run-service.js';
import { hash, nonce, endpoint, equalSecret } from './security.js';
import { profiles } from './profiles.js';
import { availableRepositories, githubConfigured, githubOAuthConfigured, oauthUrl, oauthUser } from './github.js';
import { report } from './gates.js';
import { inspectIntegration } from './mcp.js';
declare module 'fastify' {
  interface FastifyRequest {
    user?: User;
    sessionId?: string;
    csrf?: string;
  }
}
const error = (statusCode: number, message: string) => Object.assign(new Error(message), { statusCode });
const roles: Record<Role, number> = { viewer: 1, operator: 2, admin: 3 };
export async function buildApi(store: Store, runs: RunService) {
  const app = Fastify({
    logger: {
      redact: ['req.headers.authorization', 'req.headers.cookie'],
      serializers: {
        req(value: unknown) {
          const request = value as {
            method?: string;
            url?: string;
            headers?: { host?: string };
            socket?: { remoteAddress?: string; remotePort?: number };
          };
          return {
            method: request.method,
            url: request.url?.startsWith('/auth/github/callback') ? '/auth/github/callback' : request.url,
            host: request.headers?.host,
            remoteAddress: request.socket?.remoteAddress,
            remotePort: request.socket?.remotePort,
          };
        },
      },
    },
    bodyLimit: 20 * 1024 * 1024,
  });
  await app.register(cookie, { secret: config.sessionSecret });
  app.setErrorHandler((err, _req, reply) => {
    const failure = err as Error & { statusCode?: number };
    const status = typeof failure.statusCode === 'number' ? failure.statusCode : err instanceof z.ZodError ? 400 : 500;
    reply.status(status).send({
      error: status === 500 ? 'Internal request failure' : failure.message,
      details: err instanceof z.ZodError ? err.issues : undefined,
    });
  });
  app.addHook('onRequest', async (req) => {
    if (!req.url.startsWith('/api/')) return;
    const sid = req.cookies.sdlc_session;
    if (sid) {
      const session = await store.session(sid);
      if (session) {
        if (session.user.login === 'local-operator' && githubOAuthConfigured()) {
          await store.deleteSession(sid);
          return;
        }
        req.user = session.user;
        req.sessionId = sid;
        req.csrf = session.csrf;
      }
    }
  });
  app.addHook('preHandler', async (req) => {
    if (!req.url.startsWith('/api/') || req.method === 'GET' || req.method === 'HEAD') return;
    if (!req.user) throw error(401, 'Sign in required');
    if (req.headers['x-csrf-token'] !== req.csrf) throw error(403, 'CSRF token missing or invalid');
    const origin = req.headers.origin;
    const allowedOrigins = new Set([
      config.publicUrl,
      ...(!config.production ? ['http://127.0.0.1:5173', 'http://localhost:5173'] : []),
    ]);
    if (origin && !allowedOrigins.has(origin)) throw error(403, 'Request origin rejected');
  });
  const requireRole = (req: FastifyRequest, role: Role) => {
    if (!req.user) throw error(401, 'Sign in required');
    if (roles[req.user.role] < roles[role]) throw error(403, `${role} role required`);
    return req.user;
  };
  const setSession = async (reply: FastifyReply, user: User) => {
    const id = nonce();
    const csrf = nonce();
    await store.setSession(id, user, csrf);
    reply.setCookie('sdlc_session', id, {
      httpOnly: true,
      secure: config.secureCookies,
      sameSite: 'lax',
      path: '/',
      maxAge: 43200,
    });
    return { user, csrf };
  };
  const oauthCallback = new URL('/auth/github/callback', config.publicUrl).toString();
  const localMcpRequest = (req: FastifyRequest) => {
    const authorization = req.headers.authorization || '';
    const prefix = 'Bearer ';
    return (
      !!config.localMcpToken &&
      authorization.startsWith(prefix) &&
      equalSecret(authorization.slice(prefix.length), config.localMcpToken)
    );
  };
  app.get('/healthz', async () => ({ status: 'ok' }));
  app.get('/auth/github', async (_req, reply) => {
    if (!githubOAuthConfigured()) throw error(503, 'GitHub OAuth is not configured');
    const state = nonce();
    reply.setCookie('oauth_state', state, {
      httpOnly: true,
      secure: config.secureCookies,
      sameSite: 'lax',
      path: '/auth',
      maxAge: 600,
    });
    return reply.redirect(oauthUrl(state, oauthCallback));
  });
  app.get('/auth/github/callback', async (req, reply) => {
    const query = z
      .object({
        code: z.string().optional(),
        state: z.string().optional(),
        error: z.string().optional(),
        error_description: z.string().optional(),
      })
      .parse(req.query);
    if (query.error) throw error(400, query.error_description || `GitHub authorization failed: ${query.error}`);
    if (!query.code || !query.state) throw error(400, 'GitHub authorization response is incomplete');
    if (!req.cookies.oauth_state || !equalSecret(req.cookies.oauth_state, query.state))
      throw error(400, 'OAuth state rejected');
    const gh = await oauthUser(query.code, oauthCallback);
    const allowed = (process.env.GITHUB_ALLOWED_USERS || '')
      .split(',')
      .map((x) => x.trim().toLowerCase())
      .filter(Boolean);
    if (allowed.length && !allowed.includes(gh.login.toLowerCase())) throw error(403, 'GitHub user is not allowlisted');
    const admins = (process.env.GITHUB_ADMIN_USERS || '')
      .split(',')
      .map((x) => x.trim().toLowerCase())
      .filter(Boolean);
    await store.audit(gh.login, 'github.oauth.connect', { scopes: gh.scopes });
    await setSession(reply, {
      login: gh.login,
      role: !admins.length || admins.includes(gh.login.toLowerCase()) ? 'admin' : 'operator',
    });
    reply.clearCookie('oauth_state', { path: '/auth' });
    return reply.redirect(config.publicUrl);
  });
  app.get('/api/me', async (req, reply) => {
    if (!req.user && localMcpRequest(req)) {
      const session = await setSession(reply, { login: 'codex-mcp', role: 'admin' });
      return { ...session, githubOAuth: githubOAuthConfigured() };
    }
    if (!req.user && !githubOAuthConfigured() && !config.production && ['127.0.0.1', '::1'].includes(req.ip)) {
      const session = await setSession(reply, { login: 'local-operator', role: 'admin' });
      return { ...session, githubOAuth: false };
    }
    return {
      user: req.user || null,
      csrf: req.csrf || '',
      githubOAuth: githubOAuthConfigured(),
    };
  });
  app.post('/api/logout', async (req, reply) => {
    if (req.sessionId) await store.deleteSession(req.sessionId);
    reply.clearCookie('sdlc_session', { path: '/' });
    return { ok: true };
  });
  app.get('/api/readiness', async (req) => {
    requireRole(req, 'viewer');
    return {
      execution: 'native Codex app or CLI',
      github: await githubConfigured(),
      database: true,
      deploymentRule: 'explicit approval required',
    };
  });
  app.get('/api/setup', async (req) => {
    const actor = requireRole(req, 'admin');
    return {
      github: await githubConfigured(),
      githubOAuth: githubOAuthConfigured(),
      githubLogin: actor.login === 'codex-mcp' || actor.login === 'local-operator' ? null : actor.login,
      repositories: (await store.repositories()).length,
    };
  });
  app.get('/api/github/repositories', async (req) => {
    requireRole(req, 'admin');
    if (!(await githubConfigured())) throw error(409, 'Authenticate Git locally before browsing remote repositories');
    return availableRepositories();
  });
  app.get('/api/profiles', async (req) => {
    requireRole(req, 'admin');
    return profiles;
  });
  app.get('/api/repositories', async (req) => {
    requireRole(req, 'viewer');
    return store.repositories();
  });
  app.post('/api/repositories', async (req) => {
    const actor = requireRole(req, 'admin');
    const input = repositorySchema.parse(req.body);
    if (input.deployment.enabled) {
      endpoint(input.deployment.healthUrl, !config.production);
      if (!input.deployment.target.trim()) throw error(400, 'Deployment target is required');
      if (!input.deployment.workflow || !input.deployment.rollbackWorkflow)
        throw error(400, 'Deployment and rollback workflows are required');
      if (
        ![input.deployment.workflow, input.deployment.rollbackWorkflow].every((name) => /^[\w.-]+\.ya?ml$/.test(name))
      )
        throw error(400, 'Deployment workflow names must be YAML filenames without directories');
    }
    if (!input.requiredCiChecks.length && !input.ciWaiver.trim())
      throw error(400, 'Configure required CI checks or a documented CI waiver');
    const existing = (await store.repositories()).find(
      (repository) =>
        repository.owner.toLowerCase() === input.owner.toLowerCase() &&
        repository.repo.toLowerCase() === input.repo.toLowerCase(),
    );
    const repository = {
      ...input,
      id: existing?.id || randomUUID(),
      version: (existing?.version || 0) + 1,
      createdAt: new Date().toISOString(),
    };
    await store.put('repository', repository);
    await store.audit(actor.login, existing ? 'repository.update' : 'repository.create', {
      id: repository.id,
      version: repository.version,
    });
    return repository;
  });
  app.get('/api/documents', async (req) => {
    requireRole(req, 'viewer');
    return (await store.documents()).map(({ content, ...d }) => ({ ...d, excerpt: content.slice(0, 300) }));
  });
  app.post('/api/documents', async (req) => {
    const actor = requireRole(req, 'admin');
    const body = z
      .object({
        id: z.string().uuid().optional(),
        title: z.string().min(1).max(200),
        source: z.string().max(500),
        owner: z.string().min(1).max(120),
        content: z.string().min(1).max(2_000_000),
      })
      .parse(req.body);
    const existing = body.id ? await store.get<Document>('document', body.id) : undefined;
    const doc: Document = {
      ...body,
      id: existing?.id || randomUUID(),
      version: (existing?.version || 0) + 1,
      hash: hash(body.content),
      createdAt: new Date().toISOString(),
    };
    await store.putDocument(doc);
    await store.audit(actor.login, 'document.save', { id: doc.id, version: doc.version, hash: doc.hash });
    return { ...doc, content: undefined };
  });
  app.get('/api/integrations', async (req) => {
    requireRole(req, 'admin');
    return store.integrations();
  });
  app.post('/api/integrations', async (req) => {
    const actor = requireRole(req, 'admin');
    const body = z
      .object({
        id: z.string().uuid().optional(),
        name: z.string().min(1),
        url: z.string().url(),
        allowedTools: z.array(z.string()),
        enabled: z.boolean(),
        headersEnv: z.record(z.string(), z.string()),
        contextCalls: z
          .array(z.object({ tool: z.string(), arguments: z.record(z.string(), z.unknown()) }))
          .max(10)
          .default([]),
      })
      .parse(req.body);
    for (const call of body.contextCalls)
      if (!body.allowedTools.includes(call.tool)) throw error(400, `Context tool ${call.tool} is not allowlisted`);
    const integration: Integration = {
      ...body,
      id: body.id || randomUUID(),
      url: endpoint(body.url, !config.production),
    };
    await store.put('integration', integration);
    const tools = integration.enabled ? await inspectIntegration(integration) : [];
    await store.audit(actor.login, 'integration.save', { id: integration.id, tools: tools.map((t) => t.name) });
    return { integration, tools };
  });
  app.get('/api/runs', async (req) => {
    requireRole(req, 'viewer');
    return (await store.runs()).map((r) => ({ ...r, policy: { ...r.policy, standards: '' } }));
  });
  app.get('/api/runs/:id', async (req) => {
    requireRole(req, 'viewer');
    const run = await store.getRun(z.object({ id: z.string().uuid() }).parse(req.params).id);
    if (!run) throw error(404, 'Run not found');
    return { run, events: await store.events(run.id), artifacts: await store.artifacts(run.id) };
  });
  app.post('/api/runs', async (req) => {
    const actor = requireRole(req, 'operator');
    const body = z
      .object({
        repositoryId: z.string().uuid(),
        prompt: z.string().min(10).max(100000),
        mode: runModeSchema.default('delivery'),
        workspace: workspaceStateSchema,
      })
      .parse(req.body);
    const repository = await store.get<Repository>('repository', body.repositoryId);
    if (!repository) throw error(404, 'Repository not found');
    return runs.create(repository, body.prompt, body.workspace, body.mode, actor.login);
  });
  app.post('/api/runs/:id/plan', async (req) => {
    const actor = requireRole(req, 'operator');
    const id = z.object({ id: z.string().uuid() }).parse(req.params).id;
    return runs.savePlan(id, planSchema.parse(req.body), actor.login);
  });
  app.post('/api/runs/:id/requirements', async (req) => {
    const actor = requireRole(req, 'operator');
    const id = z.object({ id: z.string().uuid() }).parse(req.params).id;
    return runs.saveRequirements(id, contractSchema.parse(req.body), actor.login);
  });
  app.post('/api/runs/:id/design', async (req) => {
    const actor = requireRole(req, 'operator');
    const id = z.object({ id: z.string().uuid() }).parse(req.params).id;
    return runs.saveDesign(id, designSchema.parse(req.body), actor.login);
  });
  app.post('/api/runs/:id/specification', async (req) => {
    const actor = requireRole(req, 'operator');
    const id = z.object({ id: z.string().uuid() }).parse(req.params).id;
    return runs.saveSpecification(id, specificationSchema.parse(req.body), actor.login);
  });
  app.post('/api/runs/:id/progress', async (req) => {
    const actor = requireRole(req, 'operator');
    const id = z.object({ id: z.string().uuid() }).parse(req.params).id;
    const body = z
      .object({ phase: z.enum(phases), step: z.string().min(1).max(100), message: z.string().min(1).max(2000) })
      .parse(req.body);
    return runs.progress(id, body.phase, body.step, body.message, actor.login);
  });
  app.post('/api/runs/:id/verify', async (req) => {
    const actor = requireRole(req, 'operator');
    const id = z.object({ id: z.string().uuid() }).parse(req.params).id;
    const resultSchema = z.object({
      exitCode: z.number().int(),
      stdout: z.string().max(300000),
      stderr: z.string().max(300000),
      durationMs: z.number().nonnegative(),
      files: z.record(z.string(), z.string().max(300000)),
      cached: z.boolean().optional(),
    });
    const body = z
      .object({
        candidateDigest: z.string().regex(/^[0-9a-f]{40}$/),
        results: z.array(z.object({ commandId: z.string(), result: resultSchema })).max(20),
        changedPaths: z.array(z.string().min(1).max(500)).max(500).default([]),
      })
      .parse(req.body);
    return runs.verify(id, body.candidateDigest, body.results, body.changedPaths, actor.login);
  });
  app.post('/api/runs/:id/review', async (req) => {
    const actor = requireRole(req, 'operator');
    const id = z.object({ id: z.string().uuid() }).parse(req.params).id;
    return runs.saveReview(id, reviewSchema.parse(req.body), actor.login);
  });
  app.post('/api/runs/:id/publish', async (req) => {
    const actor = requireRole(req, 'operator');
    const id = z.object({ id: z.string().uuid() }).parse(req.params).id;
    const body = z
      .object({
        candidateDigest: z.string().regex(/^[0-9a-f]{40}$/),
        candidateSha: z.string().regex(/^[0-9a-f]{40}$/),
        branch: z.string().min(1).max(200),
      })
      .parse(req.body);
    return runs.publish(id, body.candidateDigest, body.candidateSha, body.branch, actor.login);
  });
  app.post('/api/runs/:id/sync', async (req) => {
    const actor = requireRole(req, 'operator');
    const id = z.object({ id: z.string().uuid() }).parse(req.params).id;
    return runs.sync(id, actor.login);
  });
  app.post('/api/runs/:id/answer', async (req) => {
    const actor = requireRole(req, 'operator');
    const id = z.object({ id: z.string().uuid() }).parse(req.params).id;
    const body = z.object({ answer: z.string().min(1).max(10000) }).parse(req.body);
    return runs.answer(id, body.answer, actor.login);
  });
  app.post('/api/runs/:id/approval', async (req) => {
    const actor = requireRole(req, 'operator');
    const id = z.object({ id: z.string().uuid() }).parse(req.params).id;
    const body = z.object({ approved: z.boolean(), digest: z.string() }).parse(req.body);
    return runs.approve(id, body.approved, body.digest, actor.login);
  });
  app.post('/api/runs/:id/cancel', async (req) => {
    const actor = requireRole(req, 'operator');
    const id = z.object({ id: z.string().uuid() }).parse(req.params).id;
    return runs.cancel(id, actor.login);
  });
  app.post('/api/runs/:id/resume', async (req) => {
    const actor = requireRole(req, 'operator');
    const id = z.object({ id: z.string().uuid() }).parse(req.params).id;
    return runs.resume(id, actor.login);
  });
  app.get('/api/runs/:id/report', async (req, reply) => {
    requireRole(req, 'viewer');
    const id = z.object({ id: z.string().uuid() }).parse(req.params).id;
    const run = await store.getRun(id);
    if (!run) throw error(404, 'Run not found');
    reply.type('text/markdown').header('content-disposition', `attachment; filename="sdlc-${id}.md"`);
    return report(run);
  });
  app.get('/api/artifacts/:id', async (req, reply) => {
    requireRole(req, 'viewer');
    const id = z.object({ id: z.string().uuid() }).parse(req.params).id;
    const artifact = await store.get<{ name: string; content: string }>('artifact', id);
    if (!artifact) throw error(404, 'Artifact not found');
    reply
      .type(artifact.name.endsWith('.json') ? 'application/json' : 'text/plain')
      .header('content-disposition', `attachment; filename="${artifact.name.replace(/[^\w.-]/g, '_')}"`);
    return artifact.content;
  });
  app.get('/api/audit', async (req) => {
    requireRole(req, 'admin');
    return store.audits();
  });
  const webRoot = resolve('apps/web/dist');
  if (existsSync(webRoot)) {
    await app.register(staticPlugin, { root: webRoot, wildcard: false });
    app.get('/*', (_req, reply) => reply.sendFile('index.html'));
  }
  return app;
}
