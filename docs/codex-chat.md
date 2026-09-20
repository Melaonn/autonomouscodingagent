# Using the harness from Codex

Start the local service with `start.ps1`, connect GitHub and a repository in the dashboard, then register the MCP bridge and user-level Codex instructions once:

```powershell
.\connect-codex.ps1
```

The connector updates `~/.codex/config.toml` and a managed block in `~/.codex/AGENTS.md`; it does not edit the project. Restart the Codex app or open a fresh CLI session so it loads the `sdlc` tools. Open the existing project and give a normal request. You do not need to copy policies into the prompt or start work from the dashboard.

Start the task with native Plan mode enabled. Codex inspects the checkout and asks its normal questions there. When the plan is correct, choose to implement it. The same conversation calls `sdlc_begin` once to record the plan and receive company context, then `sdlc_spec` once for requirements and design. It uses the same files and local changes you see. Verification progress is recorded automatically in the dashboard at `http://localhost:4310`, which remains the observer and approval surface.

After every configured local gate passes, the run enters **Native review required**. Type `/review` in the same Codex project and choose **Review uncommitted changes**. By default the dedicated reviewer reports in the current chat without modifying the checkout. Return to the implementation turn after the findings appear so the harness can record them, repair blocking findings, and continue.

The MCP bridge cannot turn Plan mode on or invoke `/review`; both are native Codex UI or CLI actions. It also never launches a second Codex process to imitate them.

A normal delivery uses five control-plane calls: `sdlc_begin`, `sdlc_spec`, `sdlc_verify`, `sdlc_review`, and `sdlc_publish`. Failed checks repeat only verification. The server follows GitHub CI automatically, and Codex reads status only when recovering an interrupted task or when you ask for it.

When local checks and review pass, Codex creates a feature branch, commits the verified tree, and pushes it. The control plane follows the pull request and required CI. If a deployment is configured, approve or reject it in the dashboard. Codex cannot approve its own deployment.

Keep `start.ps1` running while using the MCP tools. If the Codex task closes during implementation, reopen the project, ask Codex to resume the SDLC run, and it can find the existing run with `sdlc_runs`. Remote CI, approved deployments, and health monitoring continue in the control plane without an active model conversation.
