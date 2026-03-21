# upstage-cli Architecture Blueprint

## System Overview

`upstage-cli` is a hybrid AI coding agent platform designed for Gemini CLI-level UX, Opencode-grade tool ergonomics, and Upstage-native model routing.

Core principle: **Rust executes, TypeScript decides**.

### Layered Architecture

1. **CLI UI Layer**
   - Fullscreen terminal app, streaming output, interactive chat, diff previews, file tree browser, command palette.

2. **Agent Orchestrator Layer (TypeScript)**
   - Planning loop, tool decision policy, context packing, fallback routing, stop-reason accounting.

3. **Tool System Layer (Rust-hosted)**
   - Typed tool registry, permission checks, sandbox policy, execution engine, result normalization.

4. **Model Interface Layer (TS + Rust transport)**
   - Upstage primary adapters, fallback adapters, streaming and structured tool-call decoding.

5. **Embedding/Retrieval Layer (Rust)**
   - Chunking, embedding generation, ANN index, retrieval ranking, stale-index invalidation.

6. **Code Index Layer (Rust)**
   - File tree cache, symbol extraction, reference graph, git-aware change deltas.

7. **Execution Sandbox Layer (Rust + OS primitives)**
   - read-only/workspace-write/full access profiles, high-risk operation gates, timeout and resource controls.

## Language Architecture

## Rust Components

- Filesystem scanning (fast recursive traversal, ignore handling).
- Code indexing (symbols, references, dependency graph snapshots).
- Embedding ingestion pipeline and vector index serving.
- Terminal rendering performance and input handling.
- Tool execution, sandboxing, and persistent state.

## TypeScript Components

- Agent reasoning loop and policy logic.
- Tool routing and action selection.
- Model provider communication contracts.
- Context builder, summarizer, and token budget planner.
- Multi-agent role orchestration (planner/editor/reviewer lanes).

## Why this split is optimal

- Rust handles CPU/IO-critical and security-critical paths with predictable performance.
- TypeScript allows fast iteration on agent behavior and prompt policies.
- A strict JSON-RPC boundary prevents coupling and enables independent testing.

## CLI UI Design (Gemini-style)

## Required UX Features

- Interactive chat timeline with streaming tokens.
- Side-by-side code diff preview before apply.
- File tree and symbol jump panel.
- Command palette (`/commands`, fuzzy search).
- Session list/resume and checkpoint restore.
- Purple-forward theme system (brand direction), including high-contrast accessibility variant.

## Framework Evaluation

### Rust: ratatui vs tui-rs

- `tui-rs` is legacy lineage; `ratatui` is actively maintained and ecosystem-preferred.
- `ratatui` has better momentum for modern agent-style TUI patterns.

### TypeScript: ink vs blessed

- `ink` is React-friendly for quick component iteration.
- `blessed` is lower-level but less ergonomic for large maintainable UI trees.

## Chosen stack

- **Primary UI framework: `ratatui` (Rust).**

Rationale:

- Keeps critical render loop and event loop in Rust for large-output responsiveness.
- Aligns with Rust performance core objective.
- Avoids dual-runtime UI complexity while still allowing TS orchestration in a sidecar process.

## Agent System

## Options Evaluated

1. **LangGraph**
   - Pro: explicit graph orchestration and durable branching workflows.
   - Con: framework lock-in and increased debugging complexity for v1.

2. **Custom agent loop**
   - Pro: deterministic, minimal abstraction, easier replay testing.
   - Con: requires custom handling for advanced branching later.

3. **OpenAI-style function calling loop**
   - Pro: simple mental model and broad compatibility.
   - Con: can become opaque without strict state machine controls.

4. **Tool-first reasoning loop**
   - Pro: grounded observations reduce hallucinated edits.
   - Con: requires robust tool schema governance.

## Recommendation

- **V1: custom tool-first state machine loop.**
- **V2+: optional LangGraph integration** for explicit parallel branches and long-running multi-agent flows.

