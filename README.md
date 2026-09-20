# Native Codex SDLC Control Plane

This project adds an evidence-based software development lifecycle around the Codex app or CLI that a developer already uses. Codex remains visible in one conversation and edits the existing local checkout. The control plane records requirements and design, runs repository-defined checks, sends failures back to the same conversation, follows GitHub CI, and stops for explicit deployment approval.

There is no Docker worker, second Codex login, repository clone, or hidden coding session.

## Quick start on Windows

Requirements: Node.js 24+, Git, the Codex desktop app or CLI, and a GitHub account.

### Application-owner authentication setup

Developers using the harness do not register an OAuth application. The company operating the control plane registers one GitHub OAuth client for the whole installation, just as it would configure GitHub in Firebase, Auth0, or another identity provider. Its client secret belongs in the server environment and is never committed to this public repository.

For this local self-hosted demo, the application owner configures `.env` once with a GitHub OAuth App whose homepage is `http://localhost:4310` and whose callback is `http://localhost:4310/auth/github/callback`:

```dotenv
GITHUB_CLIENT_ID=application_client_id
GITHUB_CLIENT_SECRET=application_client_secret
GITHUB_ALLOWED_USERS=comma_separated_github_logins
GITHUB_ADMIN_USERS=comma_separated_admin_logins
```

In a deployed company instance, ActTrident would configure these values in its secret manager. Every developer would then see only the normal **Continue with GitHub** login. Login verifies identity only and does not request repository, organization, or workflow access.

1. Start the dashboard and API in PowerShell:

   ```powershell
   .\start.ps1
   ```

   The script creates local machine secrets, installs dependencies, builds the app, and opens `http://localhost:4310`. It never opens GitHub developer settings or asks an end user for OAuth application credentials. Keep this terminal open.

2. Select **Continue with GitHub**. GitHub's consent page only identifies the dashboard user. Repository inspection, edits, tests, commits, and pushes use the existing local checkout and Git configuration. Optional pull-request, CI, and deployment API calls reuse the developer's existing Git Credential Manager session; the browser login token is discarded after identity is established.

3. Connect the harness to your existing Codex app and CLI configuration from another PowerShell window:

   ```powershell
   .\connect-codex.ps1
   ```

   This writes one managed instruction block under your Codex home directory. It does not change the project checkout.

4. Restart the Codex app or open a fresh Codex CLI session in your project. Turn on **Plan mode**, then give the high-level request:

   > Build an audit history page with filtering and pagination.

On the first prompt for a repository, Codex detects the Git remote, base branch, TypeScript or Python stack, package manager, scripts, test layout, GitHub workflows, source/test paths, and deployment clues. The dashboard shows each capability as ready, partial, missing, or needing input. Codex asks whether E2E applies, how remote CI should work, and—only when requested—where deployment runs and which health URL proves success.

After confirmation, the same Codex conversation receives a detailed bootstrap contract. It preserves working infrastructure and creates only the gaps: reproducible dependencies, build/lint/type commands, isolated unit/integration/E2E suites with meaningful tests, GitHub Actions CI, and optional target-specific deployment, rollback, and health-check integration. These are ordinary reviewed repository changes, not generated placeholders. Verification runs every resulting command and keeps the repository in `bootstrapping` state until the evidence passes. Later prompts reuse the verified versioned policy and skip this setup cost.

Codex then uses native Plan mode to inspect the repository and ask its normal clarification questions. Choose to implement when the plan is correct. The same conversation uses the `sdlc` MCP tools and existing checkout. Open the dashboard to see what is happening, what comes next, quality evidence, failures, PR and CI status, and any action that needs you.

After local gates pass, the controller applies the repository's explicit review policy. High-risk, broad, or sensitive-path changes ask you to type `/review` and choose **Review uncommitted changes**. Low-risk changes skip that extra model turn when policy permits.

Plan mode selection and `/review` are native Codex client actions. The harness cannot switch modes or enter slash commands on your behalf. They keep planning questions and review output visible in the existing Codex task rather than launching a hidden agent.

The agent-facing path exposes five tools. A normal low-risk delivery uses three calls: start during planning, verify after implementation, and publish. A required native review adds one call. The first verification sends only a compact lifecycle checkpoint instead of repeating the full Plan-mode conversation. The controller expands and records the SDLC evidence, follows progress and CI itself, and keeps successful command output out of the model context.

## What happens after the prompt

