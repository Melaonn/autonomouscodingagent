# SDLC Control Plane

A local control plane for governed software work with Codex. Start a feature or bug request from the Codex app, Windows CLI, or dashboard. A background Codex CLI worker implements the change; the controller runs quality gates, requests repairs, records evidence, and pauses before deployment.

## Start locally on Windows

Requirements: Docker Desktop with the Linux engine. For chat integration, also install Node.js 24+, npm, Git, and Codex CLI.

```powershell
powershell -ExecutionPolicy Bypass -File .\start.ps1
```

The script builds the application and worker images, starts PostgreSQL and the services, and opens `http://localhost:4310`. On first launch it prints an administrator password. Sign in, connect Codex through device login, connect GitHub, and select a repository. **Analyze with Codex** can suggest repository settings; review them before saving.

To connect a normal Codex conversation:

```powershell
npm ci
.\connect-codex.ps1 -EnvironmentFile '.env.compose' -ProjectPath 'C:\path\to\project'
```

Restart Codex or open a fresh CLI session in that project, then say:

> Add task priority support using the SDLC workflow.

The installer registers the local `sdlc` MCP server and appends routing instructions to the project's `AGENTS.md`. The conversation starts and follows a run; the background worker owns implementation. It starts from the configured remote branch and does not include uncommitted local changes. Keep Docker and the harness services running.

See [chat setup and troubleshooting](docs/codex-chat.md) for source-development setup, available tools, and limitations.

## What a run does

| Phase | Evidence and behavior |
| --- | --- |
| Planning | Repository baseline, scope, steps, dependencies, effort, and risk assumptions |
| Requirements | Measurable acceptance criteria and clarification when needed |
| Design | Architecture, API/data changes, compatibility, and independently generated acceptance tests |
| Coding | Codex implementation in an isolated repository volume |
| Testing | Build, lint, types, tests, scanners, acceptance checks, independent review, and a bounded repair loop |
| Deployment | PR, required GitHub CI, explicit candidate approval, workflow dispatch, health check, and rollback dispatch on failure |
| Maintenance | Periodic health checks and incident runs after repeated failures |

The standard TypeScript profile contains ten gates: install, build, lint, types, unit, integration, E2E, dependency audit, Semgrep, and Gitleaks. The Python profile differs and needs project-specific E2E checks. A scanner error is not a pass. The bundled Semgrep rules are a small starting set, not a comprehensive company security policy.

`awaiting_approval`, `needs_input`, `failed`, and `blocked` are not successful completion. `monitoring` means the configured release checks passed and maintenance monitoring is active; it does not guarantee defect-free software.

## Repository and company configuration

Configure exact CI check names or an explicit waiver, commands and report formats, protected paths, company standards, deployment and rollback workflows, and a health URL. Workflows accept `sdlc_run_id`, `candidate_sha`, and `environment` through `workflow_dispatch`.

Approved company documents are versioned and retrieved for each task. Allowlisted external MCP tools can supply company context. Runs record source versions and hashes. Context guides the model; executable gates enforce the configured completion policy.

The public [demo repository](https://github.com/Melaonn/sdlc-harness-demo) provides a small TypeScript task API and simulated release workflows. Those workflows do not deploy an application. Its repository-availability health URL is not an application health check.

## Development and verification

```powershell
npm ci
Copy-Item .env.example .env
# Set unique local login, session, and runner secrets in .env, then:
docker build -t sdlc-worker:local -f docker/worker/Dockerfile .
npm run runner
# In another terminal:
npm run dev
```

Development uses `http://127.0.0.1:5173` and the API at port 4310. Register chat with `./connect-codex.ps1 -EnvironmentFile '.env' -ProjectPath 'C:\path\to\project'`. Do not run Compose and development servers on the same ports.

Run `npm run format` after editing. `npm run check` enforces formatting, type checking, lint, tests, and the production build. Dashboard E2E tests run separately with `npm run test:e2e` against a fresh development instance.

## Documentation

- [Codex chat integration](docs/codex-chat.md): installation, usage, tools, and troubleshooting.
- [End-to-end architecture](HOW-IT-WORKS.md): components, state transitions, gates, and security boundaries.
- [Project instruction template](docs/codex-project-instructions.md): the routing block installed in target repositories.

Local environment files, credentials, runtime data, reports, and editor metadata are excluded from Git. No cloud deployment is required for local use. Optional Linux hosting scripts remain under `deploy/`; production hardening and live release validation are separate work.
