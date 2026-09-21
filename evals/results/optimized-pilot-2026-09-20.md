# Optimized SDLC harness paired validation — 2026-09-20

This follow-up used the same five tasks, baseline outputs, hidden checks, base commit (`06f21c3d5bf4ab2ea3b7ce45c57710310be65ad1`), model (`gpt-5.6-luna`), and low reasoning effort as the first pilot. The optimized harness trials ran in separate prepared worktrees with local dependencies installed before timing.

**Verdict: INCONCLUSIVE. The run validates the control loop, but it does not prove a performance benefit.**

| Result | Manual baseline | Optimized harness | Ratio |
| --- | ---: | ---: | ---: |
| Final hidden quality | 5/5 | 5/5 | tie |
| Measured total tokens | 790,468 | 903,605 | 1.14× |
| Measured uncached tokens | 112,580 | 178,869 | 1.59× |
| Wall time | 427.2s | 515.3s | 1.21× |
| Repair iterations | 0 | 1 | — |
| Human interventions | 0 | 0 | — |

All five pairs were valid and passed the production build plus held-out behavior checks. The 95% confidence interval for paired quality difference was exactly 0% to 0% because every final implementation passed. The simple tasks left no room for a quality win over the already-perfect baseline.

The optimized run materially reduced controller cost compared with the first pilot:

| Harness metric | First pilot | Optimized | Change |
| --- | ---: | ---: | ---: |
| Total-token ratio to baseline | 1.44× lower bound | 1.14× complete | −0.30× |
| Wall-time ratio to baseline | 1.78× | 1.21× | −0.57× |
| Native review turns | 5 | 0 | risk-based selection |
| Normal low-risk MCP calls | many lifecycle calls | start + verify | compact path |

The reductions came from collapsing planning, requirements, and design recording into the first verification call, keeping successful logs out of model context, reusing a dependency installation only after lockfile and installed-tree validation, running independent gates concurrently, and skipping native review for policy-approved low-risk changes.

The run also exercised the repair loop. On the atomic bulk-create task, the first candidate failed build and type-check because `create()` could return `Task | undefined`. The controller returned only those failures; Codex repaired the implementation and repeated verification without resending the specification. The second candidate passed install, build, lint, type-check, unit, integration, browser E2E, secret scan, static analysis, dependency audit, and changed-test evidence, then passed the held-out checker.

During development of this follow-up, controlled trials exposed three controller defects that were fixed before the scored run:

- model-supplied acceptance check IDs could disagree with repository gate IDs; the controller now binds acceptance evidence to configured test gates;
- a broad Vitest command loaded Playwright specifications; TypeScript profiles now isolate unit, integration, and browser E2E suites;
- agent-selectable validation mode and review evidence created unnecessary turns; Codex chat now starts delivery runs and repository risk policy alone controls native review.

A further evidence gap appeared when one intermediate bulk-create candidate changed source without changing tests. Repository policy can now require a changed test path whenever configured source paths change. This is a structural rule based on administrator-owned globs, not prompt keywords. The final scored bulk candidate included both unit and integration regression coverage.

The result remains inconclusive because final quality tied and the harness consumed more tokens and time. The baseline outputs were retained from the earlier paired run rather than rerun concurrently, and the tasks were small explicit API changes with no company knowledge configured. They validate mechanics and cost reductions, not the main hypothesis that company context and enforced incident-specific gates improve difficult real work.

The next useful experiment should use blinded historical defects from the target company. Each task should include production-like repository state, private architecture and incident documents available only through the configured context layer, and held-out regression/security checks derived from the incident. At least 10–20 such paired tasks are needed before claiming improved coding-agent performance.
