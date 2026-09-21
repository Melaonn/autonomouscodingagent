#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import spawn from 'cross-spawn';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir, platform } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { ChatClient } from '../../../apps/server/src/chat-client.js';
import { createChatServer } from '../../../apps/server/src/chat-mcp.js';

const DEFAULT_SERVER = 'https://sdlc-control-plane.onrender.com';
const PACKAGE_SPEC = '@melson/sdlc-mcp@0.1.2';
const START_MARKER = '<!-- sdlc-chat-integration -->';
const END_MARKER = '<!-- /sdlc-chat-integration -->';
const moduleDirectory = dirname(resolve(process.argv[1]));

type Credentials = { serverUrl: string; accessToken: string; login: string; connectedAt: string };
type PairingStart = {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  expiresIn: number;
  interval: number;
};
type PairingPoll = { status: 'pending' } | { status: 'approved'; accessToken: string; user: { login: string } };

export function credentialFile() {
  return process.env.SDLC_MCP_CREDENTIAL_FILE || join(homedir(), '.sdlc-control-plane', 'credentials.json');
}

function serverArgument(args: string[]) {
  const index = args.indexOf('--server');
  return index >= 0 && args[index + 1] ? args[index + 1] : DEFAULT_SERVER;
}

function validateServerUrl(value: string) {
  const parsed = new URL(value);
  const loopback = parsed.protocol === 'http:' && ['127.0.0.1', '[::1]'].includes(parsed.hostname);
  if ((!loopback && parsed.protocol !== 'https:') || parsed.username || parsed.password || parsed.search || parsed.hash)
    throw new Error('Use an HTTPS server URL, or loopback HTTP for local development.');
  return parsed.origin;
}

async function jsonRequest<T>(url: string, body: unknown): Promise<T> {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'user-agent': PACKAGE_SPEC },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) {
    const payload = (await response.json().catch(() => undefined)) as { error?: string } | undefined;
    throw new Error(payload?.error || `Connection failed (${response.status})`);
  }
  return response.json() as Promise<T>;
}

function openBrowser(url: string) {
  const command: [string, string[]] =
    platform() === 'win32'
      ? ['rundll32', ['url.dll,FileProtocolHandler', url]]
      : platform() === 'darwin'
        ? ['open', [url]]
        : ['xdg-open', [url]];
  const child = spawn(command[0], command[1], { detached: true, stdio: 'ignore', windowsHide: true });
  child.unref();
}

async function saveCredentials(credentials: Credentials) {
  const path = credentialFile();
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(credentials, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  await chmod(path, 0o600).catch(() => undefined);
}

async function loadCredentials() {
  const parsed = JSON.parse(await readFile(credentialFile(), 'utf8')) as Partial<Credentials>;
  if (!parsed.serverUrl || !parsed.accessToken) throw new Error('The saved SDLC credential is incomplete.');
  return parsed as Credentials;
}

async function installInstructions() {
  const codexHome = process.env.CODEX_HOME || join(homedir(), '.codex');
  const target = join(codexHome, 'AGENTS.md');
  const source = join(moduleDirectory, '..', 'instructions.md');
  const instructions = (await readFile(source, 'utf8')).trim();
  let existing = await readFile(target, 'utf8').catch(() => '');
  const start = existing.indexOf(START_MARKER);
  if (start >= 0) {
    const end = existing.indexOf(END_MARKER, start);
    const suffix = end >= 0 ? existing.slice(end + END_MARKER.length) : '';
    existing = `${existing.slice(0, start).trimEnd()}\n${instructions}${suffix}`;
  } else {
    existing = `${existing.trimEnd()}\n${instructions}\n`;
  }
  await mkdir(codexHome, { recursive: true });
  await writeFile(target, existing.trimStart(), 'utf8');
}

function configureCodex() {
  spawn.sync('codex', ['mcp', 'remove', 'sdlc'], { stdio: 'ignore', windowsHide: true });
  const npxCommand = platform() === 'win32' ? 'npx.cmd' : 'npx';
  const result = spawn.sync('codex', ['mcp', 'add', 'sdlc', '--', npxCommand, '-y', PACKAGE_SPEC, 'run'], {
    stdio: 'inherit',
    windowsHide: true,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error('Codex could not register the SDLC MCP server.');
}

async function install(args: string[]) {
  const serverUrl = validateServerUrl(serverArgument(args));
  const pairing = await jsonRequest<PairingStart>(`${serverUrl}/api/pairing/start`, {
    clientName: `Codex on ${platform()}`,
  });
  process.stdout.write(`Open ${pairing.verificationUri}\nApprove code ${pairing.userCode}\n`);
  if (process.env.SDLC_MCP_SKIP_BROWSER !== 'true') openBrowser(pairing.verificationUri);
  const deadline = Date.now() + pairing.expiresIn * 1_000;
  let approved: Extract<PairingPoll, { status: 'approved' }> | undefined;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, pairing.interval * 1_000));
    const status = await jsonRequest<PairingPoll>(`${serverUrl}/api/pairing/poll`, {
      deviceCode: pairing.deviceCode,
    });
    if (status.status === 'approved') {
      approved = status;
      break;
    }
  }
  if (!approved) throw new Error('Pairing expired. Run the install command again.');
  await saveCredentials({
    serverUrl,
    accessToken: approved.accessToken,
    login: approved.user.login,
    connectedAt: new Date().toISOString(),
  });
  await installInstructions();
  configureCodex();
  process.stdout.write(`\nConnected Codex as @${approved.user.login}. Restart Codex, then open a Git project.\n`);
}

async function run() {
  const credentials = await loadCredentials();
  const client = new ChatClient(credentials.serverUrl, credentials.accessToken);
  const server = createChatServer(client);
  await server.connect(new StdioServerTransport());
}

async function main() {
  const [command = 'help', ...args] = process.argv.slice(2);
  if (command === 'install') return install(args);
  if (command === 'run') return run();
  process.stdout.write('Usage:\n  npx -y @melson/sdlc-mcp install [--server https://example.com]\n  sdlc-mcp run\n');
}

main().catch((cause) => {
  process.stderr.write(`${cause instanceof Error ? cause.message : 'SDLC MCP failed'}\n`);
  process.exitCode = 1;
});
