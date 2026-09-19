# Work from Codex on Windows

The `sdlc` MCP server lets the Codex app and CLI control the existing local harness from a conversation. The chat submits a task; a separate background Codex CLI worker implements and repairs it. Quality gates remain in the control plane. The chat session itself does not edit the governed candidate.

## One-time connection

Keep the harness API and runner running, with Codex and GitHub connected and a repository onboarded. From PowerShell in the harness folder:

```powershell
.\connect-codex.ps1 -ProjectPath 'C:\path\to\your\project'
```

This builds the bridge, registers an `sdlc` stdio MCP server with `codex mcp add`, and appends workflow instructions to the target project's `AGENTS.md` without replacing existing content. Re-running it does not duplicate the instructions. It does not start a paid agent run or deploy anything. The project must match an onboarded GitHub repository.

For the Docker Compose installation started by `start.ps1`, select its credentials instead:

```powershell
.\connect-codex.ps1 -EnvironmentFile '.env.compose' -ProjectPath 'C:\path\to\your\project'
```

Restart Codex or open a fresh CLI session in the project. The MCP command uses absolute paths, including the Node executable, so it can launch from any working directory. The local environment file is read by the bridge; passwords are not embedded in Codex configuration or returned to the conversation. Only numeric loopback HTTP addresses are accepted and redirects are rejected.

## Use it

Say: **Add priority support to tasks using the SDLC workflow.**

Codex identifies the repository, starts a run, and follows its progress. Planning, requirements, design, coding, tests, security scanning, repair and review happen in the existing background engine. You can ask for status or evidence in the same conversation. After reopening Codex, ask it to find your latest run with `sdlc_runs`.

The worker starts from the configured remote branch, not your local uncommitted changes. Keep the API, runner, and Docker running. Closing the conversation does not cancel an accepted task; shutting down the services pauses progress. A chat cannot automatically wake itself after it closes.

Available tools: `sdlc_repositories`, `sdlc_start`, `sdlc_runs`, `sdlc_status`, `sdlc_answer`, `sdlc_cancel`, `sdlc_resume`, and `sdlc_report`. There is intentionally no deployment approval, policy-editing, or arbitrary command tool. Human deployment approval stays in the dashboard.

## Boundaries and troubleshooting

- Repository instructions route feature requests through the tools; they cannot intercept every prompt or prevent a user from making local edits. Only registered runs have governed evidence.
- If the server is unavailable, start the existing local harness. If login fails, check that the installer selected the environment file used by that API process.
- On a timeout starting a run, inspect `sdlc_runs` before retrying. Active runs with the same repository and exact prompt are reused; the API rejects competing active runs.
- The stdio bridge runs with the local user's filesystem access. This is a single-user local integration, not a multi-tenant credential boundary.
- To disconnect: `codex mcp remove sdlc`. Remove the marked SDLC block from the target `AGENTS.md` if you also want to stop automatic routing.

Codex MCP configuration reference: https://developers.openai.com/codex/mcp/
