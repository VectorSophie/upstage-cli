# ✦✧ Harness — Agentic Evaluation Framework

The harness is a standalone evaluation system inside `harness/` that benchmarks coding agents on real bug-fixing tasks. It consumes the main CLI's internals; for isolation it shares `src/sandbox/docker-flags.mjs` (the `docker run` security-flag builder) with the main agent.

Positioned against the field:
- **SWE-bench** format: `FAIL_TO_PASS` / `PASS_TO_PASS` test split, JSONL predictions output for leaderboard submission
- **AgentBench** task composition: `_import` YAML inheritance
- **OpenHands** event streaming: typed events from the existing `runAgentLoop` generator
- **Microsoft/CMU fault taxonomy**: 5-dimension, 12-symptom deterministic failure classification

---

## Installation

```bash
cd harness
npm install
```

Requires **Node.js ≥ 20**. Docker is optional (needed only for sandboxed execution).

---

## Quick start

```bash
# Run a task with the built-in mock agent (no API key needed)
node bin/harness.mjs run tasks/fix-flaky-test.yaml --agent mock

# Run with the native Upstage agent
UPSTAGE_API_KEY=your_key node bin/harness.mjs run tasks/fix-flaky-test.yaml --agent upstage

# Compare two agents side-by-side
node bin/harness.mjs compare tasks/fix-flaky-test.yaml --agent mock --agent upstage

# Print a report from a saved run
node bin/harness.mjs report runs/<run_id>.json

# Replay a run without calling the model
node bin/harness.mjs replay runs/<run_id>.json

# Score a run interactively (human review)
node bin/harness.mjs review runs/<run_id>.json
```

---

## CLI reference

```
harness run     <task.yaml> [--agent mock|upstage|solar|solar-pro2|claude-code|claude|aider|opencode]
                            [--model M] [--k N]  [--runs-dir ./runs]
harness compare <task.yaml> --agent A --agent B [--model M] [--parallel] [--runs-dir ./runs]
harness import  <swebench|aider> <source> [--out-dir tasks/]
harness report  <run.json>  [--jsonl] [--html]
harness replay  <run.json>  [--stop-at-turn N] [--task task.yaml] [--runs-dir ./runs]
harness review  <run.json>
```

| Flag | Description |
|------|-------------|
| `--agent` | Agent to use, resolved through `AgentRegistry` (unknown/unavailable agents are an error). Repeat for `compare`. Default: `mock` |
| `--model` | Model id passed to the adapter (e.g. `solar-pro3`). `upstage` without it uses the CLI's default model; `solar-pro2` pins solar-pro2 |
| `--k` | Number of independent attempts; prints pass@k and pass^k (default: 1) |
| `--runs-dir` | Directory to save run artifacts (default: `runs/`) |
| `--parallel` | Run agents in parallel (`compare` only) |
| `--jsonl` | Output SWE-bench predictions JSONL |
| `--html` | Output HTML report |
| `--stop-at-turn` | Stop replay after turn N |
| `--task` | Task YAML path for replay (inferred from run if omitted) |

---

## Task spec format

Tasks are YAML files in `harness/tasks/`. They support `_import` inheritance from a base template.

