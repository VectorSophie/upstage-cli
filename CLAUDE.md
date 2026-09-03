# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
# Run the CLI interactively (requires Bun — the TUI's native renderer needs it)
npm run dev
# or: bun src/cli/index.mjs

# Run tests (uses Node.js built-in test runner, no Jest)
npm test

# Run a single test file
node --test tests/m10-ui-input-routing.test.mjs

# TUI render tests — need the Bun-native renderer, run separately
npm run test:ui

# Syntax check (no bundler/compiler needed — zero build step)
npm run check
```

There is no build step. All source is `.mjs` ESM. The CLI itself runs on
**Bun** (`engines.bun >=1.3.0`, `bin` shebangs are `#!/usr/bin/env bun`) —
business-logic tests/lint/check still run under Node, since they have no
Bun/native-renderer dependency.

## Environment

- `UPSTAGE_API_KEY` — required to call the model (without it, the mock planner runs)
- `SECURITY_OVERRIDE=true` — bypass write-path restrictions (dev/testing only)
- Default model is `solar-pro4`; a per-model capability table (`src/model/model-capabilities.mjs`) drives context limits, `parallel_tool_calls`/`reasoning_effort` support, and structured-output support per model (`solar-pro2`/`solar-pro3`/`solar-pro4`), with a conservative Pro2-level fallback for unrecognized ids. Override with `-m`/`UPSTAGE_MODEL`. See `src/config/env.mjs`'s `ENV_SCHEMA` for the full list of `UPSTAGE_*` env vars (~27, covering retries/timeouts/logging/compaction/etc., most with sane defaults).

## Architecture

The codebase is a terminal-based agentic coding assistant. A single CLI invocation routes to either an interactive TUI or a non-interactive one-shot prompt.

### Request flow

```
src/cli/index.mjs           (arg parsing, session load, registry init)
  → src/agent/loop.mjs      (async generator state machine: IDLE→PLANNING→ACTING→OBSERVING/VERIFYING→DONE, plus AWAITING_USER/FAIL)
      → src/model/upstage-adapter.mjs    (Solar API, streaming — model-aware via model-capabilities.mjs)
      → src/tools/registry.mjs           (tool lookup, policy check, execution)
      → src/core/events/bus.mjs          (audit-trail event bus)
  → src/ui/App.mjs (TUI) OR stdout (ask mode)
```

### Agent loop as async generator

`loop.mjs` is an `async function*` that yields typed `AgentEvent` objects (`stream_token`, `tool_start`, `tool_result`, `thinking`, `patch_preview`, `token_usage`, …, 20 types total per `src/protocol/events.mjs`). Both the OpenTUI TUI and the plain CLI consume the same generator — the TUI re-renders on each yield, the CLI handler prints each event. This is the core architectural pattern: production of events is decoupled from consumption.

### Tool registry

`src/tools/registry.mjs` is the single hub for all tools. Three sources feed it:

- **Builtin** (`src/tools/builtin/`) — 36 core tools spanning file I/O, search/navigation, tree-sitter intelligence, execution, web, GitHub, Korean-market skills support (`load_skill`, `semantic_search`, `read_document`, `check_groundedness`), and subagent dispatch
- **Discovered** — external command outputs JSON tool specs at startup; tools are invoked via subprocess with base64-encoded payload
- **MCP** — Model Context Protocol servers loaded from `.mcp.json`, both stdio and Streamable HTTP transports, client and server directions both implemented

Every tool execution goes through: permission check → policy evaluation → `BeforeTool` hook → execution → `AfterTool` hook → event emission.

### Security layers

Two independent layers:

1. **Policy engine** (`src/core/policy/engine.mjs`) — risk-based rules per action class (`read / write / exec / network / git / publish`); high-risk ops require confirmation
2. **Path validator** (`src/permissions/path-check.mjs`) + **injection detector** (`src/permissions/injection-check.mjs`) — write ops restricted to `process.cwd()`; bash injection patterns blocked

Permission mode is one of six: `default`, `bypassPermissions`, `acceptEdits`, `auto`, `dontAsk`, `plan`.

### Settings cascade

`src/config/settings.mjs`'s `loadSettings()` deep-merges, in order (later overrides earlier):

1. `~/.upstage/settings.json` (global)
2. `./.upstage/settings.json` (project)
3. `./.upstage/settings.local.json` (project, local-only — gitignored by convention)
4. `applyEnvOverrides()` — `UPSTAGE_*` env vars (see `src/config/env.mjs`)
5. CLI flags

Session storage uses a separate root (`~/.upstage-cli/sessions/`, note the different directory name) — don't confuse the two.

### Session persistence

Sessions are stored as JSON under `~/.upstage-cli/sessions/`. Each session records `history`, `toolResults`, `appliedPatches`, and `runtimeEvents`. The agent uses these to resume multi-turn conversations and for audit replay.

### Context building

Before each model call, `src/agent/context-builder.mjs` extracts keywords from the prompt, queries the repo map, runs symbol/code search (tree-sitter), and injects the top file snippets into the system context. Token compaction triggers automatically when usage exceeds 80% of the session limit — it reduces snippet depth and conversation window without dropping history.

### Interactive TUI

Built with React + [OpenTUI](https://opentui.com) (`@opentui/core` + `@opentui/react`, `src/ui/`) — a native Zig rendering core, the same engine opencode ships on. Components are OpenTUI's lowercase JSX-intrinsic tags (`box`, `text`, `input`, `select`, `scrollbox`, `diff`, …), used via `React.createElement('box', ...)` — no JSX/Babel, consistent with the zero-build-step approach. The `App.mjs` component subscribes to agent events (via `event-consumer.mjs`) and re-renders on each yield. Layout: chat pane (left, a `scrollbox`) + sidebar with Plan / Context / Tools tabs (right). Composer supports external editor (`$EDITOR`, Ctrl+X). Navigation follows a vim-like modal model (Esc toggles). Runs under Bun — OpenTUI's native renderer requires it.

### Project context files

Any `UPSTAGE.md` files found by walking up from `cwd` are merged into the system prompt, letting projects customize agent behavior without code changes (analogous to `CLAUDE.md`).

## Key files

| File | Role |
|---|---|
| `src/cli/index.mjs` | Entry point, mode routing |
| `src/agent/loop.mjs` | Agent state machine (async generator) |
| `src/model/upstage-adapter.mjs` | Solar API adapter — streaming, retry, capability-gated request fields |
| `src/model/model-capabilities.mjs` | Per-model capability table (context limit, reasoning/parallel-tool-call/response-format support) |
| `src/tools/registry.mjs` | Tool hub — registration, policy, lifecycle |
| `src/core/policy/engine.mjs` | Risk-based policy evaluation |
| `src/core/events/bus.mjs` | Runtime event bus |
| `src/core/hooks/lifecycle.mjs` | BeforeAgent/BeforeTool/AfterTool hooks |
| `src/runtime/session.mjs` | Session load/save/prune |
| `src/config/settings.mjs` | Settings cascade loader |
| `src/permissions/checker.mjs` | Permission mode enforcement |
| `src/protocol/events.mjs` | `AgentEventType` enum — all event names |
| `tests/` | Node built-in test runner, `.test.mjs` files |
