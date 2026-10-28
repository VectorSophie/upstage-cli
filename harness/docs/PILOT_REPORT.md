# Four-model live Harness pilot — results

Bounded compatibility/feasibility pilot (**NOT a benchmark, NOT statistically
meaningful**, no pass@k). One attempt per model × task shape, run through the
**real** Harness (TaskRunner → shared agent loop → buildAgentRegistry tools →
sandbox → checks → scorer → provenance) against the locally served models. Model
HTTP is real (live inference); nothing is mocked.

Two runs are reported, kept distinct:

- **Run 1 — original pilot (2026-10-28)**: 4×4 sweep. Historical. Its T3 was
  **not** a rigorous tool-result test (see the caveat below).
- **Run 2 — revised T3 validation (2026-10-28)**: the rigorous `tool-continuation-v2`
  task re-run live on all four models after the T3 repair.

Two outcome dimensions are tracked separately throughout:

- **Task pass** — did the agent's final patch satisfy the required checks?
- **Clean completion** — did the agent terminate normally (`stopReason: done`),
  as opposed to exhausting its turn budget or ending on a tool error? A correct
  patch that lands before an abnormal termination is still a task pass, but it is
  **not** a clean completion, and the two are never conflated.

## GPU safety

Shared box. Fresh multi-sample GPU gate immediately before every launch (the
launcher refuses if foreign compute exceeds the Sinsan allowance); one evaluation
model served at a time; TP1 for Kanana/EXAONE, TP2 for A.X/Solar; each server
stopped and its container removed before the next; **Sinsan (and all other
workloads) never touched**; box returned to the Sinsan-only baseline (GPU0
~1182 MiB / GPU1 ~782 MiB, 0% util) after each model. All timings are
**co-resident / `contended`** — indicative, not clean perf numbers.

## Task shapes

| | Shape | Fixture | What it exercises |
|---|---|---|---|
| T1 | simple file edit | `flaky-test` | edit + verifiable node test |
| T2 | tool selection | `tool-select` | inspect to fix the *one* wrong function, leave the other |
| T3 | tool-result continuation | `tool-continuation` (v1, **leaky**) → `tool-continuation-v2` (rigorous) | must RUN the generator and use its stdout |
| T4 | multi-step repair | `multi-step` | inspect + fix two related bugs + verify |

All tasks share one envelope (identical prompt shape, tools, `maxTurns`,
wall-clock, context, pinned fixtures, valid baselines). Each model clamps the
shared output budget to its own validated ceiling.

---

## Run 1 — original pilot (historical)

| Model (checkpoint) | T1 | T2 | T3 (v1) | T4 | Infra/protocol errors |
|---|---|---|---|---|---|
| Kanana 2 (bf16, `cdcbf8b8`) | ✅ | ✅ | ❌ capability | ✅ | 0 |
| EXAONE 4.5 (fp8, `69570ad5`) | ✅ | ✅ | ✅ | ✅ | 0 |
| A.X 4.0 (bf16, `a3393fd6`) | ✅ | ✅ | ✅ | ✅ | 0 |
| Solar Open 2 (NVFP4 **unofficial**, `3cc67333`) | ✅ | ✅ | ✅ | ✅ | 0 |

**15/16 task cells pass; 0 infrastructure/protocol/timeout/truncation errors.**

> ⚠️ **T3 (v1) validity caveat.** The original T3 fixture printed a fixed token
> (`TOKEN-7F3A9C`) that was present **in the generator source and in the check
> command**. An agent could pass by reading the source (or recalling the token)
> and writing it — without ever executing the tool. The saved EXAONE trace shows
> exactly this risk: it `read_file gen.mjs` (seeing the token) **before** running
> anything. The v1 T3 therefore does **not** distinguish tool-result continuation
> from source inspection. **Do not read any v1 T3 ✅ as evidence of tool-result
> continuation.** It is superseded by Run 2. (Kanana's v1 ❌ was a genuine
> capability miss — it wrote `"T"` instead of the full token.)

### Clean-completion dimension (Run 1)

Task pass ≠ clean completion. Terminal `stopReason` per cell:

| Model | T1 | T2 | T3(v1) | T4 | Clean completions |
|---|---|---|---|---|---|
| Kanana | done | done | done* | done | 4/4 |
| EXAONE | budget_exhausted | budget_exhausted | tool_error | tool_error | **0/4** |
| A.X | done | done | done | done | 4/4 |
| Solar | done | done | done | done | 4/4 |

\* Kanana T3(v1) terminated `done` but the task **failed** (capability).

---

## Run 2 — revised T3 (`tool-continuation-v2`), live

Rigorous tool-result-continuation task. `challenge.mjs` emits a **fresh CSPRNG
token at runtime** (not in source). Acceptance is a trace-aware evaluator that
passes only if, from the harness-recorded trace (which the agent cannot forge)
plus a pinned generator hash: (1) a `run_shell` call actually executed
`challenge.mjs` and returned a token, (2) the generator is byte-unmodified, and
(3) `out.txt` equals a token the run genuinely emitted. See
`docs/T3_TRACE_EVALUATION.md`.

