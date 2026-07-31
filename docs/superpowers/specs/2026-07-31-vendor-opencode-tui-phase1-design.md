# Phase 1: Vendor opencode's TUI — runtime + shell spike

## Context

The current TUI (`src/ui/`, React + Ink) was built as a demo-quality surface. We're
moving upstage-cli to "actual tool" level by replacing it with opencode's TUI
(`anomalyco/opencode`, MIT-licensed), matched to its real look and behavior rather
than a reimplementation in our own stack.

This is a multi-phase project (see decomposition below). This spec covers **only
Phase 1**: prove the toolchain and get the vendored TUI rendering standalone in
this repo, disconnected from our agent. Phases 2–4 get their own specs once
Phase 1 lands.

**Full decomposition:**
1. **Runtime + shell spike (this spec)** — Bun toolchain, forked TUI source
   compiles and renders in this repo.
2. **Protocol adapter** — a Node HTTP+SSE server implementing enough of
   opencode's API surface (session create, message send, `GlobalEvent` stream)
   to back the TUI, wrapping our existing `src/agent/loop.mjs` instead of
   opencode's own engine.
3. **Feature parity** — sessions, hooks, MCP config, plugin loader, i18n,
   checkpoints/`/rewind`, approval flow ported onto the vendored TUI.
4. **Cutover** — retire `src/ui/` (Ink/React), update `bin` scripts, install
   docs, and CI for Bun.

## Key facts established

- `@opentui/core`'s native renderer requires Bun's FFI to call its Zig core.
  Node support is experimental (Node ≥26.4 with FFI flags) and not viable for
  a stable install story. **Bun becomes a hard runtime requirement.**
- `@opencode-ai/tui` and `@opencode-ai/core` are private workspace packages —
  not on the npm registry. The TUI source must be **forked (copied) into this
  repo**, not installed.
- `@opencode-ai/sdk`, `@opencode-ai/ui`, `@opencode-ai/plugin`, `@opentui/core`,
  `@opentui/solid` **are** published npm packages (all at matching versions,
  e.g. `1.18.10` / `0.4.5`) — installable as real dependencies.
- The TUI's only import from `@opencode-ai/core` (seen in `context/sdk.tsx`) is
  a trivial flag utility — it does not embed opencode's agent engine. The TUI
  is a pure HTTP+SSE client (`createOpencodeClient({ baseUrl })` +
  `GlobalEvent` stream), which is what makes Phase 2 an adapter, not a fork of
  their agent core.

## Scope of this phase

**In scope:**
- Add Bun as a required runtime alongside the existing Node toolchain (Node
  stays for the agent core/CLI entry until Phase 4 cutover — both runtimes
  coexist during the migration).
- Copy `packages/tui/src/**` from `anomalyco/opencode` into a new
  `vendor/opencode-tui/` directory in this repo, preserving its internal
  structure and attributing the source (LICENSE + upstream commit SHA noted in
  a README).
- Install its published dependencies (`@opentui/core`, `@opentui/solid`,
  `@opencode-ai/sdk`, `@opencode-ai/ui`, `@opencode-ai/plugin`, `solid-js`,
  `fuzzysort`, `remeda`, `effect`, `strip-ansi`, `clipboardy`, `diff`) via Bun.
- Get it running with `bun run` against opencode's own public demo/staging
  server (or any reachable opencode-compatible backend) purely to confirm the
  fork renders and behaves correctly in our repo, under our terminal/OS
  targets (Windows PowerShell + git-bash, per this project's dev environment).
- A `package.json` script (e.g. `npm run tui:opencode` / `bun run tui:opencode`)
  to launch it, documented as experimental/behind-the-scenes — not wired into
  the default `upstage` bin yet.

**Out of scope (later phases):**
- Any wiring to our agent loop, Solar adapter, sessions, or tools.
- Removing or touching the existing Ink TUI (`src/ui/`) — it keeps working as
  the default `upstage` entry point until Phase 4.
- Theming/rebranding the vendored TUI to our palette/logo — that's a
  find-and-adjust pass once we own the fork and know it renders correctly.

## Why this scoping

Ponytail-lazy but correct: the biggest unknowns (does Bun+opentui actually
render on this project's target platforms? is the TUI really backend-agnostic
enough to adapt?) get resolved with the smallest possible slice — a forked,
running shell — before spending effort on the protocol adapter or feature
parity. If Phase 1 reveals rendering problems (e.g. Windows terminal
incompatibilities in `@opentui/core`'s Zig renderer, which is a real risk not
yet verified), that's cheap to discover now and expensive to discover after
Phase 2/3 work is built on top.

## Testing

- One smoke check: `bun run tui:opencode` launches without crashing and
  renders the opencode shell (logo, empty session view) in both PowerShell and
  git-bash on Windows — the two shells this project's dev environment uses.
  No unit tests for vendored upstream code; our existing test suite
  (`npm test`) is untouched since nothing in `src/` changes yet.
- Document the upstream commit SHA vendored, so future updates/diffs against
  upstream are traceable.

## Risks called out explicitly

- **Windows rendering risk**: `@opentui/core`'s native Zig renderer's Windows
  terminal support is unverified as of this writing. If Phase 1 shows it's
  broken or degraded on Windows (this project's primary dev platform per the
  environment), that's a go/no-go signal for the whole vendoring plan, not
  just a bug to fix later.
- **Two-runtime period**: Node (agent core) and Bun (TUI shell) coexist from
  Phase 1 through Phase 3. This is intentional — full cutover to Bun-only only
  happens in Phase 4, after the adapter and feature parity are proven.
