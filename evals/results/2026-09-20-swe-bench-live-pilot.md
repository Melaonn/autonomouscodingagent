# SWE-bench-Live paired pilot — 2026-09-20

## Decision

This pilot does **not** demonstrate a quality or efficiency improvement from the SDLC control plane. Both candidates failed the official hidden task. A larger benchmark or deployment decision would be premature until the verification policy issue described below is fixed and this task passes end to end.

## Task and controls

- Dataset: Microsoft SWE-bench-Live MultiLang
- Instance: `sveltejs__svelte-16341`
- Repository: `sveltejs/svelte`
- Base commit: `ca1eb55e970243dbed1c032e038860218325d63a`
- Model: `gpt-5.6-luna`
- Reasoning effort: `low`
- User problem statement: identical in both arms
- Grader: official Linux Docker evaluator with the task's hidden test patch
- Harness revision: `a7a3b3d38779cda4e4009bc4b742d3d3170c28c8`

## Result

| Arm | Official resolved score | Total input | Cached input | Uncached input | Output | Reasoning output |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Default Codex | 0/1 | 511,433 | 480,512 | 30,921 | 2,052 | 223 |
| Governed candidate | 0/1 | 457,491 | 420,608 | 36,883 | 2,282 | 319 |

The governed candidate used 10.5% fewer total input tokens at the interruption point, but 19.3% more uncached input and 11.2% more output. These are not completion-to-completion savings: the governed run was interrupted before its public gate and required native review completed. The token row is diagnostic and must not be presented as a fair efficiency win.

## Failure analysis

Both agents correctly exempted `autofocus` on the `<dialog>` element itself. Both missed the hidden requirement that descendants of a dialog, such as `<dialog><input autofocus></dialog>`, must also be exempt. The official evaluator reported the same failing hidden validator case for both candidates: `a11y-no-autofocus`.

The governed run did call `sdlc_start`, edit the repository, and call `sdlc_verify`. Verification did not execute because the benchmark policy registered its Docker test command as an `acceptance` check while checkpoint expansion requires a required `unit`, `integration`, or `e2e` check. That experiment configuration has been corrected to `unit`, but the run was stopped to meet the time limit. Since the independent native review never ran, this pilot evaluates a governed candidate patch rather than the complete SDLC loop.

Several earlier launches were excluded before scoring because of Windows worktree isolation, nested Codex sandbox, or local database setup failures. They are experiment setup costs and are not included in the comparison.

## Required next step

Repeat this same task with the corrected policy and allow verification plus native review to finish. The control plane only proves value if that review catches the missing descendant case and the official hidden score changes from 0 to 1. After that smoke test, run at least five fixed tasks before making a deployment or token-reduction claim.
