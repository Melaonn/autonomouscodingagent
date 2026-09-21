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
- Initial harness revision: `a7a3b3d38779cda4e4009bc4b742d3d3170c28c8`
- Optimized rerun revision: `68abd3f1503e238f14cc72f6ffa34e15b60ec1d8`

## Result

| Arm | Official resolved score | Total input | Cached input | Uncached input | Output | Reasoning output |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Default Codex | 0/1 | 511,433 | 480,512 | 30,921 | 2,052 | 223 |
| Governed candidate (interrupted) | 0/1 | 457,491 | 420,608 | 36,883 | 2,282 | 319 |
| Governed retry (complete lifecycle) | 0/1 | 1,325,603 | 1,242,112 | 83,491 | 5,625 | 1,464 |
| Optimized governed rerun (scored attempt) | 0/1 | 669,587 | 626,944 | 42,643 | 3,064 | 265 |
| Optimized rerun including two setup preflights | 0/1 | 761,893 | 707,328 | 54,565 | 3,725 | 265 |

The governed candidate used 10.5% fewer total input tokens at the interruption point, but 19.3% more uncached input and 11.2% more output. These are not completion-to-completion savings: the governed run was interrupted before its public gate and required native review completed. The token row is diagnostic and must not be presented as a fair efficiency win.

The corrected retry completed the controller-owned public gate and mandatory native review. The public gate passed and the reviewer returned zero findings, but official hidden grading still failed. The full governed lifecycle consumed 110.86 ChatGPT credits and more than twice the baseline token volume without improving the score. Some retry overhead came from a transposed run ID and two native-review integration defects discovered during the run; the totals above report actual consumption rather than removing that cost.

The optimized rerun removed the redundant implementation-model review relay and gave the isolated reviewer the complete original request. Its scored attempt finished in 11 minutes 27 seconds, repaired one public-gate fixture error, passed the public gate, and completed native review. Official grading remained 0/1. The attempt itself used 1.31 times the baseline total input and 1.38 times the uncached input. Two short setup preflights exposed a headless Plan-mode conflict and a stale active-run lock; including them, the run consumed 68.94 ChatGPT credits and 1.49 times the baseline input. The starting balance was 133.11 credits and the ending balance was 64.17 credits.

## Cost-efficiency finding

The measured implementation is not cost-efficient. Relative to the baseline, the completed governed retry used 2.59 times the total input, 2.70 times the uncached input, and 2.74 times the output for the same score. The optimized scored attempt reduced that overhead substantially, but still used 31% more total input, 38% more uncached input, and 49% more output than default Codex without improving correctness. The 50% token-reduction target is therefore not supported by current evidence.

The audit found two systematic waste paths: common benchmark instructions told the governed agent to run the public gate directly even though `sdlc_verify` owned the same gate, and the runner resumed the implementation model merely to relay completed review JSON to the controller. Both paths were removed before the optimized rerun. The rerun exposed another large cost driver: a five-minute public gate ran twice because the first candidate had an inconsistent warning location in its edited fixture. Review now receives the complete original request and is recorded directly through the controller API, but it did not identify the missing descendant behavior.

## Failure analysis

Both agents correctly exempted `autofocus` on the `<dialog>` element itself. Both missed the hidden requirement that descendants of a dialog, such as `<dialog><input autofocus></dialog>`, must also be exempt. The official evaluator reported the same failing hidden validator case for both candidates: `a11y-no-autofocus`.

The optimized reviewer inspected the complete issue and diff but returned an empty findings list. The final prediction also edited the existing validator fixture; that fixture hunk did not apply cleanly in the official evaluator, leaving its expected warning positions inconsistent with the input. Either defect is sufficient to reject the candidate. Passing the controller's public gate therefore did not provide evidence that the patch was portable or that every explicit requirement was covered.

The first governed run did call `sdlc_start`, edit the repository, and call `sdlc_verify`. Verification did not execute because the benchmark policy registered its Docker test command as an `acceptance` check while checkpoint expansion requires a required `unit`, `integration`, or `e2e` check. The corrected retry used a `unit` gate and completed verification plus native review. It nevertheless produced the same incomplete implementation and hidden-test failure.

Several earlier launches were excluded before scoring because of Windows worktree isolation, nested Codex sandbox, or local database setup failures. The two optimized-run preflights are reported separately above so both the model-only scored attempt and the actual user-visible cost remain auditable.

## Required next step

Do not proceed to deployment on the strength of this result. The controller must reject lifecycle checkpoints that omit explicit request clauses, and review must verify a requirement-to-test map rather than provide a free-form diff opinion. Prediction generation also needs a clean-apply validation against the benchmark base before hidden grading. Repeat this fixed smoke test only after those general controls are implemented; then run at least five fixed tasks before making a deployment or token-reduction claim.
