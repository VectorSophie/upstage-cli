# Evaluating the four locally served Korean models

This harness can evaluate four Korean frontier models served locally on
OpenAI-compatible endpoints, through the **same** TaskRunner / agent loop / tool
registry / Docker isolation / scoring / provenance pipeline every other agent
uses. Model-specific serving differences live entirely in **configuration**
(`harness/src/agent/local-models.mjs`) and the **server launchers**
(`/home/jackb/workspace/model-prep/kserve.sh`, `kserve-solar.sh`) — not in
generic harness or scoring code.

## Architecture (what was reused vs. added)

- **Reused:** the CLI's real agent loop (`src/agent/loop.mjs`), its tool registry
  and policy/sandbox confinement (`buildAgentRegistry` in the Upstage adapter),
  the shared OpenAI-compatible HTTP stack (`src/model/fetch-utils.mjs`,
  `src/core/streaming.mjs`), and the harness TaskRunner/scorer/provenance.
- **Added:**
  - `src/model/local-openai-adapter.mjs` — a configurable OpenAI-compatible model
    client (base URL, optional auth, sampling, `chat_template_kwargs`, timeout/
    cancellation, reasoning extraction, error classification). It reuses the
    shared HTTP utilities rather than adding a new stack.
  - `harness/src/agent/local-models.mjs` — the four models' exact, validated
    serving configuration + full provenance.
  - `harness/src/agent/adapters/local.mjs` — **one** shared `LocalModelAgent` that
    drives the real loop with a `LocalOpenAIAdapter`; model differences are pure
    config. Registered in `harness/src/agent/registry.mjs`.

There is **one** agent loop and **one** registry path for all four models.

## The four models

| Agent id | Model | Precision | TP | Runtime | Reasoning parser | Tool parser | Official? |
|---|---|---|---|---|---|---|---|
| `kanana` | Kanana 2 30B-A3B Thinking | BF16 | 1 | vLLM v0.32.0 | `deepseek_r1` | `hermes` | ✅ |
| `exaone` / `exaone-nothink` | EXAONE 4.5 33B | FP8 | 1 | vLLM v0.32.0 | `qwen3` | `hermes` | ✅ |
| `ax` | A.X 4.0 72B | BF16 | 2 | vLLM v0.32.0 | — (non-thinking) | `hermes` | ✅ |
| `solar-open2` | Solar Open 2 250B | **Nota NVFP4 (unofficial)** | 2 | Upstage fork v0.22.0 | `solar_open2` | `solar_open2` | ❌ **unofficial Nota quant** |

Pinned revisions, container-image digests, the Solar `SolarOpen2TemplateLogitsProcessor`
and its required `--max-num-seqs 256` (hybrid attention+Mamba), and the validated
context ceilings are all recorded in `local-models.mjs` and surfaced per-run in
`provenance.model`.

> **Solar Open 2 is an UNOFFICIAL third-party (Nota AI) NVFP4 W4A4 quantization**
> of `upstage/Solar-Open2-250B`. It is never presented as, or scored against, the
> official BF16 checkpoint. `provenance.model.official` is `false` for it and
> `true` for the other three.

## Serving the models (operator step; not done by the harness)

The three standard models share one vLLM v0.32.0 server on **:8101**, served **one
at a time**. Solar runs on its separate Upstage-fork server on **:8102**. These are
**not** simultaneously available endpoints.

```bash
# in /home/jackb/workspace/model-prep — see GPU safety below; one model at a time
./kserve.sh start kanana   && ./kserve.sh wait kanana      # :8101, TP1
./kserve.sh start exaone   && ./kserve.sh wait exaone      # :8101, TP1
./kserve.sh start ax       && ./kserve.sh wait ax          # :8101, TP2
./kserve-solar.sh start 8192 && ./kserve-solar.sh wait     # :8102, TP2
# stop when done:
./kserve.sh stop <model>    /   ./kserve-solar.sh stop
```

Endpoints are configurable (loopback by default); no machine address is baked in:

| Env var | Default | Used by |
|---|---|---|
| `KSERVE_BASE_URL` | `http://127.0.0.1:8101/v1` | kanana, exaone(+nothink), ax |
| `SOLAR_BASE_URL` | `http://127.0.0.1:8102/v1` | solar-open2 |
| `KANANA_BASE_URL` / `EXAONE_BASE_URL` / `AX_BASE_URL` | per-model override | respective model |
| `LOCAL_MODEL_API_KEY` | _(none)_ | optional bearer, sent only if set |
| `GPU_CONTENDED` | _(unset→null)_ | set `true`/`false` to record contention in provenance |

Keep servers bound to loopback unless remote access is explicitly required and secured.

## Running an evaluation

