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

After local gates pass, the controller applies the repository's explicit review policy. High-risk, broad, or sensitive-path changes ask you to type `/review` and choose **Review uncommitted changes**. Low-risk changes skip that extra model turn when policy permits.

Plan mode selection and `/review` are native Codex client actions. The harness cannot switch modes or enter slash commands on your behalf. They keep planning questions and review output visible in the existing Codex task rather than launching a hidden agent.

The agent-facing path exposes five tools. A normal low-risk delivery uses three calls: start during planning, verify after implementation, and publish. A required native review adds one call. The controller records the accepted specification during the first verification, follows progress and CI itself, and keeps successful command output out of the model context.

## What happens after the prompt

1. **Planning:** native Codex Plan mode inspects the checkout and calls `sdlc_start` once. The controller returns bounded company context selected from indexed document chunks. Codex asks normal clarification questions and produces the plan.
2. **Requirements:** Codex creates measurable acceptance criteria and maps testable criteria to configured checks after product questions are resolved in Plan mode.
3. **Design:** the first `sdlc_verify` call records the accepted plan, requirements, technical design, and declared change risk as one specification checkpoint.
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

The first real five-task run is published as [an inconclusive pilot](evals/results/pilot-2026-09-20.md). It found that native review caught a duplicate-ID defect missed by configured gates, while the full harness tied baseline quality and consumed more measured time and tokens. The project therefore makes no performance-benefit claim yet.

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
