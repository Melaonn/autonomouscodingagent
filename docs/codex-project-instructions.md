<!-- sdlc-chat-integration -->

## Governed SDLC workflow

For a feature, bug fix, refactor, or other request that changes this repository, use native Codex Plan mode followed by the `sdlc` MCP tools. Ordinary questions and read-only investigation do not require a run.

1. The developer starts change work in native Codex Plan mode. While it is active, inspect the repository and use Plan mode's normal question flow for real product decisions. Do not edit code, simulate Plan mode in Default mode, start another Codex process, or create the governed run before the developer accepts the plan.
2. After the developer accepts the plan and switches to implementation, inspect `git status` and call `sdlc_begin` once with the absolute repository root, complete request, and approved plan. Use `mode: delivery` for changes and `mode: validation` only for an explicitly non-mutating audit. This one call starts or resumes the run, records native-plan provenance, and returns company context, policy, and configured check IDs.
3. Read that returned context, create measurable acceptance criteria and the technical design, then submit both in one `sdlc_spec` call. Ask only when a stakeholder decision remains unresolved; never invent intent or repeat questions already resolved in Plan mode.
4. Implement locally in this checkout and preserve intentional local changes. Do not send manual progress calls; lifecycle transitions and verification report progress automatically.
5. Call `sdlc_verify` once after implementation. Fix every failed configured gate in this conversation and repeat only this verification call until it passes or the run reaches its limit. Never describe a failing or skipped gate as successful.
6. After the gates pass, tell the developer to type `/review` in this Codex project and choose **Review uncommitted changes**. Submit its exact findings and acceptance evidence once with `sdlc_review`; native provenance and the usual scope are added automatically. Fix blocking findings and repeat verification and `/review` as directed by the controller.
7. When a delivery review passes, create a `codex/` feature branch, commit the exact verified tree, push it to origin, and call `sdlc_publish` once. The server follows required CI automatically. Use `sdlc_runs` or `sdlc_status` only for recovery, troubleshooting, or an explicit status request. A validation run completes after review only when the workspace is unchanged.
8. Deployment approval belongs to the user in the local dashboard. Never approve deployment through chat. Report the final status and link to the evidence or pull request when available.

The normal delivery path uses five control-plane calls: begin, spec, verify, review, and publish. Plan mode selection and `/review` are native client actions; MCP cannot switch modes or type slash commands. If review delivery is configured as detached, return the findings to this implementation task before calling `sdlc_review`. The control plane evidence decides completion; a model statement that work is done does not.
<!-- /sdlc-chat-integration -->
