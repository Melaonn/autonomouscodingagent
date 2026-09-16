import 'dotenv/config';
import Fastify from 'fastify';
import Docker from 'dockerode';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { backendSchema, commandSchema } from '../../../shared/types.js';
import { safePath, redact, equalSecret } from './security.js';
import { dockerLogText } from './docker-stream.js';
const app = Fastify({ logger: true, bodyLimit: 2 * 1024 * 1024 });
const docker = new Docker();
const token = process.env.RUNNER_TOKEN || '';
const workerImage = process.env.WORKER_IMAGE || 'sdlc-worker:local';
const active = new Map<string, Set<string>>();
const volumeName = (runId: string) => `sdlc-run-${runId.replace(/[^a-zA-Z0-9_.-]/g, '')}`;
app.addHook('onRequest', async req => { const auth = req.headers.authorization?.slice(7) || ''; if (!token || !equalSecret(auth, token)) throw Object.assign(new Error('Unauthorized'), { statusCode: 401 }); });
const runIdSchema = z.string().uuid();
const jobSchema = z.object({ runId: runIdSchema, command: commandSchema, acceptanceFiles: z.array(z.object({ path: z.string(), content: z.string().max(2_000_000) })).optional() });
async function execute(runId: string, cmd: string[], options: { env?: string[]; timeout?: number; network?: string; binds?: string[] } = {}) {
  const started = Date.now();
  const container = await docker.createContainer({ Image: workerImage, Cmd: cmd, WorkingDir: '/workspace', Env: options.env || [], User: '10001:10001',
    HostConfig: { AutoRemove: false, NetworkMode: options.network || 'none', ReadonlyRootfs: true,
      CapDrop: ['ALL'], SecurityOpt: ['no-new-privileges'], PidsLimit: 512, Memory: 3 * 1024 ** 3, NanoCpus: 2_000_000_000,
      Binds: [`${volumeName(runId)}:/workspace`, ...(options.binds || [])], Tmpfs: { '/tmp': 'rw,noexec,nosuid,size=512m', '/home/worker/.cache': 'rw,nosuid,size=512m' } } });
  const set = active.get(runId) || new Set<string>(); set.add(container.id); active.set(runId, set);
  let timedOut = false;
  try {
    await container.start();
    const waitPromise = container.wait();
    const deadline = setTimeout(() => { timedOut = true; void container.kill().catch(() => undefined); }, (options.timeout || 600) * 1000);
    const status = await waitPromise; clearTimeout(deadline);
    const stdout = dockerLogText(await container.logs({ stdout: true, stderr: false }));
    const stderr = dockerLogText(await container.logs({ stdout: false, stderr: true }));
    return { exitCode: timedOut ? 124 : status.StatusCode, stdout: redact(stdout), stderr: redact(stderr), durationMs: Date.now() - started, files: {} as Record<string, string> };
  } finally { set.delete(container.id); await container.remove({ force: true }).catch(() => undefined); }
}
async function exec(runId: string, cmd: string[], timeout = 600, network = 'none') { return execute(runId, cmd, { timeout, network }); }
async function readFile(runId: string, path: string) { const value = await exec(runId, ['sdlc-read-file', safePath(path)], 30); return value.exitCode === 0 ? value.stdout : ''; }
async function gitSecret<T>(tokenValue: string | undefined, action: (binds: string[]) => Promise<T>) {
  const value = tokenValue || process.env.GITHUB_TOKEN; if (!value) return action([]);
  const directory = join(tmpdir(), `sdlc-git-${randomUUID()}`); await mkdir(directory); const file = join(directory, 'token'); await writeFile(file, value, { encoding: 'utf8', mode: 0o600 });
  try { return await action([`${file}:/run/secrets/github_token:ro`]); } finally { await rm(directory, { recursive: true, force: true }); }
}
app.get('/ready', async () => {
  const info = await docker.info(); const images = await docker.listImages({ filters: { reference: [workerImage] } });
  let codex = 'unavailable', claude = 'unavailable';
  if (images.length) { const probeId = randomUUID(); await docker.createVolume({ Name: volumeName(probeId) });
    codex = (await exec(probeId, ['codex', '--version'], 30)).stdout.trim() || 'unavailable'; claude = (await exec(probeId, ['claude', '--version'], 30)).stdout.trim() || 'unavailable'; await docker.getVolume(volumeName(probeId)).remove().catch(() => undefined); }
  return { ok: images.length > 0 && codex !== 'unavailable' && claude !== 'unavailable', docker: info.ServerVersion, image: images.length > 0, agents: { codex, claude } };
});
app.post('/prepare', async req => {
  const body = z.object({ runId: runIdSchema, owner: z.string().regex(/^[\w.-]+$/), repo: z.string().regex(/^[\w.-]+$/), branch: z.string().min(1).max(200).refine(v => !v.startsWith('-') && !v.includes('..')), githubToken: z.string().min(1).optional() }).parse(req.body);
  await docker.createVolume({ Name: volumeName(body.runId), Labels: { 'sdlc.run': body.runId } });
  const clone = await gitSecret(body.githubToken, binds => execute(body.runId, ['git', '-c', 'credential.helper=/usr/local/bin/sdlc-git-credential', 'clone', '--branch', body.branch, '--single-branch', `https://github.com/${body.owner}/${body.repo}.git`, '.'], { timeout: 600, network: 'bridge', binds })); if (clone.exitCode) throw new Error(`Clone failed: ${clone.stderr}`);
  const sha = await exec(body.runId, ['git', 'rev-parse', 'HEAD'], 30); return sha.stdout.trim();
});
app.post('/agent', async req => {
  const body = z.object({ runId: runIdSchema, backend: backendSchema, prompt: z.string().max(300_000), timeoutSeconds: z.number().int().max(3600), phase: z.string() }).parse(req.body);
  const promptPath = `.sdlc-prompt-${randomUUID()}.txt`; const temp = join(tmpdir(), `sdlc-${randomUUID()}`); await mkdir(temp); await writeFile(join(temp, 'prompt.txt'), body.prompt, { encoding: 'utf8', mode: 0o600 });
  const binds = [`${join(temp, 'prompt.txt')}:/control/prompt.txt:ro`];
  const authDir = body.backend === 'codex' ? process.env.CODEX_AUTH_DIR : process.env.CLAUDE_AUTH_DIR;
  if (authDir) binds.push(`${authDir}:${body.backend === 'codex' ? '/home/worker/.codex' : '/home/worker/.claude'}:rw`);
  const cmd = body.backend === 'codex' ? ['bash', '-lc', 'cat /control/prompt.txt | codex exec - --json --sandbox danger-full-access --ignore-user-config --ignore-rules -C /workspace']
    : ['bash', '-lc', 'cat /control/prompt.txt | claude -p --output-format stream-json --verbose --setting-sources "" --allowedTools Read,Edit,Write,Bash,Glob,Grep'];
  try { return await execute(body.runId, cmd, { timeout: body.timeoutSeconds, network: 'bridge', binds }); } finally { await rm(temp, { recursive: true, force: true }); void promptPath; }
});
app.post('/command', async req => {
  const body = jobSchema.parse(req.body);
  let acceptanceDirectory: string | undefined;
  if (body.acceptanceFiles) { acceptanceDirectory = join(tmpdir(), `sdlc-acceptance-${randomUUID()}`); await mkdir(acceptanceDirectory, { recursive: true }); for (const file of body.acceptanceFiles) { const path = safePath(file.path); if (path.includes('/')) throw new Error('Acceptance files must use flat names'); await writeFile(join(acceptanceDirectory, path), file.content, { encoding: 'utf8', mode: 0o444 }); } }
  const network = body.command.kind === 'setup' ? 'bridge' : 'none';
  try { const result = await execute(body.runId, body.command.argv, { timeout: body.command.timeoutSeconds, network, binds: acceptanceDirectory ? [`${acceptanceDirectory}:/acceptance:ro`] : [] }); if (body.command.reportPath) result.files[body.command.reportPath] = await readFile(body.runId, body.command.reportPath) || result.stdout; return result; }
  finally { if (acceptanceDirectory) await rm(acceptanceDirectory, { recursive: true, force: true }); }
});
app.post('/commit', async req => {
  const body = z.object({ runId: runIdSchema, message: z.string().min(1).max(200), baseSha: z.string().regex(/^[a-f0-9]{40}$/) }).parse(req.body);
  for (const command of [['git','config','user.name','SDLC Control Plane'], ['git','config','user.email','sdlc@localhost'], ['git','add','-A'], ['git','commit','--allow-empty','-m',body.message]]) { const result = await exec(body.runId, command, 120); if (result.exitCode) throw new Error(result.stderr); }
  const sha = (await exec(body.runId, ['git','rev-parse','HEAD'], 30)).stdout.trim(); const changed = (await exec(body.runId, ['git','diff','--name-only',body.baseSha,'HEAD'], 30)).stdout.trim().split(/\r?\n/).filter(Boolean); return { sha, changed };
});
app.post('/diff', async req => { const body = z.object({ runId: runIdSchema, baseSha: z.string().regex(/^[a-f0-9]{40}$/) }).parse(req.body); const result = await exec(body.runId, ['git','diff','--no-ext-diff',body.baseSha,'HEAD'], 120); if (result.exitCode) throw new Error(result.stderr); return result.stdout; });
app.post('/push', async req => { const body = z.object({ runId: runIdSchema, branch: z.string().regex(/^[A-Za-z0-9._/-]+$/).refine(v => !v.startsWith('-') && !v.includes('..')), githubToken: z.string().min(1).optional() }).parse(req.body); const result = await gitSecret(body.githubToken, async binds => { const remote = await execute(body.runId, ['git','-c','credential.helper=/usr/local/bin/sdlc-git-credential','ls-remote','--heads','origin',`refs/heads/${body.branch}`], { timeout: 60, network: 'bridge', binds }); if (remote.exitCode) return remote; const expected = remote.stdout.trim().split(/\s+/)[0] || ''; return execute(body.runId, ['git','-c','credential.helper=/usr/local/bin/sdlc-git-credential','push','origin',`HEAD:refs/heads/${body.branch}`,`--force-with-lease=refs/heads/${body.branch}:${expected}`], { timeout: 180, network: 'bridge', binds }); }); if (result.exitCode) throw new Error(result.stderr); return { ok: true }; });
app.post('/destroy', async req => { const { runId } = z.object({ runId: runIdSchema }).parse(req.body); for (const id of active.get(runId) || []) await docker.getContainer(id).kill().catch(() => undefined); active.delete(runId); await docker.getVolume(volumeName(runId)).remove().catch(() => undefined); return { ok: true }; });
app.listen({ port: Number(process.env.RUNNER_PORT || 4311), host: process.env.RUNNER_HOST || '127.0.0.1' }).catch(error => { app.log.error(error); process.exit(1); });
