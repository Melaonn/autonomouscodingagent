# Using the harness from Codex

Start the service with `start.ps1`, connect GitHub and a repository in the dashboard, then run `connect-codex.ps1` once. Restart Codex so it loads the local `sdlc` server.

Open your existing checkout in the Codex app or CLI and enter native Plan mode. Give Codex the same high-level request you normally would. During planning, Codex calls `sdlc_start` once. That call records the starting Git tree and returns repository policy plus a bounded set of company-document excerpts selected by PostgreSQL full-text ranking. Codex continues the normal Plan mode question flow with that context.

After you accept the plan, Codex edits the same checkout. Focused tests are allowed while coding. Codex does not rerun the repository's entire quality suite because one `sdlc_verify` call performs the configured setup, build, lint, type, unit, integration, E2E, secret, static-analysis, and dependency gates. Independent checks run concurrently where safe. When repository policy requires it, source changes must include a changed test path before verification can pass. Failed gates return bounded diagnostics to the same conversation; passing output remains in evidence artifacts rather than consuming model context.

Verification evaluates the repository's review policy. An administrator can require review for every change or use an explicit risk policy based on the declared change risk, configured sensitive path globs, changed-file count, and acceptance criteria that require review evidence. The controller does not guess risk from prompt keywords. When review is required, type `/review` and choose **Review uncommitted changes**, then return to implementation so Codex can record the findings. Low-risk changes skip this extra model turn when policy permits.

A normal delivery uses `sdlc_start`, `sdlc_verify`, and `sdlc_publish`. Required review adds `sdlc_review`. Failed checks repeat only verification. GitHub CI, deployment, rollback, and health monitoring continue in the control plane without consuming Codex turns. Deployment approval remains a human action in the dashboard.

The MCP bridge cannot switch Codex modes or invoke slash commands. It does not clone the repository, launch a hidden coding agent, expose credentials, or approve deployment.
