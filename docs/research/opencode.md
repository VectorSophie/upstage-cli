# Opencode Architectural Analysis

## Scope

This document analyzes Opencode with emphasis on tool orchestration, agent loop, architecture, and feedback cycle design patterns relevant to `upstage-cli`.

Primary references:

- https://github.com/opencode-ai/opencode
- https://github.com/charmbracelet/crush (successor direction from archive notice)

## Language Choices

- Core implementation in Go (~99% Go in archived repository).
- TUI stack uses Bubble Tea ecosystem (as documented in README).
- SQLite-backed persistence for sessions/conversation state.

### Why this choice worked

- Go provides predictable CLI distribution, low runtime overhead, and easy static binaries.
- Bubble Tea gives responsive event-driven terminal UI with strong keyboard UX.

## High-Level Architecture

Repository declares a modular internal structure:

- `cmd`: command entrypoints
- `internal/app`: app services
- `internal/config`: config loading/validation
- `internal/db`: persistence and migrations
- `internal/llm`: provider integrations + tools
- `internal/tui`: terminal UI pages/components
- `internal/session`: session lifecycle
- `internal/lsp`: language-server integration

This is a classic layered CLI architecture:

1. Presentation (TUI/CLI)
2. Orchestration/service layer
3. Provider and tool adapters
4. Persistence and state

## Tool Orchestration

Documented built-in tools include:

- File primitives (`glob`, `grep`, `ls`, `view`, `write`, `edit`, `patch`)
- Execution (`bash`)
- Fetching/search (`fetch`, `sourcegraph`)
- Diagnostics (`diagnostics`)
- Subtask delegation (`agent`)

### Orchestration pattern

- The model can request tools; permission gates mediate execution.
- Tool results feed back into subsequent model turns.
- Tools are available in both interactive and prompt mode, preserving behavior consistency.

## Agent Loop and Feedback Cycle

Opencode demonstrates a recursive observe-act loop:

1. Model plans next action from user request + current context.
2. Chooses a tool invocation.
3. System executes tool and captures structured output.
4. Output is appended to conversation state.
5. Model re-reasons and decides next step.

The explicit `agent` tool enables delegated subtasks and fan-out behavior.

### Oracle/tool feedback loop (applied pattern)

Opencode upstream does not expose a branded "oracle" tier in its archived README, but its architecture supports the same pattern by combining:

- delegated sub-agent calls (`agent` tool),
- tool-grounded observations (`grep`, `view`, `diagnostics`, `bash`), and
- iterative re-planning after each observation.

For `upstage-cli`, this maps naturally to a three-lane strategy:

1. primary coder loop,
2. deep-review consultant lane (oracle-equivalent),
3. tool-observation reconciliation before final action.

### How tool outputs feed reasoning

- Outputs are treated as authoritative observations.
- Subsequent actions are grounded in new tool evidence (files read, grep matches, diagnostics, shell results).
- This reduces hallucinated code changes and supports iterative correction.

## Memory and Context Strategy

- Session persistence in SQLite enables continuity across app restarts.
- Auto-compaction summarizes long conversations near context limits (default behavior documented).
- Configurable data directory and multi-session switching support long-running work.

## Authentication and Provider Strategy

- Multi-provider environment variable model (`OPENAI_API_KEY`, `GEMINI_API_KEY`, `ANTHROPIC_API_KEY`, etc.).
- Structured provider config block supports flexible model routing and local endpoints.

## Codebase Navigation

- `glob`, `grep`, `view`, and diagnostics form core local navigation stack.
- LSP integration is implemented; diagnostics are exposed to AI directly.
- Current limitation in archived version: full LSP capabilities exist internally but only diagnostics surfaced to agent according to README.

## Terminal UI Approach

- Bubble Tea-based interactive TUI.
- Session picker, model selector, command palette style interactions.
- Keyboard-heavy operation with modal overlays and permission dialogs.

## Design Lessons for upstage-cli

### Strongly reusable

- **Modular internal packages by responsibility**.
- **Persistent sessions + auto-compaction**.
- **Uniform tool APIs across interactive/headless modes**.
- **Permission system around mutating actions**.

### Needs modernization when adopted

- Archived state indicates migration risk; borrow architecture, not code assumptions.
- Improve typed tool contracts and richer semantics for tool error classes.
- Expand LSP surface beyond diagnostics (definitions, references, rename).

## TypeScript and Rust Implications (for upstage-cli extraction)

Although archived Opencode itself is Go-centric, the extracted architecture pattern maps well to a hybrid implementation:

- **TypeScript orchestration** inherits Opencode's flexible agent/tool coordination style.
- **Rust performance components** replace Go in hotspots (indexing, retrieval, execution sandbox), while preserving Opencode's modular boundaries.

This preserves the strongest Opencode lesson (tool-first modularity) while achieving higher performance and stricter runtime safety where needed.

## Recommended extraction for upstage-cli

1. Keep Opencode-like tool ergonomics and keyboard UX philosophy.
2. Replace Go core with Rust for indexing/search performance-critical paths.
3. Keep orchestration in TypeScript with strict tool schemas and deterministic loop controls.
4. Preserve session database pattern, but define migration/versioning from day one.
