# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
# Run the CLI interactively
npm run dev
# or: node src/cli/index.mjs

# Run tests (uses Node.js built-in test runner, no Jest)
npm test

# Run a single test file
node --test tests/policy-engine.test.mjs

# Syntax check (no bundler/compiler needed — zero build step)
npm run check
```

There is no build step. All source is `.mjs` ESM — Node runs it directly.

## Environment

- `UPSTAGE_API_KEY` — required to call the Solar Pro2 model (without it, the mock planner runs)
- `SECURITY_OVERRIDE=true` — bypass write-path restrictions (dev/testing only)

## Architecture

The codebase is a terminal-based agentic coding assistant. A single CLI invocation routes to either an interactive TUI or a non-interactive one-shot prompt.

### Request flow

```
src/cli/index.mjs           (arg parsing, session load, registry init)
  → src/agent/loop.mjs      (async generator state machine: IDLE→PLANNING→ACTING→OBSERVING→DONE)
      → src/model/upstage-adapter.mjs    (Solar Pro2 streaming API)
      → src/tools/registry.mjs           (tool lookup, policy check, execution)
      → src/core/events/bus.mjs          (audit-trail event bus)
  → src/ui/App.mjs (TUI) OR stdout (ask mode)
```

### Agent loop as async generator

`loop.mjs` is an `async function*` that yields typed `AgentEvent` objects (`stream_token`, `tool_start`, `tool_result`, `thinking`, `patch_preview`, `token_usage`, …). Both the React/Ink TUI and the plain CLI consume the same generator — the TUI re-renders on each yield, the CLI handler prints each event. This is the core architectural pattern: production of events is decoupled from consumption.

### Tool registry

`src/tools/registry.mjs` is the single hub for all tools. Three sources feed it:

- **Builtin** (`src/tools/builtin/`) — 17 core tools across `read`, `write`, `exec`, `intel`, `github` action classes
- **Discovered** — external command outputs JSON tool specs at startup; tools are invoked via subprocess with base64-encoded payload
- **MCP** — Model Context Protocol servers loaded from config

Every tool execution goes through: permission check → policy evaluation → `BeforeTool` hook → execution → `AfterTool` hook → event emission.

### Security layers

Two independent layers:

1. **Policy engine** (`src/core/policy/engine.mjs`) — risk-based rules per action class (`read / write / exec / network / git / publish`); high-risk ops require confirmation
2. **Path validator** (`src/permissions/path-check.mjs`) + **injection detector** (`src/permissions/injection-check.mjs`) — write ops restricted to `process.cwd()`; bash injection patterns blocked

Permission mode is one of six: `default`, `bypassPermissions`, `acceptEdits`, `auto`, `dontAsk`, `plan`.

### Settings cascade

Settings are merged in order (later overrides earlier):

1. `~/.upstage-cli/settings.json` (global)
2. `./.upstage.json` or `./.claude/settings.json` (project)
3. CLI flags

### Session persistence

Sessions are stored as JSON under `~/.upstage-cli/sessions/`. Each session records `history`, `toolResults`, `appliedPatches`, and `runtimeEvents`. The agent uses these to resume multi-turn conversations and for audit replay.

### Context building

Before each model call, `src/agent/context-builder.mjs` extracts keywords from the prompt, queries the repo map, runs symbol/code search (tree-sitter), and injects the top file snippets into the system context. Token compaction triggers automatically when usage exceeds 80% of the session limit — it reduces snippet depth and conversation window without dropping history.

### Interactive TUI

Built with React + Ink (`src/ui/`). The `App.mjs` component subscribes to agent events and re-renders on each yield. Layout: chat pane (left) + sidebar with Plan / Context / Tools tabs (right). Composer supports external editor (`$EDITOR`, Ctrl+X). Navigation follows a vim-like modal model (Esc toggles).

### Project context files

Any `UPSTAGE.md` files found by walking up from `cwd` are merged into the system prompt, letting projects customize agent behavior without code changes (analogous to `CLAUDE.md`).

## Key files

| File | Role |
|---|---|
| `src/cli/index.mjs` | Entry point, mode routing |
| `src/agent/loop.mjs` | Agent state machine (async generator) |
| `src/model/upstage-adapter.mjs` | Solar Pro2 API, streaming, retry |
| `src/tools/registry.mjs` | Tool hub — registration, policy, lifecycle |
| `src/core/policy/engine.mjs` | Risk-based policy evaluation |
| `src/core/events/bus.mjs` | Runtime event bus |
| `src/core/hooks/lifecycle.mjs` | BeforeAgent/BeforeTool/AfterTool hooks |
| `src/runtime/session.mjs` | Session load/save/prune |
| `src/config/settings.mjs` | Settings cascade loader |
| `src/permissions/checker.mjs` | Permission mode enforcement |
| `src/protocol/events.mjs` | `AgentEventType` enum — all event names |
| `tests/` | Node built-in test runner, `.test.mjs` files |