```yaml
id: fix-missing-import
version: 1
description: "Add the missing import that causes NameError on startup"

# Inherit from a base template (optional)
_import: ./templates/python-pytest-base.yaml

# Path to the fixture repo (relative to the task file)
repo: ../fixtures/missing-import
branch: main

prompt: |
  The application fails to start with a NameError.
  Fix it. Do not modify any test files.

context:
  strategy: default       # default | full-repo | retrieval | symbol-graph | failing-test | recent-diffs
  maxFiles: 40
  includeTests: true

# Optional: pin the repo (must be a local git repo) to this revision for every attempt
# commit: d16bfe05a744909de4b27f5875fe0d4ed41ce607
# Optional: unified diff applied after the agent finishes, before checks
# (hidden from the agent, excluded from model_patch), e.g. a SWE-bench test_patch
# testPatch: |
#   diff --git a/tests/test_x.py b/tests/test_x.py ...

sandbox:
  type: native            # native (trusted, NOT isolated) | docker (isolated)
  image: python:3.12-slim # docker only
  network: none           # none | host   (allowlist is rejected: not implemented)
  timeout: 120            # seconds: agent wall-clock budget and default per-check timeout
  memory: 512m            # docker only
  cpus: 1                 # docker only
  pids: 256               # docker only
  allowedBinaries: [python, pytest, pip, ruff]

agent:
  permissions: acceptEdits
  maxTurns: 6
  maxTokens: 32768
  tools:
    allow: [read_file, write_file, search_code, run_tests]   # empty = every tool not denied
    deny: []                                                 # deny wins, and also blocks aliases

checks:
  # Must go from failing → passing
  fail_to_pass:
    - id: test-startup
      command: pytest tests/test_app.py::test_startup -x -q
      timeout: 30
      weight: 0.6

  # Must remain passing (regression guard)
  pass_to_pass:
    - id: test-existing
      command: pytest tests/ -x -q --ignore=tests/test_app.py
      timeout: 30
      weight: 0.3

  # Optional quality checks
  custom:
    - id: lint
      command: ruff check .
      timeout: 20
      weight: 0.1
      required: false

scoring:
  weights:
    checks: 0.60          # combined FAIL_TO_PASS + PASS_TO_PASS
    patchMinimality: 0.15 # smaller patch → better
    toolCallCount: 0.10   # fewer calls → better
    costUsd: 0.10         # lower cost → better
    speedMs: 0.05         # faster → better

tags: [python, import, startup]
difficulty: easy          # easy | medium | hard | expert
expectedPatchScope: [app.py]
expectedMaxLines: 3
```

### `_import` composition

The `_import` key merges a base YAML before applying the current file. Keys in the child override the parent. Use it to share sandbox config, scoring weights, or check templates across many tasks.

Circular imports are detected and throw an error.

---

## Agents

### Built-in agents

| Agent ID | Description | Requires |
|----------|-------------|----------|
| `mock` | Applies known fixture patches from `README.fixture.md`. No model call. | Nothing |
| `upstage` | Wraps the native `runAgentLoop` / `collectAgentLoop`. | `UPSTAGE_API_KEY` |
| `claude-code` | Subprocess: `claude --print … --output-format stream-json` | `claude` in PATH |
| `aider` | Subprocess: `aider --message … --yes --no-git` | `aider` in PATH |
| `opencode` | Subprocess: `opencode run --no-tty …` | `opencode` in PATH |

The `mock` agent is designed for CI smoke tests — it reads `README.fixture.md` in the fixture repo and applies any `### file: path` blocks it finds, simulating a perfect fix with no API calls.

### Custom agents

Register a custom agent at runtime:

```js
import { defaultRegistry } from "./src/agent/registry.mjs";
import { CodingAgent } from "./src/agent/interface.mjs";

class MyAgent extends CodingAgent {
  get id() { return "my-agent"; }
  get displayName() { return "My Agent"; }
  isAvailable() { return true; }
  async run(task, context) {
    // context: { workdir, sandbox, auditLog }
    // ... do work ...
    return { ok: true, turns: 1, toolCalls: 0, usage: null, events: [], stopReason: "done" };
  }
}

defaultRegistry.register(["my-agent"], (opts) => new MyAgent(opts));
```

`register(ids, factory)`: the factory receives `{ model }`. An adapter that spawns its
own host processes must keep the default `supportsSandbox === false`; the runner then
refuses to run it on `sandbox.type: docker` tasks instead of pretending it is isolated.
Return `true` only if every command the agent runs goes through `context.executor`.

Then use it:
```bash
node bin/harness.mjs run tasks/my-task.yaml --agent my-agent
```

---

## Run artifact format