### Agent loop diagram

```text
User Input
   |
   v
[Observe]
   |  (gather prompt + context + policy)
   v
[Plan]
   |  (decide next step)
   +-----> [Model Action]
   |              |
   |              v
   |         [Tool Call?] --no--> [Respond]
   |              |
   |             yes
   |              v
   |        [Execute Tool]
   |              |
   v              v
[Observation Update + Budget Check]
   |
   +----> repeat until Done/NeedsUser/BudgetExceeded/Error
```

## Context System

Context sources:

1. User prompt and conversation state
2. Relevant files from search/symbol resolution
3. Current git diff and staged changes
4. Embedding-based retrieval notes

### Token management strategy

- Reserve 15% output tokens (minimum 2k when context allows).
- Input budget partition:
  - policy/system: 10%
  - recent turns: 20%
  - recent tool outputs: 20%
  - code/retrieval context: 50%
- Cap individual artifacts:
  - file chunk <= 2,000 tokens
  - tool output snippet <= 800 tokens
- Oversized artifacts are summarized into "compressed notes" while full output stays in local trace storage.

## Code Navigation (Repository Scale)

## Features

- File tree explorer with ignore-aware scanning.
- Lexical + semantic search.
- Symbol extraction and cross-reference graph.
- Embedding retrieval for semantic context.
- Git-aware recency boosting (changed files rank higher).

## Embedding strategy

### Primary

- Upstage embeddings as default index backend.

### Fallback

- Local embedding model for offline/degraded mode.

### Fallback policy

1. Try Upstage embedding API.
2. On rate-limit/network failure, switch to local embedding lane.
3. Mark retrieval mode in run metadata for transparency.
4. Backfill remote embeddings asynchronously when connectivity returns.

## Execution Sandbox

Profiles:

- `read-only`
- `workspace-write`
- `danger-full-access`

Guardrails:

- command risk scoring (delete/network/publish/git push high risk)
- explicit user confirmation for high-risk commands
- per-command timeout and max output
- environment secret redaction in logs

## RPC Contract (Rust <-> TypeScript)

Transport: JSON-RPC over stdio.

Core calls:

- `observe(state, events) -> decision`
- `execute_tool(call) -> result`
- `report_result(step, status, stop_reason)`

Stop reasons (required):

- `done`
- `needs_user_input`
- `budget_exhausted`
- `tool_error`
- `model_error`

## Verification Pipeline

- `verify` tool with profiles:
  - `fast`: format + lint + targeted tests
  - `full`: adds integration tests/build
- Policy: code-edit runs should invoke at least `fast` unless user explicitly opts out.
- Agent loop consumes verify results and can auto-fix before final response.

## Proposed Repository Structure

```text
upstage-cli/
  cli/                # Rust entrypoint, arg parsing, bootstrapping
  ui/                 # ratatui components, layout, theme, keymaps
  runtime/            # Rust runtime: session, logs, event bus
  sandbox/            # command sandboxing, risk policies, OS adapters
  tools/              # Rust tool host, registry, permission engine
  indexer/            # Rust file scanner, symbol graph, embeddings ingestion
  retriever/          # Rust ANN search + ranking
  agent/              # TypeScript orchestrator (plan/act/observe)
  model/              # TypeScript provider adapters (Upstage primary)
  protocol/           # Shared JSON schemas and versioned contracts
  config/             # config schema, migration, defaults
  docs/               # architecture, PRD, tools, runbooks
```

## Implementation Phases

1. **Phase 1 (MVP loop)**: custom state machine, core tools, Upstage model adapter.
2. **Phase 2 (repo scale)**: symbol index + embedding retrieval + diff-aware context.
3. **Phase 3 (hardening)**: sandbox profiles, replay tests, verify gating.
4. **Phase 4 (multi-agent)**: planner/editor/reviewer lanes and optional graph workflows.
