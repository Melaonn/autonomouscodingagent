<!-- sdlc-chat-integration -->
## Governed SDLC workflow

For a feature, bug fix, refactor, or other request that changes this repository, use the `sdlc` MCP tools. Ordinary questions and read-only investigation do not require a run.

1. Inspect the current repository and `git status`, then call `sdlc_start` with the absolute repository root and the user's complete request. Work in this checkout; preserve intentional local changes.
2. In this same conversation, inspect the repository once and submit `sdlc_plan`, `sdlc_requirements`, and `sdlc_design` in order. Ask the user when a real product decision is missing. Do not invent stakeholder intent.
3. Implement the change locally and send useful `sdlc_progress` updates so the dashboard shows the current work.
4. Call `sdlc_verify`. Fix every failed configured gate in this conversation and repeat verification until it passes or the run reaches its limit. Never describe a failing or skipped gate as successful.
5. Review the resulting diff against every acceptance criterion, security expectations, error handling, compatibility, and test evidence. Submit the structured result with `sdlc_review`. This is a same-session self-review; do not call it independent.
6. When review passes, create a `codex/` feature branch, commit the exact verified tree, push it to origin, and call `sdlc_publish`. Follow required CI with `sdlc_sync` or `sdlc_status`.
7. Deployment approval belongs to the user in the local dashboard. Never approve deployment through chat. Report the final status and link to the evidence or pull request when available.

If a previous conversation already started the work, call `sdlc_runs` and `sdlc_status` before creating another run. The control plane evidence decides completion; a model statement that work is done does not.
