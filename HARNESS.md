# ✦✧ Harness — Agentic Evaluation Framework

The harness is a standalone evaluation system inside `harness/` that benchmarks coding agents on real bug-fixing tasks. It is a pure consumer of the main CLI's internals — `src/` is never modified.

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
harness run     <task.yaml> [--agent mock|upstage|claude-code|aider|opencode]
                            [--k N]  [--runs-dir ./runs]
harness compare <task.yaml> --agent A --agent B [--parallel] [--runs-dir ./runs]
harness report  <run.json>  [--jsonl] [--html]
harness replay  <run.json>  [--stop-at-turn N] [--task task.yaml] [--runs-dir ./runs]
harness review  <run.json>
```

| Flag | Description |
|------|-------------|
| `--agent` | Agent to use. Repeat for `compare`. Default: `mock` |
| `--k` | Number of independent runs for pass@k metric (default: 1) |
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

sandbox:
  type: native            # native | docker
  image: python:3.12-slim # docker only
  network: none           # none | allowlist | host
  timeout: 120            # seconds
  memory: 512m
  allowedBinaries: [python, pytest, pip, ruff]

agent:
  permissions: acceptEdits
  maxTurns: 6
  maxTokens: 32768
  tools:
    allow: [read_file, write_file, search_code, run_tests]
    deny: []

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

defaultRegistry.register(new MyAgent());
```

Then use it:
```bash
node bin/harness.mjs run tasks/my-task.yaml --agent my-agent
```

---

## Run artifact format

Each run produces a JSON artifact in `runs/`. It is SWE-bench compatible: the `instance_id` and `model_patch` fields can be submitted directly to leaderboards.

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

The **primary headline metric** is `failToPassRate` — the SWE-bench resolution rate equivalent.

### pass@k

For `--k N`, the harness runs N independent attempts and computes the unbiased pass@k estimator:

```
pass@k = 1 - C(n-c, k) / C(n, k)
```

where `n` = total runs, `c` = passing runs, `k` = sample size.

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

Pass `--experimental-context <strategy>` to `harness run` to test different context injection approaches:

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

### Native (default)
Wraps `src/sandbox/exec.mjs`. Commands run in the host environment inside the fixture workdir. Suitable for local development.

### Docker
Three-tier layered image cache (SWE-bench pattern):

| Layer | Contents | Shared? |
|-------|----------|---------|
| Base | Language runtime (`python:3.12-slim`) | Across all tasks |
| Environment | Task deps pre-installed | Per unique dep set |
| Instance | Per-run bind mount at `/workspace` | Per run |

```yaml
sandbox:
  type: docker
  image: python:3.12-slim
  network: none
  memory: 512m
```

Set `SKIP_DOCKER=1` to skip Docker tests in CI environments without Docker.

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

Triggered flags are recorded in `run.safety.riskFlags`.

---

## Test suite

```bash
cd harness
npm test   # 135 tests across h1–h5, h7–h9
```

| File | Coverage |
|------|----------|
| `h1-task-schema.test.mjs` | Schema validation, `_import` resolution, required fields |
| `h2-task-runner.test.mjs` | TaskRunner 12-step orchestration, MockAgent, baseline |
| `h3-evaluation.test.mjs` | Scoring formula, all 12 taxonomy symptoms, pass@k |
| `h4-patch-tracker.test.mjs` | git init, diff capture, multi-file, no-change |
| `h5-agents.test.mjs` | CodingAgent interface, MockAgent parsing, AgentRegistry, comparison table |
| `h6-sandbox-docker.test.mjs` | DockerSandbox (skip with `SKIP_DOCKER=1`) |
| `h7-safety.test.mjs` | All 5 guardrail categories |
| `h8-replay.test.mjs` | Stub adapter, divergence detection, partial replay |
| `h9-mcp.test.mjs` | MCP tool calls over stdio pipe |

---

## SWE-bench leaderboard submission

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
