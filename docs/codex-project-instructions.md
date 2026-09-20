<!-- sdlc-chat-integration -->

## Governed SDLC workflow

Use this workflow for repository changes. Ordinary questions and read-only investigation do not require a run.

1. Start in native Codex Plan mode. Inspect the repository, then call `sdlc_start` once with the absolute repository root and the developer's complete request. Use the returned company context and policy while asking normal Plan mode questions. Do not edit code until the developer accepts the plan.
2. Implement the accepted plan in this checkout and preserve intentional local changes. You may run focused tests while coding. Do not manually repeat the full configured gate suite because `sdlc_verify` owns that work.
3. Call `sdlc_verify` after implementation. On its first call, include the accepted plan, measurable requirements, technical design, and an honest `low`, `medium`, or `high` change-risk classification with a concrete rationale. The controller records these checkpoints and runs all configured build, lint, type, test, and security gates concurrently where safe.
4. Fix every returned failure in this conversation. Repeat `sdlc_verify` without the specification until it passes or reaches its attempt limit. Never describe a failed or skipped gate as successful.
5. Follow the review decision returned by verification. For a required review, ask the developer to type `/review` and choose **Review uncommitted changes**, then submit the exact summary and findings with `sdlc_review`. Fix blocking findings and verify again. When review is not required, continue without creating another agent turn.
6. For delivery, create a `codex/` feature branch, commit and push the exact verified tree, then call `sdlc_publish`. The server creates or updates the pull request and follows required CI automatically. Validation runs finish without publication when the workspace is unchanged.
7. Deployment approval belongs to the developer in the local dashboard. Never approve deployment through chat.

The normal path uses three control-plane calls: start, verify, and publish. A policy-required native review adds one call. Use `sdlc_status` only for recovery, troubleshooting, or an explicit status request. Tool evidence, not model prose, decides completion.
<!-- /sdlc-chat-integration -->
