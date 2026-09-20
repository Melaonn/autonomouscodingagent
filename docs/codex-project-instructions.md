<!-- sdlc-chat-integration -->
## Governed SDLC workflow

For a feature, bug fix, refactor, or other request that changes this repository, use native Codex Plan mode followed by the `sdlc` MCP tools. Ordinary questions and read-only investigation do not require a run.

1. The developer starts change work in native Codex Plan mode. While it is active, inspect the repository and use Plan mode's normal question flow for real product decisions. Do not edit code, simulate Plan mode in Default mode, start another Codex process, or create the governed run before the developer accepts the plan.
2. After the developer accepts the plan and switches to implementation, inspect `git status`, call `sdlc_runs` and `sdlc_status` when continuing prior work, then call `sdlc_start` with the absolute repository root and the user's complete request. Use `mode: delivery` for changes and `mode: validation` only for an explicitly non-mutating audit. Work in this checkout and preserve intentional local changes.
3. Reuse the approved native plan without repeating resolved questions. Submit `sdlc_plan` with `source: codex-plan-mode`, followed by `sdlc_requirements` and `sdlc_design`. Ask only when a stakeholder decision remains unresolved; never invent intent.
4. Implement the change locally and send useful `sdlc_progress` updates so the dashboard shows the current work.
5. Call `sdlc_verify`. Fix every failed configured gate in this conversation and repeat verification until it passes or the run reaches its limit. Never describe a failing or skipped gate as successful.
6. After the gates pass, do not substitute your own self-review. Tell the developer to type `/review` in this Codex project and choose **Review uncommitted changes**. Native `/review` uses a dedicated reviewer and does not modify the working tree. When its findings appear in this chat, submit them faithfully with `sdlc_review`, `source: codex-native-review`, the selected scope, and evidence for every acceptance criterion. Fix blocking findings and repeat verification and `/review` as directed by the controller.
7. When a delivery review passes, create a `codex/` feature branch, commit the exact verified tree, push it to origin, and call `sdlc_publish`. Follow required CI with `sdlc_sync` or `sdlc_status`. A validation run completes after review only when the workspace is unchanged; report that evidence without publishing.
8. Deployment approval belongs to the user in the local dashboard. Never approve deployment through chat. Report the final status and link to the evidence or pull request when available.

Plan mode selection and `/review` are native client actions; MCP cannot switch modes or type slash commands. If review delivery is configured as detached, return the findings to this implementation task before calling `sdlc_review`. The control plane evidence decides completion; a model statement that work is done does not.
<!-- /sdlc-chat-integration -->