```bash
cd harness

# one model, one task
node bin/harness.mjs run tasks/local/pilot-flaky-test.yaml --agent kanana

# pass@k (small, bounded)
node bin/harness.mjs run tasks/local/pilot-flaky-test.yaml --agent exaone --k 3

# compare — NOTE: only one standard server runs at a time, so for kanana/exaone/ax
# run them sequentially (restart the server between models), not in one parallel
# compare. Solar is a different endpoint and can be compared against whichever
# standard model is currently up.
node bin/harness.mjs run tasks/local/pilot-flaky-test.yaml --agent ax
node bin/harness.mjs run tasks/local/pilot-flaky-test.yaml --agent solar-open2
```

The python example (`tasks/local/pilot-missing-import.yaml`) additionally needs
`pytest`+`flask` available to the sandbox; use the node pilot task otherwise.

## Common evaluation envelope and fairness

A fair comparison fixes everything except the model. The example tasks pin an
identical envelope: same prompt, same tool allowlist, same `maxTurns` (8), same
wall-clock (`sandbox.timeout`), same context strategy, same checks and baseline.

**What is NOT automatically equal, and is recorded rather than hidden:**

- **Output budget.** A single `agent.maxTokens` is *not* necessarily fair:
  Kanana/EXAONE (and Solar) can need a large budget to finish reasoning before
  producing an answer, and a budget too small truncates mid-reasoning
  (`finish_reason=length`) — which is **not** the same as a wrong answer. The
  local adapter clamps the task's `maxTokens` to each model's validated ceiling
  (Kanana/EXAONE 8192; A.X/Solar 4096, keeping Solar's prompt+output inside its
  8K context). The effective `maxOutputTokens` is recorded in `provenance.model`.
- **Context window.** Solar Open 2 is validated only to **8K** on this machine
  (131K does not fit); the others were validated at 16K. Keep pilot tasks small
  enough to fit all four.
- **Sampling.** Vendor-recommended sampling differs per model (temperature, top_p,
  top_k, presence_penalty, EXAONE's `enable_thinking`). These are recorded in
  `provenance.model.sampling` / `chatTemplateKwargs`, not forced equal.

For initial integration, use short tasks that fit every model's validated
capacity (the `pilot-*` tasks do). Record any deviation from the shared envelope.

## Four reporting dimensions — keep them separate

Do **not** collapse these into one number:

1. **Task-solving accuracy** — run `status` (pass/fail/incomplete) and `evaluation.score`.
2. **Agent/tool compatibility** — did the model emit valid tool calls / use tool
   results? (`metrics.toolCalls`, trace, `stopReason`).
3. **Inference performance** — tokens, duration (`metrics`, `agentDurationMs`),
   contended vs. not (`provenance.model.gpuContended`).
4. **Infrastructure reliability** — adapter/API errors, timeouts
   (`status=error`, `outcome.reason=agent_adapter_error`), distinct from task fails.

A model's API error, timeout, or malformed/incomplete reasoning is recorded as
`status=error` (infrastructure), never silently counted as a passing or failing
task. `LocalModelAgent` re-throws on a `model_error` loop termination so the
runner classifies it as `agent_adapter_error`.

## Reasoning metrics

Reasoning is extracted into its own `reasoning` channel server-side and **never**
merged into the scored `content`. Three signals are kept separate and reported in
`provenance.model.reasoning`:

- `reasoningChars` — character length (not tokens); `null` when no reasoning was produced.
- `tokenizerReasoningTokens` — `null` here (would require running the tokenizer).
- `providerReasoningTokens` — the server's `completion_tokens_details.reasoning_tokens`,
  but only when a **positive** value is reported. A reported `0` or a missing field
  is treated as **unknown → `null`** (Kanana's `deepseek_r1` always reports 0 even
  with thousands of reasoning characters; EXAONE's `qwen3` is reliable).

## Readiness taxonomy

- **`serving_ready`** — the model serves and passes local *serving* smoke tests
  (generation, tool call, reasoning separation). Established in
  `model-prep/smoke-test-results.md`. All four are `serving_ready`.
- **`harness_integrated`** — the model runs end-to-end through *this* harness
  pipeline (real registry, sandbox, checks, scoring, provenance) under mocked and
  (where resources permit) live conditions. Covered by the h14/h15 tests; live
  confirmation is the Stage C pilot.
- **`benchmark_ready`** — the harness *successfully executes and evaluates real
  tasks* against the live model, with reproducible provenance, at the intended
  scale. **Not** claimed until the live pilot (Stage C) has actually run and been
  recorded. A passing serving smoke test does **not** make a model benchmark-ready.

## GPU safety (shared server)

The box also runs Sinsan, RAGAS, GLM/MiMo and other jobs. Before serving:
re-check free VRAM over several samples; respect the per-model launch guards in
`kserve.sh`/`kserve-solar.sh` (they abort if a target GPU is not sufficiently
free); serve **one evaluation model at a time** (TP2 models need both GPUs); stop
and clean up only containers this workstream created; never kill another process;
do not run expensive inference tests concurrently. If the GPUs are occupied, leave
the live pilot pending rather than disrupting other workloads.
