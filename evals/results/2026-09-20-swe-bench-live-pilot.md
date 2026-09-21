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
| Governed candidate (interrupted) | 0/1 | 457,491 | 420,608 | 36,883 | 2,282 | 319 |
| Governed retry (complete lifecycle) | 0/1 | 1,325,603 | 1,242,112 | 83,491 | 5,625 | 1,464 |

The governed candidate used 10.5% fewer total input tokens at the interruption point, but 19.3% more uncached input and 11.2% more output. These are not completion-to-completion savings: the governed run was interrupted before its public gate and required native review completed. The token row is diagnostic and must not be presented as a fair efficiency win.

The corrected retry completed the controller-owned public gate and mandatory native review. The public gate passed and the reviewer returned zero findings, but official hidden grading still failed. The full governed lifecycle consumed 110.86 ChatGPT credits and more than twice the baseline token volume without improving the score. Some retry overhead came from a transposed run ID and two native-review integration defects discovered during the run; the totals above report actual consumption rather than removing that cost.

## Cost-efficiency finding

The measured implementation is not cost-efficient. Relative to the baseline, the completed governed retry used 2.59 times the total input, 2.70 times the uncached input, and 2.74 times the output for the same score. The audit found two systematic waste paths: common benchmark instructions told the governed agent to run the public gate directly even though `sdlc_verify` owned the same gate, and the runner resumed the implementation model merely to relay completed review JSON to the controller. Both paths were removed after this pilot. Review now receives the complete original request and is recorded directly through the controller API; the implementation model resumes only when review reports a blocking defect.

## Failure analysis

Both agents correctly exempted `autofocus` on the `<dialog>` element itself. Both missed the hidden requirement that descendants of a dialog, such as `<dialog><input autofocus></dialog>`, must also be exempt. The official evaluator reported the same failing hidden validator case for both candidates: `a11y-no-autofocus`.

The first governed run did call `sdlc_start`, edit the repository, and call `sdlc_verify`. Verification did not execute because the benchmark policy registered its Docker test command as an `acceptance` check while checkpoint expansion requires a required `unit`, `integration`, or `e2e` check. The corrected retry used a `unit` gate and completed verification plus native review. It nevertheless produced the same incomplete implementation and hidden-test failure.

Several earlier launches were excluded before scoring because of Windows worktree isolation, nested Codex sandbox, or local database setup failures. They are experiment setup costs and are not included in the comparison.

## Required next step

Do not proceed to deployment on the strength of this result. Improve requirement extraction and review so the explicit phrase “dialog or its descendants” becomes a measurable acceptance criterion and targeted test. Repeat this smoke test until the governed arm changes the official score from 0 to 1; only then run at least five fixed tasks before making a deployment or token-reduction claim.
