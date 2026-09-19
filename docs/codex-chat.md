# Using the harness from Codex

Start the local service with `start.ps1`, connect GitHub and a repository in the dashboard, then register the MCP bridge and user-level Codex instructions once:

```powershell
.\connect-codex.ps1
```

The connector updates `~/.codex/config.toml` and a managed block in `~/.codex/AGENTS.md`; it does not edit the project. Restart the Codex app or open a fresh CLI session so it loads the `sdlc` tools. Open the existing project and give a normal request. You do not need to copy policies into the prompt or start work from the dashboard.

The current conversation will inspect the checkout, start a governed run, and move through planning, requirements, design, implementation, verification, repair, and self-review. It will use the same files and local changes you see. The dashboard at `http://localhost:4310` is an observer and approval surface.

When local checks and review pass, Codex creates a feature branch, commits the verified tree, and pushes it. The control plane follows the pull request and required CI. If a deployment is configured, approve or reject it in the dashboard. Codex cannot approve its own deployment.

Keep `start.ps1` running while using the MCP tools. If the Codex task closes during implementation, reopen the project, ask Codex to resume the SDLC run, and it can find the existing run with `sdlc_runs`. Remote CI, approved deployments, and health monitoring continue in the control plane without an active model conversation.