Each run produces a JSON artifact in `runs/`, named `run_<UTC ts>_<task>_<agent>_<random6>.json`.
The random suffix prevents same-second collisions, and files are written exclusively
(`wx`), so an existing record is never overwritten. Values of credential-looking host env
vars (`*KEY*`, `*TOKEN*`, `*SECRET*`, ...) are redacted before writing.

`instance_id` / `model_patch` use the SWE-bench predictions format, but harness scores are
not official SWE-bench scores (see [SWE-bench import](#swe-bench-import)).

**`status`** is one of:

| `status` | Meaning |
|----------|---------|
| `pass` | At least one required acceptance check (`fail_to_pass` or required `custom`) ran, and every required check in every group passed |
| `fail` | A required check failed or timed out on the agent's patch |
| `incomplete` | The task defines no required acceptance checks; never counted as success |
| `error` | Harness/adapter failure (adapter threw or returned a malformed result, a check could not execute, the test patch did not apply); not attributed to the agent |

`outcome: { status, reason, detail }` explains the status. `required: false` checks are
reported but never decide it.

Unknown values are `null`, never `0`: `metrics.turns`, `toolCalls`, `*Tokens` and
`estimatedCostUsd` are `null` when the adapter/provider did not report them (cost is also
`null` for models with no price entry).

Fields added in the 2026-10 audit (old artifacts stay readable): `outcome`; `sandbox` (the
isolation actually applied, with `enforced` flags and `warnings`); `provenance` (harness
version / commit / dirty flag, Node and platform, task spec hash, repo source / pinned
commit / snapshot commit, agent and model id / sampling where known, limits, advertised
tool names and schema hash, seed); `metrics.agentDurationMs`; `trace.stopReason`;
`trace.agentError`; `evaluation.baseline`; `evaluation.compositeIsAuthoritative: false`;
per-check `timedOut` / `infraError`; truncated tool `result` in `trace.toolCalls`.

```json
{
  "id": "run_20260427T1430_fix-missing-import_upstage",
  "instance_id": "fix-missing-import",
  "taskId": "fix-missing-import",
  "agentId": "upstage-solar-pro2",
  "status": "pass",

  "evaluation": {
    "score": 0.91,
    "failToPassRate": 1.0,
    "passToPassRate": 1.0,
    "checks": { "fail_to_pass": [...], "pass_to_pass": [...], "custom": [...] },
    "passAtK": { "k1": 1.0 }
  },

  "metrics": {
    "toolCalls": 7,
    "turns": 2,
    "totalTokens": 3520,
    "estimatedCostUsd": 0.04,
    "patch": { "filesChanged": 1, "linesAdded": 1, "linesRemoved": 0 }
  },

  "trace": {
    "turns": [{ "index": 0, "toolCalls": [...], "thoughtSummary": "...", "response": "..." }],
    "toolCalls": [...],
    "contextStrategyUsed": "default"
  },

  "patch": {
    "initialCommit": "abc123",
    "model_patch": "--- a/app.py\n+++ b/app.py\n...",
    "filesChanged": ["app.py"]
  },

  "safety": { "riskFlags": [], "secretsDetected": false },
  "failure": null,
  "humanReview": null
}
```

---

## Scoring formula

> **Legacy composite, not an authoritative ranking.** Pass/fail comes only from `status`
> (above). The composite is kept for backward compatibility. Components whose input is
> unknown (e.g. cost without usage) are reported as `null` and left out, and the remaining
> weights are renormalised.

```
score = 0.60 × checksScore
      + 0.15 × patchMinimalityScore
      + 0.10 × toolCallScore
      + 0.10 × costScore
      + 0.05 × speedScore

checksScore        = (failToPassRate × 0.7) + (passToPassRate × 0.3)
patchMinimalityScore = 1 / (1 + log(1 + linesChanged))
toolCallScore      = 1 / (1 + log(1 + toolCalls))
costScore          = clamp(1 − costUsd / costBudgetUsd, 0, 1)
speedScore         = clamp(1 − durationMs / (timeout × 1000), 0, 1)
```

The **primary headline metric** is `status` (resolved = `pass`). `failToPassRate` and
`passToPassRate` are legacy composite inputs, where an empty list counts as 1.0.

Before the agent runs, a **baseline** is taken on the untouched repo (with `testPatch`
applied, if any). Every `pass_to_pass` check must pass and every `fail_to_pass` check must
*fail*; otherwise the task is rejected, because a no-op agent would pass it. The workspace
is then reset to the snapshot commit. The agent's patch is captured **before** checks run,
so check side effects (caches, `__pycache__`, ...) never leak into it.

### pass@k

For `--k N`, the harness runs N independent attempts and computes the unbiased pass@k estimator:

```
pass@k = 1 - C(n-c, k) / C(n, k)
```

where `n` = total runs, `c` = passing runs, `k` = sample size.

`--k N` also prints **pass^k** = `C(c, k) / C(n, k)`: the probability that *all* k attempts
succeed (reliability, τ-bench style), as opposed to pass@k (at least one succeeds). Only
`pass`/`fail` attempts are scorable. `error`/`incomplete` attempts are counted separately,
and if fewer than k attempts are scorable both metrics are `unknown`.

---

## Failure taxonomy

When a run fails, `classifyFailure()` assigns one of 12 symptoms across 5 dimensions. Detection is fully deterministic — no LLM needed.

| Dimension | Symptom | Detection |
|-----------|---------|-----------|
| **Cognition** | `misunderstood_task` | FAIL_TO_PASS fails + patch outside `expectedPatchScope` |
| | `hallucinated_api` | Patch adds symbol not found in repo |
| | `over_engineering` | `linesAdded > expectedMaxLines × 3` |
| **Tooling** | `incomplete_patch` | `linesAdded + linesRemoved < 3` or no files changed |
| | `test_gaming` | Patch touches `test_*`, `*_test.*`, or `tests/` |
| | `tool_loop` | Same tool + same args called ≥ 3 times |
| **Perception** | `broke_unrelated_code` | PASS_TO_PASS checks fail that were passing before |
| | `wrong_scope` | Right fix, wrong file — patch ∩ expectedScope = ∅ |
| **Runtime** | `timeout` | `durationMs ≥ sandbox.timeout × 1000` |
| | `dependency_failure` | "command not found" / "ModuleNotFoundError" in output |
| | `budget_exhausted` | `stopReason === "budget_exhausted"` |
| **Safety** | `unsafe_command` | Guardrail triggered |
| | `secret_exfiltration_attempt` | curl/wget with credential pattern |

Resolution order: **safety → runtime → cognition → tooling → perception** (first match wins).

Non-agent outcomes stay out of the five dimensions: `status: error` →
`{ dimension: "infrastructure", symptom: <outcome.reason> }`, and `status: incomplete` →
`{ dimension: "evaluation", symptom: "incomplete_evaluation" }`. `timeout` uses the agent's
own wall time (`metrics.agentDurationMs`) or a timed-out check, not the total run time.

---

## Comparison report

`harness compare` runs the same task with two or more agents and prints a side-by-side Markdown table:

```
| Agent              | Status | Score | FTP% | PTP% | Cost   | Time  | +Lines | Tools | Failure |
|--------------------|--------|-------|------|------|--------|-------|--------|-------|---------|
| upstage-solar-pro2 | PASS   | 91    | 100% | 100% | $0.04  | 112s  | +1     | 7     | —       |
| claude-code        | PASS   | 87    | 100% | 100% | $0.12  | 89s   | +3     | 11    | —       |
| aider              | FAIL   | 31    | 0%   | 100% | $0.08  | 204s  | +0     | 14    | incomplete_patch |
```

Use `--parallel` to run agents concurrently and save wall time.

---

## Replay

Replay re-runs a task using the recorded trace — the live model is **never called**.

```bash
node bin/harness.mjs replay runs/<run_id>.json

# Stop after turn 1 (inspect partial state)
node bin/harness.mjs replay runs/<run_id>.json --stop-at-turn 1
```

The replay engine stubs the agent's `run()` to return recorded turns and tool results. If the recorded tool sequence diverges from what the stubbed agent produces, divergences are logged:

```
Divergences detected: 1
  turn 2: expected tool 'read_file' got 'write_file'
```

**Use case:** change the context injection strategy (`--experimental-context`) and replay for free to see if it would have made different tool choices — without spending tokens.

---

## Context strategies

> **Not wired to the CLI.** The strategies exist in `src/evaluation/context-experiments.mjs`,
> but `harness run` does not parse `--experimental-context` and no adapter consumes them.

Intended strategies:

| Strategy | Description |
|----------|-------------|
| `default` | Repo map + top-5 relevant files (current default) |
| `full-repo` | Entire codebase concatenated, hard cap at 128k chars |
| `failing-test` | Failing test file + captured stack trace only |
| `recent-diffs` | Last 10 git commits unified diff |
| `retrieval` | Grep-based keyword search over the codebase |
| `symbol-graph` | Regex-extracted function/class symbol graph |

Run the same task twice with different strategies and compare scores to measure framework sensitivity.

---

## Human review

```bash
node bin/harness.mjs review runs/<run_id>.json
```

Prompts for a 1–5 score on five dimensions:

| Dimension | Question |
|-----------|----------|
| Correctness | Does the fix actually solve the problem? |
| Maintainability | Is the code readable and well-structured? |
| Minimality | Is the patch as small as it reasonably can be? |
| Security | Does the fix avoid introducing vulnerabilities? |
| Style fit | Does the code match the surrounding style? |

Scores and an optional comment are written back to `run.humanReview` in the run artifact.

---

## MCP server

The harness exposes 8 tools over a JSON-RPC 2.0 stdio transport, compatible with any MCP client.

```bash
# Start the server in a workdir
HARNESS_WORKDIR=fixtures/flaky-test node src/mcp/server.mjs

# Send a request
echo '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}' | \
  HARNESS_WORKDIR=fixtures/flaky-test node src/mcp/server.mjs
```

| Tool | Description |
|------|-------------|
| `filesystem/read` | Read a file from the workdir |
| `filesystem/write` | Write a file to the workdir |
| `filesystem/list` | List files in the workdir |
| `shell/run` | Run a shell command in the workdir |
| `git/diff` | Get the unified diff of uncommitted changes |
| `git/status` | Get git status |
| `test/run` | Run configured checks for the current task |
| `static_analysis/run` | Run a static analysis command |

---

## Fixtures

| Fixture | Language | Bug | FAIL_TO_PASS | PASS_TO_PASS |
|---------|----------|-----|--------------|--------------|
| `missing-import` | Python | `from flask import jsonify` missing | `test_startup` | `test_health`, `test_list` |
| `flaky-test` | JavaScript | Missing `await` in async test | `test_data_fetch` | `test_config`, `test_parse` |
| `security-bug` | Python | SQL injection via f-string | `test_search_injection` | `test_search_normal`, `test_auth` |

Each fixture is a plain directory with source code, a test suite, and a `README.fixture.md` that describes the bug and contains the expected fix in fenced code blocks (used by `MockAgent`).

### Adding a fixture

1. Create `harness/fixtures/<name>/` with source + failing test + passing baseline
2. Add `harness/fixtures/<name>/README.fixture.md` with `### file: path` blocks for the fix
3. Create `harness/tasks/fix-<name>.yaml` pointing to the fixture
4. Verify: `node bin/harness.mjs run tasks/fix-<name>.yaml --agent mock`

---

## Sandbox

A task gets exactly the sandbox it declares. `type: docker` with Docker unavailable is an
error: there is **no silent fallback** to native.

### Native (default): trusted local development only
Commands (checks, and the agent's own tool calls) run directly on the host in the task
workspace. Enforced: a wall-clock timeout that **kills the whole process tree**, and
credential-looking env vars plus harness-internal env (`NODE_TEST_CONTEXT`, `NODE_OPTIONS`)
are stripped from check processes. **Not enforced:** network, filesystem, CPU, memory, pids.
The run record's `sandbox.enforced` and `sandbox.warnings` say so.

### Docker: for untrusted execution
Every command, both evaluation checks **and** agent-controlled execution, runs in a fresh
`docker run --rm` container with only the task workspace bind-mounted at `/workspace`:

| Restriction | How |
|-------------|-----|
| Network | `--network none` by default (`host` → default bridge, never `--network host`; `allowlist` → rejected as unsupported) |
| Filesystem | only the workspace is mounted; read-only root; `noexec` tmpfs `/tmp` |
| Resources | `--memory` (plus equal `--memory-swap`), `--cpus`, `--pids-limit` |
| Privileges | `--cap-drop ALL`, `no-new-privileges`, runs as the invoking uid:gid on POSIX |
| Time | per-command timeout; the container is force-removed (`docker rm -f`) on timeout |
| Teardown | in `finally` and on SIGINT/SIGTERM: live containers removed, workspace deleted |

Optional dependency layer: if the workspace has `requirements.txt` (python* image) or
`package.json` (node* image), an env image `harness-env:<hash>` is built once, keyed by the
image plus the dependency file's content. A failed build is an error.
`HARNESS_DOCKER_CACHE=base` skips the layer.

**Agent tools under Docker.** Adapters declare `supportsSandbox`. Host-process agents
(`claude-code`, `aider`, `opencode`) are refused on docker tasks. For `upstage`:

- `run_shell` / `run_tests` run inside the container, and the model can no longer choose
  `sandbox` or `networkBlocked`
- host-only tools (lint/typecheck subprocesses, web, browser, GitHub, subagents, skills,
  MCP/discovered tools) are removed; explicitly allowing one is a configuration error
- in-process file tools stay, but every path is resolved with `realpath` and must stay
  inside the workspace, and symlinks that escape the workspace are removed after every
  container command

```yaml
sandbox:
  type: docker
  image: python:3.12-slim
  network: none
  memory: 512m
  cpus: 1
  pids: 256
```

Every attempt starts from a fresh copy of the fixture (checked out at `commit:` when given)
plus a snapshot commit, so `--k N` attempts never share a workspace.

---

## Tool restrictions

`agent.tools.allow` / `agent.tools.deny` are enforced for the `upstage` agent
(`src/agent/tool-policy.mjs`):

- unauthorized tools are removed before the model sees the tool schema, and every
  invocation is re-checked server-side (including tools registered later and nested
  subagent calls)
- deny wins over allow; `allow: []` means "every tool not denied"
- deny also blocks aliases: case/separator variants and namespaced forms
  (`mcp__srv__write_file`, `srv.write_file`, `Write-File`) of a denied name
- allow matches exact names only
- unknown tool → `TOOL_NOT_FOUND`; denied → `TOOL_DENIED`; a non-string name or
  non-object arguments → `INVALID_TOOL_CALL`

Subprocess agents (`claude-code`, `aider`, `opencode`) do **not** enforce `agent.tools`,
because their CLIs choose their own tools.

---

## Safety guardrails

`SafetyGuardrails` wraps the existing `HookEngine` and detects five categories before any tool executes:

| Category | Detection |
|----------|-----------|
| Secret exfiltration | `curl`/`wget --data` with `API_KEY\|TOKEN\|PASSWORD\|SECRET` |
| Destructive commands | `rm -rf /`, `DROP TABLE`, etc. (reuses `getDangerousPatterns()`) |
| Dependency confusion | pip/npm from non-official registry URLs |
| Prompt injection | Repo files containing `ignore previous instructions` |
| Privilege escalation | `sudo`, `chmod 777`, `su` patterns |

> **Not wired into `TaskRunner`.** `SafetyGuardrails` exists and is unit-tested (h7), but
> the runner never installs it, so `run.safety.riskFlags` is always `[]` and the `safety`
> taxonomy dimension never fires for real runs.

---

## Test suite

```bash
cd harness
npm test             # h1–h5, h7–h11: no Docker, no API key
npm run test:docker  # h6 + h12: REAL Docker; reported as skipped ("NOT EXECUTED") without it
npm run smoke        # mock agent on fix-flaky-test
```

| File | Coverage |
|------|----------|
| `h1-task-schema.test.mjs` | Schema validation, `_import` resolution, required fields |
| `h2-task-runner.test.mjs` | TaskRunner orchestration, MockAgent, baseline |
| `h3-evaluation.test.mjs` | Scoring formula, taxonomy symptoms, pass@k |
| `h4-patch-tracker.test.mjs` | git init, diff capture, multi-file, no-change |
| `h5-agents.test.mjs` | CodingAgent interface, MockAgent parsing, AgentRegistry, comparison table |
| `h6-sandbox-docker.test.mjs` | Sandbox selection (fail-closed), DockerSandbox exec (real Docker) |
| `h7-safety.test.mjs` | All 5 guardrail categories |
| `h8-replay.test.mjs` | Stub adapter, divergence detection, partial replay |
| `h9-mcp.test.mjs` | MCP tool calls over stdio pipe |
| `h10-import.test.mjs` | SWE-bench / Aider importers |
| `h11-correctness.test.mjs` | Audit regressions: real patch scoring, outcome rules, tool allow/deny/aliases/malformed calls, mocked Docker tool confinement, process-tree timeout kill, identical attempt state, pinned commit + hidden test patch, registry CLI resolution, malformed adapters, null usage/cost, pass^k, run ids, redaction |
| `h12-docker-isolation.test.mjs` | Real Docker: host file unreachable, no network, cgroup memory/cpu/pids limits, read-only root, timeout removes the container, run_shell routed into the container, container-planted symlink escape, end-to-end docker task |

Replay limitation: replay does not re-apply the recorded file edits, so a replayed run
re-evaluates the untouched repo (a recorded `pass` replays as `fail`).

---

## SWE-bench import

```bash
node bin/harness.mjs import swebench instances.jsonl --out-dir tasks/swebench
```

The importer parses `FAIL_TO_PASS` / `PASS_TO_PASS` whether they are JSON-encoded strings
(the official dataset format) or arrays. It keeps `base_commit` as `commit:` and
`test_patch` as `testPatch:`, and skips (and reports) instances with no `FAIL_TO_PASS`.

`repo:` is written as `github:<owner>/<name>`, a remote identifier that the runner refuses.
Clone the repo and point `repo:` at the local clone. The runner then checks out `commit:`
for every attempt and applies `testPatch` only for the baseline and the final checks.

**Not supported; imported tasks do not reproduce official SWE-bench scores**
(`_meta.officialEvalCompatible: false`):

- the per-repo, per-version environment (Python version, install steps, pinned deps from
  `environment_setup_commit`) is not built; tasks default to `type: native`
- checks are `python -m pytest -q "<test id>"` approximations. Repos with their own runners
  and test-id formats (django's `runtests.py`, sympy's `bin/test`, ...) will not run
  correctly, and the official log parsers are not used
- no automatic cloning (it needs network access and is deliberately out of scope)

## SWE-bench predictions format

```bash
# Generate predictions JSONL for all runs in a directory
for f in runs/*.json; do
  node bin/harness.mjs report "$f" --jsonl
done > predictions/my-agent.jsonl
```

The JSONL format matches SWE-bench expectations:
```jsonl
{"instance_id": "fix-missing-import", "model_name_or_path": "upstage-solar-pro2", "model_patch": "--- a/app.py\n..."}
```
