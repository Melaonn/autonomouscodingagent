# `@melson/sdlc-mcp`

Connect the Codex app or CLI to an evidence-based SDLC control plane with one command.

```powershell
npx -y @melson/sdlc-mcp install
```

Requirements: Node.js 20+, Git, Codex desktop or CLI, and a GitHub account.

## What the installer does

1. Opens a short-lived pairing page on the hosted SDLC dashboard.
2. Uses GitHub to verify the developer's identity without requesting repository scopes.
3. Stores a device-specific credential in the user's local profile.
4. Registers an `sdlc` MCP server through `codex mcp add`.
5. Installs the governed workflow instructions in the Codex home directory.

The credential belongs only to that device and GitHub identity. Developers do not clone the control-plane repository, create an `.env` file, generate a personal access token, or receive a shared administrator secret.

## Use it

After installation:

1. Restart Codex.
2. Open an existing Git checkout in Codex desktop or CLI.
3. Enter native **Plan mode**.
4. Describe the feature or bug normally.

On first use, Codex inventories the repository and asks about uncertain E2E, CI, and optional deployment choices. It includes missing SDLC foundations in the native plan. After the plan is accepted, the same conversation implements the change and the control plane runs the configured verification loop.

The dashboard at [sdlc-control-plane.onrender.com](https://sdlc-control-plane.onrender.com/) shows only the repositories and runs associated with the signed-in GitHub user. It displays lifecycle progress, acceptance criteria, gate evidence, failures, review state, artifacts, pull requests, CI, and deployment approval.

## Tools exposed to Codex

| Tool           | Purpose                                                                                |
| -------------- | -------------------------------------------------------------------------------------- |
| `sdlc_start`   | Register the request, inspect first-run SDLC capabilities, and start a governed run.   |
| `sdlc_verify`  | Record the lifecycle checkpoint, run configured gates, and return actionable failures. |
| `sdlc_review`  | Record native Codex review findings when repository policy requires review.            |
| `sdlc_publish` | Bind publication to the exact verified Git tree and follow required CI.                |
| `sdlc_status`  | Recover or inspect an existing run without restarting it.                              |

A normal ready-repository delivery uses `start`, `verify`, and `publish`. Failed checks repeat only `verify`; policy-required review adds `review`.

## Developer environment

The connector uses the current Codex conversation and the current local checkout. It does not:

- start a Docker coding worker;
- clone the repository;
- open a hidden coding-agent session;
- ask for a second Codex login;
- select verification commands at runtime;
- approve deployment.

Repository reads, edits, tests, commits, and pushes stay in the developer's normal environment and use the existing local Git configuration.

## Connect to another control plane

Application owners can host the server themselves and give developers one installation command:

```powershell
npx -y @melson/sdlc-mcp install --server https://sdlc.example.com
```

The application owner configures GitHub OAuth once for that server. Individual developers only complete the normal GitHub login and pairing flow.

## Scope

This package currently supports Codex. Native Plan mode and `/review` are client actions, so the MCP cannot activate them automatically. The connector adds a quality and governance layer around Codex; it does not control the model's internal context, compaction, routing, or reasoning loop and therefore does not claim automatic token savings.

Source, architecture, self-hosting instructions, and benchmark results are available in the [project repository](https://github.com/Melaonn/autonomouscodingagent).
