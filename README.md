# SDLC Control Plane

This repository contains a self-hosted control plane that drives Codex or Claude Code through all seven SDLC phases. The coding agent produces candidates. The controller decides whether evidence is sufficient to continue.

## Lifecycle

1. **Planning** records scope, dependencies, effort, cost assumptions, schedule, and risks.
2. **Requirements** creates measurable functional and non-functional acceptance criteria and pauses for consequential stakeholder decisions.
3. **Design** records architecture, API/data/UI effects, compatibility, security boundaries, and independent acceptance tests.
4. **Coding** gives the immutable contract and design to the selected worker in an isolated repository volume.
5. **Testing** runs configured build, lint, types, unit, integration, E2E, dependency, SAST, secret, protected acceptance, and independent review gates. Failures enter a bounded repair loop.
6. **Deployment** creates a draft PR, waits for required GitHub checks, marks the PR ready, then requests approval for an exact candidate/environment/workflow digest. An approved GitHub deployment workflow runs, followed by a health check and automatic rollback dispatch on failure.
7. **Maintenance** monitors the approved environment. Two consecutive health failures create an incident run that goes through the same lifecycle. Any resulting release still requires deployment approval.

The terminal success condition is `monitoring`: all seven phases have been entered and the release is under maintenance. `blocked`, `failed`, `cancelled`, `needs_input`, and `awaiting_approval` are explicit non-success states.

## Local development

Requirements are Node.js 24, Docker Desktop with the Linux engine, Codex CLI authentication, Claude Code authentication, and a controlled GitHub test repository.

1. Copy `.env.example` to `.env` and replace all placeholder secrets.
2. Set `GITHUB_TOKEN` to a fine-grained token for the controlled repository, or configure a GitHub App.
3. Set `CODEX_AUTH_DIR` and `CLAUDE_AUTH_DIR` to **absolute host paths** for dedicated worker profiles. Do not use personal home directories. Local runner mode mounts these paths only into agent containers.
4. Build the worker image: `docker build -f docker/worker/Dockerfile -t sdlc-worker:local .`
5. Start the isolated runner: `npm run runner`.
6. Start the application: `npm run dev` and open `http://localhost:5173`.

Without Docker or credentials the dashboard remains available, while readiness and new runs fail closed.

## Compose deployment

Set `SESSION_SECRET`, `RUNNER_TOKEN`, `POSTGRES_PASSWORD`, `PUBLIC_URL`, and GitHub configuration. Compose uses the exact Docker volume names `sdlc-codex-auth` and `sdlc-claude-auth`; seed them through interactive worker containers with `codex login` and `claude auth`. Then run `docker compose up --build`. The app is served on port 4310. The runner alone receives the Docker socket. Agent and verification containers do not receive the control-plane database, GitHub deployment credentials, or Docker socket.

The deployment workflow must accept `workflow_dispatch` inputs named `sdlc_run_id`, `candidate_sha`, and `environment`. The rollback workflow must accept the same inputs. Store environment credentials in GitHub Environments and enforce any additional environment reviewers there.

## Repository onboarding

The TypeScript and Python profiles are strict starting points. Onboarding must name all required remote CI checks, or record an explicit waiver. It must also configure an HTTPS health endpoint and deployment/rollback workflows to complete all seven phases.

Quality command arguments are stored as arrays and executed without an application shell. Setup may access the network; all verification commands run without network. Independent acceptance files are mounted read-only outside the candidate workspace. Missing or malformed reports, zero required tests, timeouts, scanner errors, stale evidence, protected path edits, and high/critical review findings prevent completion.

## Company integration

Administrators can version approved Markdown/text sources and configure allowlisted Streamable HTTP MCP servers. MCP context calls use administrator-owned argument templates with `{{prompt}}` and `{{repo}}` substitutions; a configured call that fails blocks discovery. Each run records the source versions and content hashes included in its context. Retrieved text supplies evidence; it cannot grant tool authority or change mandatory policy.

## Validation

Run `npm run check`. Core tests cover stale-evidence rejection, missing and zero-test reports, deployment approval invalidation, active-run exclusion, worker lease fencing, and company-knowledge retrieval. A release also requires live runs through both agent adapters, a TypeScript and Python reference repository, GitHub PR/Actions, an approved deployment, a failed-health rollback exercise, and crash recovery.

## Security boundary

This first release targets a trusted single engineering team running authorized repositories. The runner is a privileged infrastructure component because it owns the Docker socket. Deploy it on a dedicated host, restrict host access, use dedicated agent credentials, and keep the control plane and runner token on a private network. Candidate code remains untrusted.

Network egress from agent/setup containers currently uses the Docker bridge network. Domain-level egress allowlisting requires an organization proxy and should be added before processing sensitive private repositories. This limitation is visible and must not be described as a completed enterprise security control.