| Model | Task pass | stopReason | Turns | run_shell execs of challenge | out.txt verified vs trace | agent ms (contended) |
|---|---|---|---|---|---|---|
| Kanana 2 | ✅ | done | 3 | 1× | ✅ matched emitted token | 30 474 |
| EXAONE 4.5 | ✅ | budget_exhausted | 8 | 2× (two distinct tokens) | ✅ matched emitted set | 97 243 |
| A.X 4.0 | ✅ | done | 3 | 1× | ✅ matched emitted token | 13 095 |
| Solar Open 2 | ✅ | budget_exhausted | 8 | 4× (incl. `> out.txt`) | ✅ matched emitted set | 107 166 |

**4/4 task pass. All four are now proven to genuinely run the tool and use its
result** — not read a static answer. Every out.txt was verified against a token
the model's own `challenge.mjs` execution emitted in that run, with the generator
intact. EXAONE and Solar each ran the challenge multiple times (distinct tokens
each run — confirming per-attempt distinctness); the evaluator correctly accepts
`out.txt` iff it matches **any** genuinely-emitted token from that attempt.

Each run used a per-attempt challenge seed = the CSPRNG token(s) recorded in its
trace (e.g. Kanana `T3-40fce420…`, A.X distinct, EXAONE `T3-d235076a…` +
`T3-c4934984…`, Solar four distinct). Full `provenance.model` (revisions, image
digests, parsers, sampling, `gpuContended:true`) retained per run.

### Clean-completion dimension (Run 2)

| Model | Task pass | Clean completion |
|---|---|---|
| Kanana | ✅ | ✅ (done) |
| EXAONE | ✅ | ❌ (budget_exhausted) |
| A.X | ✅ | ✅ (done) |
| Solar | ✅ | ❌ (budget_exhausted) |

**Task pass rate 4/4; clean completion rate 2/4.** 4/4 task passes is **not** 4/4
normal agent completions.

### Solar context-budget finding (infrastructure, not capability)

Solar's first v2 attempt returned `status=ERROR` (not fail) —
`agent_adapter_error [context_length] (400)`: the launcher had served Solar at
`--max-model-len 4096`, but the harness config records Solar's validated ceiling
as **8192** (`contextLimit: 8192`, provenance `launcher: "kserve-solar.sh start
8192"`). At 4096, the 4096-token output budget leaves no room for the prompt. The
adapter classified this correctly as a context-length infrastructure error (never
a task failure), and re-serving at the validated 8192 passed. **Lesson: serve
Solar at the ceiling the harness config pins; the conservative launcher default
(4096) under-serves it.**

---

## Run 3 — hardened T3-v3 (`tool-continuation-v3`), live under Docker

Final review of the v2 evaluator found three ways to pass without a genuine,
unmodified generator execution (all reproduced): (A) a command merely *containing*
`challenge.mjs`; (C) a token in stderr/echo/metadata; (B) modify→run→restore of
the generator (the post-run hash is time-of-check ≠ time-of-use). The evaluator
was hardened — exact **command identity**, **stdout-only** extraction of a
successful execution, and an **immutable generator** mounted read-only outside the
workspace (Docker) so B is structurally impossible. Details in
`docs/T3_TRACE_EVALUATION.md`.

T3-v3 runs under **real Docker isolation** (`node:22-alpine`), the generator
mounted read-only at `/opt/t3/challenge.mjs`; the agent must run exactly
`node /opt/t3/challenge.mjs`. One attempt per model, live model inference:

| Model | Task pass | Clean completion | stopReason | challenge execs | note |
|---|---|---|---|---|---|
| Kanana 2 | ✅ | ✅ | done | 1× | exact command, stdout token consumed |
| EXAONE 4.5 | ❌ capability | ❌ | tool_error | 1× | ran the challenge, then `read_file out.txt` **before writing it** → ENOENT ended the loop; out.txt never created |
| A.X 4.0 | ✅ | ✅ | done | 1× | exact command, stdout token consumed |
| Solar Open 2 (NVFP4) | ✅ | ❌ | budget_exhausted | 3× | exact command each time, token consumed |

**Task pass 3/4; clean completion 2/4.** All passes are now genuinely proven:
the exact trusted command executed in a container, its stdout token was consumed,
and the generator was read-only (unforgeable). EXAONE's failure is a real
capability miss (premature `read_file` of a not-yet-written file, ending the run
on the loop's fail-fast tool-error path — the same over-eager-verification
behaviour analysed below), correctly scored a **task fail, not an evaluator or
infrastructure error**. This is a single bounded attempt per model, not a
statistically meaningful comparison.