1. **Planning:** native Codex Plan mode calls `sdlc_start` first. A new repository is inventoried and saved for one-time confirmation. The confirmed call returns an executable bootstrap contract, which Codex includes in the native plan with the requested feature. A ready repository immediately returns its bounded company context and skips bootstrap.
2. **Requirements:** Codex creates measurable acceptance criteria and maps testable criteria to configured checks after product questions are resolved in Plan mode.
3. **Design:** the first `sdlc_verify` call records a compact plan, requirements, design, test-strategy, and change-risk checkpoint, which the controller expands into the lifecycle record.
4. **Coding:** the same Codex conversation edits the developer's existing checkout, including intentional local work already present.
5. **Testing:** `sdlc_verify` runs configured commands locally, reports progress, and binds evidence to the exact Git tree. Independent checks run with bounded concurrency. A configurable changed-test policy prevents source changes from passing only because old tests stayed green. Codex receives detailed output only for failures, so it can repair without paying to reread successful logs.
6. **Review:** declarative repository policy decides whether native `/review` is required using risk level, sensitive path globs, change breadth, and evidence requirements. Critical or high findings return to repair.
7. **Delivery:** Codex commits and pushes the verified tree on a feature branch. The control plane creates or updates a pull request and waits for required GitHub checks.
8. **Deployment and maintenance:** the dashboard asks a human to approve the exact commit and environment. It can dispatch deployment, verify health, roll back a failed release, and monitor the result.

Explicit validation-only runs created through the dashboard or API stop successfully after verification and review when the workspace is unchanged. Codex chat starts delivery runs, avoiding accidental validation mode during feature work. Validation runs do not create a branch, pull request, or deployment.

The agent cannot mark a run complete through prose. Completion comes from recorded checkpoints, matching policy versions and Git tree digests, passing checks, acceptance evidence, and required CI.

## Company integration

Repository policies define commands, source/test path globs, review rules, and release rules. Versioned company documents are split into bounded chunks and ranked with PostgreSQL full-text search. Administrator-owned MCP integrations can retrieve context through allowlisted tools. Each run stores the exact policy and context hashes it used.

This is more useful than pasting a policy into one prompt: the harness selects and versions context, applies mandatory commands after implementation, prevents skipped gates, records evidence, and enforces deployment approval consistently.

## Proving the benefit

The repository includes a paired evaluator; the existence of the MCP is not treated as evidence that it helps. Run the same real task from the same commit with the same Codex model and reasoning effort twice: once with a manual SDLC prompt and once with the harness. Hidden acceptance, regression, and security commands then score both finished checkouts, while Codex JSONL supplies exact token usage.

```powershell
npm run evaluate -- --input evals/experiment.json --out evals/results/company-pilot
```

The evaluator reports paired quality confidence, critical regressions, total and uncached token ratios, interventions, repairs, and fairness failures. It returns a positive verdict only for statistically supported quality improvement, or for non-inferior quality with the configured token reduction. See [evals/README.md](evals/README.md) for the protocol. Until representative paired trials pass that policy, performance improvement remains unproven.

The first real five-task run is published as [an inconclusive pilot](evals/results/pilot-2026-09-20.md). An [optimized follow-up](evals/results/optimized-pilot-2026-09-20.md) kept the 5/5 quality tie while reducing harness overhead from 1.44× to 1.14× measured tokens and from 1.78× to 1.21× wall time. It also demonstrated one automatic compile-defect repair. The project still makes no performance-benefit claim because final quality did not improve and cost remained higher than the baseline.

## Development

```powershell
npm install
npm run dev
npm run check
```

The main components are:

- `apps/server/src/chat-mcp.ts`: tools exposed to the current Codex conversation.
- `apps/server/src/repository-discovery.ts`: safe first-run stack, command, test, CI, and deployment discovery.
- `apps/server/src/workspace.ts`: safe local Git inspection and configured command execution.
- `apps/server/src/run-service.ts`: durable lifecycle and delivery state machine.
- `apps/server/src/gates.ts`: evidence evaluation and completion rules.
- `apps/server/src/github.ts`: pull requests, CI, deployment, rollback, and health workflow support.
- `apps/web/src/main.tsx`: setup and live execution dashboard.
- `shared/types.ts`: validated lifecycle contracts.

See [HOW-IT-WORKS.md](HOW-IT-WORKS.md) for the architecture and [docs/codex-chat.md](docs/codex-chat.md) for usage details.
