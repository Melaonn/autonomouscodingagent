import { createServer } from 'node:http';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { platform, tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';

const execute = promisify(execFile);
const servers: ReturnType<typeof createServer>[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
});

describe('one-command MCP installer', () => {
  it('pairs, stores a device credential, installs instructions, and registers Codex', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sdlc-installer-'));
    const bin = join(root, 'bin');
    const codexHome = join(root, 'codex');
    const credentialFile = join(root, 'credentials.json');
    const commandLog = join(root, 'codex-commands.txt');
    await mkdir(bin, { recursive: true });
    if (platform() === 'win32') {
      await writeFile(join(bin, 'codex.cmd'), `@echo off\necho %*>>"${commandLog}"\nexit /b 0\n`);
    } else {
      await writeFile(
        join(bin, 'codex'),
        `#!/usr/bin/env node\nconst { appendFileSync } = require('node:fs');\nappendFileSync(${JSON.stringify(commandLog)}, process.argv.slice(2).map((argument) => JSON.stringify(argument)).join(' ') + '\\n');\n`,
        { mode: 0o755 },
      );
    }

    const accessToken = `sdlc_${'a'.repeat(64)}`;
    const server = createServer((request, response) => {
      response.setHeader('content-type', 'application/json');
      if (request.url === '/api/pairing/start') {
        response.statusCode = 201;
        response.end(
          JSON.stringify({
            deviceCode: 'b'.repeat(64),
            userCode: 'ABCD-EF12-3456',
            verificationUri: 'https://example.test/?pair=ABCD-EF12-3456',
            expiresIn: 30,
            interval: 0,
          }),
        );
        return;
      }
      response.end(JSON.stringify({ status: 'approved', accessToken, user: { login: 'interviewer' } }));
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Test server did not bind');

    const tsx = join(process.cwd(), 'node_modules', 'tsx', 'dist', 'cli.mjs');
    const cli = join(process.cwd(), 'packages', 'sdlc-mcp', 'src', 'cli.ts');
    const result = await execute(
      process.execPath,
      [tsx, cli, 'install', '--server', `http://127.0.0.1:${address.port}`],
      {
        env: {
          ...process.env,
          PATH: `${bin}${delimiter}${process.env.PATH || ''}`,
          CODEX_HOME: codexHome,
          SDLC_MCP_CREDENTIAL_FILE: credentialFile,
          SDLC_MCP_SKIP_BROWSER: 'true',
        },
        timeout: 20_000,
      },
    );

    expect(result.stdout).toContain('Connected Codex as @interviewer');
    expect(result.stdout).not.toContain(accessToken);
    expect(JSON.parse(await readFile(credentialFile, 'utf8'))).toMatchObject({
      serverUrl: `http://127.0.0.1:${address.port}`,
      accessToken,
      login: 'interviewer',
    });
    expect(await readFile(join(codexHome, 'AGENTS.md'), 'utf8')).toContain('Governed SDLC workflow');
    const commands = await readFile(commandLog, 'utf8');
    expect(commands).toContain('"mcp" "remove" "sdlc"');
    const npxCommand = platform() === 'win32' ? 'npx.cmd' : 'npx';
    expect(commands).toContain(`"mcp" "add" "sdlc" "--" "${npxCommand}" "-y" "@melson/sdlc-mcp@0.1.2" "run"`);
  });
});
