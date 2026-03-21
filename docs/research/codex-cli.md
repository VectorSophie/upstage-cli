# Codex CLI Architectural Analysis

## Scope

This document analyzes OpenAI Codex CLI with focus on editing workflow, diff model, prompting/reasoning strategy, architecture, and reusable patterns for `upstage-cli`.

Primary references:

- https://github.com/openai/codex
- https://raw.githubusercontent.com/openai/codex/main/codex-rs/README.md
- https://raw.githubusercontent.com/openai/codex/main/docs/install.md
- https://developers.openai.com/codex

## Language and Runtime Architecture

- Codex CLI is now primarily Rust (repo language stats heavily Rust).
- Repository contains both legacy and current surfaces (`codex-cli` and `codex-rs`), with Rust implementation as maintained default.
- Rust workspace split by function:
  - `core/`: business logic
  - `exec/`: headless automation mode
  - `tui/`: fullscreen ratatui interface
  - `cli/`: multi-tool command surface

## Code Editing Workflow

Codex workflow is harness-like:

1. Receive user goal.
2. Explore code with read/search tools.
3. Produce edits via patch/apply operations.
4. Optionally run commands/tests in sandbox.
5. Iterate until completion criteria.

### Why this workflow works

- It keeps edits auditable and recoverable.
- The loop is local-first, reducing cloud-side state coupling.
- Headless mode (`codex exec`) allows the same core loop in CI.

## Diff Generation Model

Observed design emphasizes patch-oriented edits:

- Agent proposes deterministic file changes (not purely conversational output).
- Sandboxed execution validates effects before broader trust.
- Structured tool calls constrain edit semantics.

Reusable principle: treat code modification as a first-class operation with typed input/output contracts, not free-text advice.

## Prompt Format and Reasoning Strategy

Codex behavior strongly indicates policy-constrained reasoning:

- Task framing + tool contracts + safety boundaries.
- Iterative observation-action cycles (tool output drives next reasoning step).
- Model is optimized for long-running correction loops (retry, refine, verify).

Practical pattern for `upstage-cli`:

- Separate "plan tokens" from "execution tokens" and attach stop reasons to every run (`done`, `needs_input`, `budget_exhausted`, `tool_error`).

## Tooling and Sandboxing

Codex Rust CLI includes explicit sandbox controls:

- `--sandbox read-only`
- `--sandbox workspace-write`
- `--sandbox danger-full-access`

Also exposes explicit sandbox test subcommands by OS.

### Design implications

- Sandbox policy should be selectable and visible in status line.
- Risky actions require explicit user confirmation, independent of model confidence.

## Authentication

- Supports ChatGPT account sign-in flow and API key mode.
- Dual-path auth supports both consumer and developer workflows.

Pattern to reuse:

- `login` UX plus key-based non-interactive fallback for CI.

## Terminal UI Approach

- Fullscreen TUI built with Ratatui.
- Notifications and platform-specific behavior tuned for local UX (including WSL behavior notes in docs).

## Codebase Navigation

Codex architecture indicates repository-scale navigation via tool calls and iterative retrieval, not full-file dumping. Combined with sandbox and model loop constraints, this allows controlled large-repo operation.

## Reusable Patterns for upstage-cli

1. Rust-first core for reliability and distribution.
2. Headless + interactive modes over same orchestration primitives.
3. Explicit sandbox policies and stop reasons.
4. Typed patch/apply workflow with verification hooks.

## Gaps to avoid copying blindly

- Tight coupling to a single-provider model stack limits portability.
- Extensive native complexity requires strict boundary docs to keep contributions approachable.
