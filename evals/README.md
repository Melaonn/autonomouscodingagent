# Proving the harness is useful

The project does not claim that the harness improves Codex merely because a governed run completed. A credible claim requires paired trials against the alternative: asking the same Codex model to perform the SDLC manually.

## Experiment protocol

Use at least five representative tasks, preferably historical features, bugs, security fixes, and incident regressions from the target company.

For every task:

1. Create two isolated checkouts from the same commit.
2. Use the same Codex model and reasoning setting. Record both fields in every trial.
3. Give both variants the same high-level task and the same allowed repository context.
4. In the **baseline**, ask Codex to implement and manually perform the full SDLC without this MCP.
5. In the **harness** variant, use the normal governed workflow.
6. Keep acceptance and held-out regression commands away from both agents. Run them only with the evaluator.
7. Capture Codex JSONL so token use comes from `turn.completed.usage`, rather than an estimate. The evaluator flags active turns that report zero usage and will not accept them as efficiency evidence.
8. Record wall time, human interventions, repair iterations, and lifecycle stages completed.

Use `codex exec --json` when collecting a controlled CLI trial. Its JSONL stream contains exact input, cached-input, output, and reasoning-output token counts. If the harness trial spans implementation, native review, and a repair turn, append all of their JSONL events to the same variant log.

Raw model logs can contain source code and internal context. Keep them under `evals/raw/`, which is ignored by Git, and apply company retention controls.

## Experiment file

Copy `experiment.example.json`. Record the exact harness Git revision and company policy version so the result can be reproduced. Each paired trial names two finished checkouts and optional Codex JSONL logs. Checks use argument arrays and run identically in both checkouts.

- `acceptance`: requirements visible to the developer.
- `held-out`: regressions or edge cases withheld from both variants.
- `security`: security properties evaluated after implementation.
- `severity`: impact if the check fails. A new critical harness failure blocks a positive verdict.
- `weight`: relative contribution to the quality score.

Run:

```powershell
npm run evaluate -- --input evals/experiment.json --out evals/results/company-pilot
```

The evaluator does not launch an agent. It measures already completed paired checkouts, parses exact Codex usage, runs the same hidden commands, and produces JSON plus a reviewer-friendly Markdown report.

## Anti-overfitting rules

- Runtime harness code must not contain benchmark repository names, task IDs, prompt fragments, expected patches, or hidden-test behavior.
- Freeze and record the harness revision before selecting or executing the scored tasks. Improvements made after inspecting a failure belong to a later benchmark run.
- Keep hidden checks outside both agent workspaces and do not expose their output until each variant has finished.
- Use unchanged prompts, model versions, reasoning settings, base commits, credentials, and machine constraints for each pair.
- Count every implementation, review, repair, and recovery turn. Do not discard expensive failures or report only successful attempts.
- Use multiple unrelated repositories and task families before making a general cross-repository claim. A single-repository result applies only to that repository distribution.

## Claim policy

The report says **beneficial** only when one of these statements is supported:

1. The lower bound of the paired 95% confidence interval shows a quality improvement and there are no critical regressions. Higher token use is allowed but reported.
2. Quality is non-inferior within the configured margin and both total and uncached token use meet the configured reduction target. New experiments default to a 50% reduction target, and the evaluator does not allow a lower target.

Fewer than five paired trials, missing usage logs, identical checkouts, unfair starting commits, evaluator-mutated workspaces, and wide confidence intervals are reported explicitly. The report also states that blinding is an operator responsibility because software cannot prove the hidden checks were never shown to an agent. An inconclusive report is a valid result and must not be presented as proof.

This benchmark proves performance only for the tested task distribution, model, repository context, and policy version. Repeat it after material changes to the harness, model, company policies, or quality gates.