> **Evaluator-revision note.** The Run 2 (T3-v2) results were produced under the
> **pre-hardening** evaluator and are **not** relabeled as passing the hardened
> evaluator. Run 3 is the canonical hardened evidence. Old v2 raw traces predate
> the structured-stdout and read-only-mount evidence, so they are not treated as
> proof of execution-time integrity.

---

## EXAONE termination analysis (trace evidence)

EXAONE produces correct patches but never terminates cleanly. From the saved
traces (both runs):

| Attempt | First turn patch correct | Turns after | Terminal event | Cause (from trace) |
|---|---|---|---|---|
| T1 (flaky-test) | turn 2 (`write_file`) | 6 | budget_exhausted | turns 3–8 were redundant read-only calls (re-read files, repo_map, search_code ×2) after the fix already landed |
| T2 (tool-select) | turn 3 (`write_file`) | 5 | budget_exhausted | turns 4–8 redundant (re-read, search_code, repo_map) |
| T3 v1 | turn 3 (`write_file`) | 5 | tool_error | final call `od -c out.txt | head` → **blocked shell metacharacter** (`|`), issued during superfluous verification |
| T4 (multi-step) | turn 3 (`write_file`) | 1 | tool_error | turn 4 `read_file package.json` → **ENOENT** (file not in fixture), ended the loop early |
| T3 v2 | turn ≤3 | — | budget_exhausted | ran `challenge.mjs` twice + extra reads; never emitted a final answer |

**Diagnosis — model-specific, not a Harness defect.**

1. EXAONE emits a correct edit early, then keeps calling tools (mostly read-only
   re-inspection / self-verification) instead of producing a terminal answer. It
   does not signal completion, so it either exhausts the 8-turn budget or ends on
   an incidental failed tool call.
2. The `tool_error` terminals are **not** malformed tool calls or infrastructure
   faults. They are legitimate-but-failed calls (a blocked `|` metacharacter; a
   missing-file read) issued **after** the correct patch already existed. The
   shared agent loop treats the first failed tool call as terminal
   (`loop.mjs` `postProcess`: it appends the error to the conversation, then
   returns `FAIL`/`TOOL_ERROR`) — a legitimate fail-fast design used by the live
   product path, not an evaluation bug.
3. **The Harness records and classifies this correctly.** `status=pass` is driven
   by the checks (the correct edit passes); `trace.stopReason` faithfully records
   `budget_exhausted`/`tool_error`; `agentOk:false` is preserved;
   `classifyFailure` returns `null` on a pass (no spurious failure recorded).
   Nothing is mis-recorded. The fix is the two-dimension reporting above, **not**
   a change to scoring or stop reasons.
4. **A higher turn limit is not the remedy.** The 8-turn budget is consumed by
   redundant exploration, not by legitimate work that needs more room — raising
   it would likely yield more redundant calls and still no clean DONE. This is an
   agent-behavior issue (completion recognition), to be addressed per-model, not
   by loosening the envelope.

Scoring policy is unchanged: no stop reason was altered and no check was weakened
to make EXAONE look better.

## The four dimensions, kept separate

1. **Task-solving accuracy:** A.X 4/4, EXAONE 4/4, Solar 4/4 (Run 1);
   Kanana 3/4 in Run 1 (v1 T3 capability miss) but ✅ on the rigorous Run 2 T3.
2. **Tool-use correctness / tool-result continuation:** all four now proven on
   the rigorous T3 (Run 2) to execute the tool and use its result. EXAONE needs
   many turns and over-verifies.
3. **Model/API reliability:** 0 adapter/API/protocol/deadline errors across both
   runs **except** the one Solar `context_length` 400, which was a serving-config
   (max-model-len) mistake, correctly surfaced as `status=error` and fixed by
   serving at the pinned 8192 ceiling. No silent failures.
4. **Resource/inference performance (contended):** A.X fastest; EXAONE and Solar
   slowest (verbose reasoning + full turn budget). Not a ranking.

## Readiness

- **serving_ready** — all four (established in model-prep).
- **harness_integrated (live)** — **all four**, confirmed by live end-to-end runs
  through the real Harness, now including the **rigorous** T3.
- **benchmark_ready** — **not claimed for any model.** Promotion still requires a
  larger stratified task set at pass@k, a pre-registered fair envelope with
  per-model output/turn budgets justified and fixed (incl. Solar's 8192 ceiling
  and a completion-recognition policy for EXAONE), Docker-isolated execution for
  every task, and an explicit policy for capability failures vs infrastructure.
  **A model is not benchmark-ready merely because it passes the easiest task, and
  a task pass is not a clean completion.**

## Reproduce

```bash
cd harness
# serve one model (model-prep/kserve*.sh; Solar MUST be `kserve-solar.sh start 8192`), then:
GPU_CONTENDED=true node bin/harness.mjs run tasks/local/pilot-t3-tool-continuation-v2.yaml \
  --agent <kanana|exaone|ax|solar-open2> --runs-dir runs
```
