# Native Codex SDLC Control Plane

This project adds an evidence-based software development lifecycle around the Codex app or CLI that a developer already uses. Codex remains visible in one conversation and edits the existing local checkout. The control plane records requirements and design, runs repository-defined checks, sends failures back to the same conversation, follows GitHub CI, and stops for explicit deployment approval.

There is no Docker worker, second Codex login, repository clone, or hidden coding session.

## Quick start on Windows

Requirements: Node.js 24+, Git, the Codex desktop app or CLI, and a GitHub token with access to the repository you want to test.

1. Start the dashboard and API in PowerShell:

   ```powershell
   .\start.ps1
   ```

   The first run creates `.env`, installs dependencies, builds the app, opens `http://localhost:4310`, and prints the local administrator password. Keep this terminal open.

2. Sign in to the dashboard, connect the GitHub token, and add the repository. Review its commands, company standards, required GitHub checks, and optional deployment workflow.

3. Connect the harness to your existing Codex app and CLI configuration:

   ```powershell
   .\connect-codex.ps1
   ```

   This writes one managed instruction block under your Codex home directory. It does not change the project checkout.

4. Restart the Codex app or open a fresh Codex CLI session in your project. Work as usual:

   > Build an audit history page with filtering and pagination.

Codex now uses the `sdlc` MCP tools from the same conversation. Open the dashboard to see phases, progress, quality gates, evidence, PR and CI status, and deployment approval.

## What happens after the prompt

1. **Planning:** Codex inspects the current checkout and records scope, implementation steps, dependencies, effort, schedule, and risks.
2. **Requirements:** it creates measurable acceptance criteria and maps testable criteria to configured checks. A real product ambiguity pauses for the user.
3. **Design:** it records architecture, interfaces, data and UI changes, security decisions, compatibility, and test strategy.
4. **Coding:** the same Codex conversation edits the developer's existing checkout, including intentional local work already present.
5. **Testing:** the MCP bridge runs every configured command locally. Build, lint, types, unit, integration, E2E, and security results are bound to the exact Git tree digest. Failures return the lifecycle to repair.
6. **Review:** after checks pass, Codex reviews the diff and cites evidence for every acceptance criterion. Critical or high findings return to repair.
7. **Delivery:** Codex commits and pushes the verified tree on a feature branch. The control plane creates or updates a pull request and waits for required GitHub checks.
8. **Deployment and maintenance:** the dashboard asks a human to approve the exact commit and environment. It can dispatch deployment, verify health, roll back a failed release, and monitor the result.

The agent cannot mark a run complete through prose. Completion comes from recorded checkpoints, matching policy versions and Git tree digests, passing checks, acceptance evidence, and required CI.

## Company integration

Repository policies define the commands and release rules that apply every time. Versioned company documents can hold architecture decisions, coding rules, domain constraints, security policies, test conventions, and incident lessons. Administrator-owned MCP integrations can retrieve selected internal context through allowlisted tools. Each run stores the exact policy and context hashes it used.

This is more useful than pasting a policy into one prompt: the harness selects and versions context, applies mandatory commands after implementation, prevents skipped gates, records evidence, and enforces deployment approval consistently.

## Development

```powershell
npm install
npm run dev
npm run check
```

The main components are:

- `apps/server/src/chat-mcp.ts`: tools exposed to the current Codex conversation.
- `apps/server/src/workspace.ts`: safe local Git inspection and configured command execution.
- `apps/server/src/run-service.ts`: durable lifecycle and delivery state machine.
- `apps/server/src/gates.ts`: evidence evaluation and completion rules.
- `apps/server/src/github.ts`: pull requests, CI, deployment, rollback, and health workflow support.
- `apps/web/src/main.tsx`: setup and live execution dashboard.
- `shared/types.ts`: validated lifecycle contracts.

See [HOW-IT-WORKS.md](HOW-IT-WORKS.md) for the architecture and [docs/codex-chat.md](docs/codex-chat.md) for usage details.
