# Native Codex SDLC Control Plane

This project adds an evidence-based software development lifecycle around the Codex app or CLI that a developer already uses. Codex remains visible in one conversation and edits the existing local checkout. The control plane records requirements and design, runs repository-defined checks, sends failures back to the same conversation, follows GitHub CI, and stops for explicit deployment approval.

There is no Docker worker, second Codex login, repository clone, or hidden coding session.

## Quick start on Windows

Requirements: Node.js 24+, Git, the Codex desktop app or CLI, and a GitHub token with access to the repository you want to test.

1. Start the dashboard and API in PowerShell:

   ```powershell
   .\start.ps1
   ```

   The first run creates `.env`, installs dependencies, builds the app, and opens `http://localhost:4310`. Local access signs in automatically because the server listens only on your computer. Keep this terminal open.

2. In the dashboard, connect the GitHub token and add the repository. Review its commands, company standards, required GitHub checks, and optional deployment workflow.

3. Connect the harness to your existing Codex app and CLI configuration:

   ```powershell
   .\connect-codex.ps1
   ```

   This writes one managed instruction block under your Codex home directory. It does not change the project checkout.

4. Restart the Codex app or open a fresh Codex CLI session in your project. Turn on **Plan mode**, then give the high-level request:

   > Build an audit history page with filtering and pagination.

Codex uses native Plan mode to inspect the repository and ask its normal clarification questions. Choose to implement when the plan is correct. The same conversation then uses the `sdlc` MCP tools and existing checkout. Open the dashboard to see what is happening, what comes next, quality evidence, failures, PR and CI status, and any action that needs you.

After local gates pass, Codex and the dashboard ask you to type `/review` and choose **Review uncommitted changes**. Codex's dedicated reviewer reports prioritized findings without changing the working tree. The control plane records those results, returns blocking findings to implementation, and proceeds only when the verified candidate and acceptance evidence pass.

Plan mode selection and `/review` are native Codex client actions. The harness cannot switch modes or enter slash commands on your behalf. They keep planning questions and review output visible in the existing Codex task rather than launching a hidden agent.

## What happens after the prompt

1. **Planning:** native Codex Plan mode inspects the current checkout, asks the developer any necessary questions, and produces the plan. After the developer accepts it, the harness records that approved plan with its native provenance.
2. **Requirements:** it creates measurable acceptance criteria and maps testable criteria to configured checks. A real product ambiguity pauses for the user.
3. **Design:** it records architecture, interfaces, data and UI changes, security decisions, compatibility, and test strategy.
4. **Coding:** the same Codex conversation edits the developer's existing checkout, including intentional local work already present.
5. **Testing:** the MCP bridge reports per-gate progress in Codex and the dashboard while running configured commands locally. Build, lint, types, unit, isolated E2E, secret scanning, static security, and dependency results are bound to the exact Git tree digest. Unchanged dependency manifests reuse the verified installation, and independent checks run with bounded concurrency. Failures return the lifecycle to repair.
6. **Review:** after checks pass, the run waits for native Codex `/review` of the uncommitted changes. Its dedicated findings and acceptance evidence are recorded. Critical or high findings return to repair and require verification and review again.
7. **Delivery:** Codex commits and pushes the verified tree on a feature branch. The control plane creates or updates a pull request and waits for required GitHub checks.
8. **Deployment and maintenance:** the dashboard asks a human to approve the exact commit and environment. It can dispatch deployment, verify health, roll back a failed release, and monitor the result.

Explicit validation-only runs stop successfully after verification and review when the workspace is unchanged. They do not create a branch, pull request, or deployment.

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
