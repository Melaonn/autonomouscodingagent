<!-- sdlc-chat-integration -->
## SDLC workflow from Codex

For a user request to implement a feature or fix a bug in this repository:

1. Identify this repository's exact GitHub owner/repo from `git remote get-url origin`. Check `git status --short`. Explain that the governed worker starts from the configured remote branch and does not include uncommitted local changes. Do not silently discard, stash, commit or upload them.
2. Call `sdlc_repositories` and match this repository exactly. If unavailable or unconfigured, explain the blocker; never silently claim governed execution or switch repositories.
3. Call `sdlc_runs` to find an existing task before starting a duplicate. For a new task call `sdlc_start` with the user's feature/bug request and relevant conversation requirements. Do not include credentials or unrelated files in the prompt.
4. The harness's background Codex worker owns implementation in an isolated checkout. Do not simultaneously implement the task in this local checkout. Use `sdlc_status` with `waitSeconds: 20` and the last `updatedAt` to follow work, explaining meaningful progress. The worker continues if this chat closes while the harness services remain running.
5. If the run needs input, ask the user the exact clarification question and send their answer through `sdlc_answer`. Do not invent stakeholder answers.
6. Report actual failed or blocked gates. Resume only after the blocker is resolved; never repeatedly resume unchanged failures. Cancel only at the user's request.
7. At deployment approval, direct the user to the local dashboard to review the exact commit. Never approve through shell, HTTP, or other tools on the user's behalf.
8. Use `sdlc_report` to explain the final evidence and PR link. A model saying done is not a passed run.

Ordinary questions, code explanations and reviews do not start a run. An explicit user request to work locally overrides this routing: explain that this work is outside the governed run. These instructions help select the workflow; they are not a technical interception of every Codex prompt.
<!-- /sdlc-chat-integration -->
