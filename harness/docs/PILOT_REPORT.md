# Four-model live Harness pilot — results

Bounded compatibility/feasibility pilot (NOT a benchmark, NOT statistically
meaningful). One attempt per model × task shape, run through the **real** Harness
(TaskRunner → shared agent loop → buildAgentRegistry tools → native sandbox →
checks → scorer → provenance) against the locally served models. Model HTTP is
real (live inference); nothing is mocked here. Run 2026-10-28 with the hardened
adapter/loop (PR #10, finish_reason + response-validation + deadline fixes).

## GPU safety

Shared box. Fresh multi-sample GPU gate immediately before every launch; one
evaluation model served at a time; TP1 for Kanana/EXAONE, TP2 for A.X/Solar;
each server stopped and its container removed before the next; **Sinsan (and all
other workloads) never touched**; box returned to the Sinsan-only baseline after
each model. All timings are **co-resident/`contended`** (idle Sinsan ~2 GB
resident) — indicative, not clean perf numbers.

## Task shapes

| | Shape | Fixture | What it exercises |
|---|---|---|---|
| T1 | simple file edit | `flaky-test` | edit + verifiable node test |
| T2 | tool selection | `tool-select` | inspect to fix the *one* wrong function, leave the other |
| T3 | tool-result continuation | `tool-continuation` | must RUN `gen.mjs` and use its stdout |
| T4 | multi-step repair | `multi-step` | inspect + fix two related bugs + verify |

All tasks share one envelope (identical prompt, tools, `maxTurns`, wall-clock,
context, checks, pinned fixtures, valid baselines). Deterministic outcomes; no
task's answer is present in its prompt.

## Per-model outcomes

| Model (checkpoint) | T1 | T2 | T3 | T4 | Infra/protocol errors | Readiness |
|---|---|---|---|---|---|---|
| Kanana 2 (bf16, `cdcbf8b8`) | ✅ | ✅ | ❌ capability | ✅ | 0 | serving_ready + harness_integrated |
| EXAONE 4.5 (fp8, `69570ad5`) | ✅ | ✅ | ✅ | ✅ | 0 | serving_ready + harness_integrated |
| A.X 4.0 (bf16, `a3393fd6`) | ✅ | ✅ | ✅ | ✅ | 0 | serving_ready + harness_integrated |
| Solar Open 2 (NVFP4 **unofficial**, `3cc67333`) | ✅ | ✅ | ✅ | ✅ | 0 | serving_ready + harness_integrated |

**15/16 task cells pass. Zero infrastructure, protocol, timeout/deadline, or
truncation errors across all runs.** The one failure is a **capability** failure,
not an infrastructure blocker.

## Per-attempt record (latest run per cell)

| Model | Shape | Status | Turns | Tool calls | stopReason | finish_reason | reasoning_chars | provider_reasoning_tokens | agent ms |
|---|---|---|---|---|---|---|---|---|---|
| Kanana | T1 | pass | 3 | 2 | done | stop | 8288 | null | 21567 |
| Kanana | T2 | pass | 3 | 2 | done | stop | 8560 | null | 15172 |
| Kanana | T3 | **fail** | 3 | 2 | done | stop | 9164 | null | 16104 |
| Kanana | T4 | pass | 3 | 2 | done | stop | 7143 | null | 12885 |
| EXAONE | T1 | pass | 8 | 8 | budget_exhausted | tool_calls | 24484 | 4959 | 164250 |
| EXAONE | T2 | pass | 8 | 8 | budget_exhausted | tool_calls | 16248 | 3307 | 102356 |
| EXAONE | T3 | pass | 8 | 8 | tool_error | tool_calls | 9043 | 1999 | 61593 |
| EXAONE | T4 | pass | 4 | 4 | tool_error | tool_calls | 1852 | 391 | 15425 |
| A.X | T1 | pass | 3 | 2 | done | stop | — (non-thinking) | null | 56351 |
| A.X | T2 | pass | 5 | 4 | done | stop | — | null | 52256 |
| A.X | T3 | pass | 3 | 2 | done | stop | — | null | 10364 |
| A.X | T4 | pass | 4 | 3 | done | stop | — | null | 34208 |
| Solar | T1 | pass | 4 | 3 | done | stop | 1607 | null | 41071 |
| Solar | T2 | pass | 4 | 3 | done | stop | 2240 | null | 10484 |
| Solar | T3 | pass | 4 | 3 | done | stop | 922 | null | 5241 |
| Solar | T4 | pass | 4 | 4 | done | stop | 2349 | null | 14274 |

`reasoning_chars` is CHARACTERS, not tokens. `provider_reasoning_tokens` is
null when the server does not reliably report it (Kanana `deepseek_r1` always
reports 0 → null; Solar does not report it → null; EXAONE `qwen3` reports real
counts). Image digests, revisions, sampling, context/output limits and
`gpuContended:true` are in each run's `provenance.model` (raw JSON retained).

## The four dimensions, kept separate

1. **Task-solving accuracy:** A.X 4/4, EXAONE 4/4, Solar 4/4, Kanana 3/4.
2. **Tool-use correctness:** all four emit valid tool calls and consume tool
   results — except Kanana on T3 (see below). EXAONE needs many turns (hits the
   8-turn budget on T1–T3) but still produces correct edits.
3. **Model/API reliability:** **perfect — 0 adapter/API/protocol/deadline errors
   in 16 runs.** Every failure is attributable to the model's output, not the
   pipeline.
4. **Resource/inference performance (contended):** A.X (TP2) and EXAONE (verbose
   reasoning) are slowest; Solar (TP2 NVFP4) and Kanana are fast. Not a ranking.

## Notable findings

- **Kanana T3 (capability failure, not infra):** Kanana wrote `out.txt` = `"T"`
  instead of the full `TOKEN-7F3A9C`, i.e. it did not correctly consume the
  `run_shell` result. Scored `fail` / `tooling:incomplete_patch`, stopReason
  `done`. This is a genuine tool-result-continuation capability gap — the Harness
  recorded it as a task failure, **not** a pass and **not** an error.
- **EXAONE turn usage:** solves T1–T3 only by using all 8 turns (stopReason
  `budget_exhausted`/`tool_error` on the final step), yet `status=pass` because
  the correct edit landed earlier and the checks pass. Status is driven by
  checks, not by the terminal stop reason — working as intended. EXAONE will
  likely need a higher `maxTurns`/output budget for harder tasks.
- **No truncation occurred** in the pilot (tasks were sized to fit every model,
  incl. Solar's 8K ceiling). The finish_reason=length → `output_truncated`
  handling is exercised by the h16/h15 regression tests instead.

## Readiness

- **serving_ready** — all four (established earlier in model-prep).
- **harness_integrated** — **all four**, now confirmed by a live end-to-end run
  through the real Harness (this pilot) in addition to the mocked h15 pipeline
  test. A.X and Solar were the two previously-missing live integrations; both now
  complete a full four-shape sweep.
- **benchmark_ready** — **not yet claimed for any model.** Promotion criteria
  (proposed): a larger, stratified task set run at pass@k with a pre-registered
  fair envelope, per-model output/turn budgets justified and fixed, Docker-isolated
  execution for every task, and a decision on how to treat capability failures
  (e.g. Kanana T3) vs infrastructure. A model that fails some tasks can still be
  benchmark-ready (benchmark-compatible); readiness is about the pipeline, not a
  score.

## Reproduce

```bash
cd harness
# serve one model (see docs/LOCAL_MODELS.md + model-prep/kserve*.sh), then:
for t in pilot-flaky-test pilot-t2-tool-select pilot-t3-tool-continuation pilot-t4-multi-step; do
  GPU_CONTENDED=true node bin/harness.mjs run tasks/local/$t.yaml --agent <kanana|exaone|ax|solar-open2> --runs-dir runs
done
```
