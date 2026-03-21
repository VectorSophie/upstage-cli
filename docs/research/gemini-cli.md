# Gemini CLI Architectural Analysis

## Scope

This document analyzes Gemini CLI as an open-source terminal coding agent, with focus on architecture, UX, reasoning loop, tool system, editing model, and context strategy. It emphasizes reusable patterns for `upstage-cli`.

Primary references:

- https://github.com/google-gemini/gemini-cli
- https://raw.githubusercontent.com/google-gemini/gemini-cli/main/docs/reference/tools.md
- https://geminicli.com/docs/

## Language Choices

- Predominantly TypeScript/JavaScript (repo language stats show ~98% TypeScript).
- Packaged as Node CLI (`@google/gemini-cli`) with broad OS package paths (`npm`, Homebrew, MacPorts, Conda route).
- Uses a monorepo (`packages/`) to separate concerns (core tooling, CLI surfaces, integrations).

### Why this choice

- TypeScript provides fast iteration for a rapidly changing product surface (tools, auth options, UI behavior).
- JS ecosystem has mature terminal and MCP integration primitives.
- Monorepo packaging supports frequent releases and internal API evolution.

## Architecture

Observed from repository structure and docs:

- Multi-package architecture (`packages`, `schemas`, `integration-tests`, `docs`).
- Tool-centric core with explicit Tool Registry pattern documented in `tools.md`.
- Security policy layer in execution path (confirmation and sandbox/trusted folder gating).
- MCP as first-class extension channel.

Likely architectural decomposition (inferred from docs + file layout):

1. CLI shell and command parser
2. Agent runtime and loop manager
3. Tool registry and policy evaluator
4. Model adapter and streaming handler
5. Session persistence/checkpointing and config system

## CLI UX Design

Gemini CLI UX mirrors modern coding agents:

- Interactive chat in terminal with slash commands.
- Headless mode (`-p`) and structured outputs (`json`, `stream-json`) for automation.
- Command-driven discoverability (`/tools`, `/help`, custom commands).
- Prompt shortcuts: `@path` file include and `!command` shell execution.

### Reusable design patterns

- **Progressive disclosure**: easy default (`gemini`) plus advanced CLI modes.
- **Tool transparency**: user can inspect active tools and descriptions from inside the app.
- **Automation symmetry**: interactive and non-interactive modes share tooling primitives.

## Reasoning Loop

The documented behavior implies a tool-first deliberative loop:

1. Parse user intent.
2. Select internal or MCP tools as needed.
3. Request permission for mutating/execute actions.
4. Execute tool and capture observation.
5. Continue until completion or clarification.

Notable implementation signals:

- Built-in todo tracking tool (`write_todos`) indicates explicit plan/execution state.
- Plan-mode tools (`enter_plan_mode`, `exit_plan_mode`) indicate staged thinking before mutation.

## Tool Usage Model

Built-in tools are grouped by category and kind:

- File ops (`glob`, `grep_search`, `read_file`, `replace`, `write_file`)
- Execution (`run_shell_command`)
- Web (`google_web_search`, `web_fetch`)
- Planning/memory (`write_todos`, `save_memory`, skills)
- Interaction (`ask_user`)

### Security model

- Mutating tools and shell require explicit confirmation.
- Supports sandboxing and trusted folder boundaries.
- MCP tools inherit permissioning model.

## Code Editing Model

Gemini CLI supports direct file replacement and patch-like edits via tool APIs:

- `replace` for targeted edits.
- `write_file` for file creation/overwrite.
- Pre-execution diff/command previews before approval.

### Why this matters

- Editing model remains deterministic and auditable.
- Human approval boundaries reduce destructive changes.

## Context Management

Context comes from:

- User prompt and current session state
- Explicit file references (`@`)
- Tool outputs (read/search/shell/web)
- Persisted memory (`GEMINI.md`) and checkpointing

Token strategy clues:

- Token caching documentation and checkpointing suggest context compaction/reuse.
- Trusted folder + include-directories likely constrain context growth.

## Why Google likely chose this architecture

1. **Safety at scale**: explicit approval and policy layers are mandatory for broad user base.
2. **Extensibility**: MCP lets ecosystem evolve without core-only development.
3. **Operational ergonomics**: same agent works in local interactive mode and CI/scripted contexts.
4. **Documentation-first adoption**: deep in-product command and docs references reduce user friction.

## Reusable Patterns for upstage-cli

- Tool registry with typed metadata and permission class (`Read`, `Edit`, `Execute`, `Network`).
- Built-in plan mode before mutating actions.
- Native shorthand for context (`@`) and shell (`!`) to reduce prompt verbosity.
- Session checkpointing and resumability as first-class primitives.
- Trust zones: workspace write + optional sandbox profile selection.

## Cautions

- TypeScript-only architecture can become CPU-bound for very large code indexing tasks.
- Tool sprawl without strict interfaces can increase regression risk.
