# Changelog

All notable changes to upstage-cli are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).

## [Unreleased]
### Added
- **CI now publishes to npm on tag push** (`.github/workflows/release.yml`'s
  new `publish-npm` job, `npm publish --access public` authenticated via
  the `NPM_TOKEN` repo secret). Previously a tag only produced a GitHub
  Release + binaries (see 3.0.0 below) — the npm package itself had to be
  published manually and, in practice, wasn't since 2.5.0.

## [3.0.0] - 2026-08-19
### Added
- **Standalone executables — no Node or Bun install required.** Every tagged
  release now builds and attaches self-contained `upstage` binaries for
  linux-x64, linux-arm64, darwin-x64, darwin-arm64, and windows-x64 (`bun
  build --compile`, one real runner per platform in `.github/workflows/
  release.yml` — `@opentui/core`'s native rendering core ships a separate
  prebuilt addon per OS/arch, resolved at runtime, so this can't be
  cross-compiled from a single host). Each release asset is a
  `upstage-<platform>-<arch>.tar.gz`/`.zip` bundling the binary with
  `skills/` and the tree-sitter `.wasm` grammars alongside it — both are
  normally resolved relative to the installed npm package on disk, which
  doesn't exist inside a single-file compiled executable, so the binary
  ships its own copies and the loaders now also check next to
  `process.execPath` for them (`src/skills/loader.mjs`,
  `src/indexer/parsers/adapter.mjs`). `scripts/install.sh` — the
  `curl -fsSL .../install.sh | bash` one-liner (macOS/Linux) — downloads
  the right asset from the latest release, extracts it, and symlinks
  `upstage` onto `PATH`. See `scripts/package-binary.mjs` for the packaging
  logic and rationale.
### Fixed
- **Real tree-sitter symbol search was silently dead for every real user.**
  `src/indexer/parsers/adapter.mjs` resolved its `.wasm` grammar files
  relative to `process.cwd()` — the directory the *target* project lives
  in, not where upstage-cli itself (and its own `tree-sitter-*`
  dependencies) is installed. It only ever worked by coincidence when
  running from inside this repo's own checkout; every other project fell
  back to regex-based symbol extraction with no indication anything had
  degraded. Now resolves via `import.meta.resolve` against the package
  install location instead. Found while verifying standalone-executable
  packaging (`bun build --compile`), fixed as a general correctness bug —
  it predates this release and isn't specific to compiled binaries. New
  regression test: `tests/m32-treesitter-adapter.test.mjs`.
- **`web-tree-sitter` pinned to `0.25.10`** (was `^0.26.7`) to match
  `@opentui/core`'s exact peer dependency — the version skew meant
  OpenTUI's own internal tree-sitter usage referenced a `.wasm` filename
  that only exists in the older release, which is harmless under normal
  `bun run` (that code path is unreachable — this project's Markdown
  rendering stayed hand-rolled, never adopted OpenTUI's `Code` component)
  but broke `bun build --compile`'s static bundling outright.
- **i18n locale loading now survives single-file compilation.** Switched
  `src/i18n/index.mjs` from `fs.readFileSync` against `__dirname` to static
  `import ... with { type: "json" }` for the two locale files — the former
  resolved to nothing inside a compiled binary's virtual filesystem
  (`$bunfs/root/...`), crashing every invocation; the latter gets the JSON
  bundled directly into the executable, working identically in dev/npm/
  compiled modes with less code.
- Dead-code pass: removed an unreferenced `fireHook`/`summarizeContext`
  helper pair in `src/tools/registry.mjs` (superseded by inline hook
  firing), unused imports across `src/cli/index.mjs`,
  `src/agents/loader.mjs`, `src/permissions/checker.mjs`,
  `src/tools/builtin/{glob,grep}.mjs`, and four test files. Fixed
  `eslint.config.mjs` two ways: `caughtErrorsIgnorePattern` now covers the
  codebase's existing `catch (_e)` convention (previously only
  `args`/`varsIgnorePattern` respected the `_` prefix, so every intentional
  `catch (_e)` still warned), and `ecmaVersion` bumped to `"latest"` (import
  attributes syntax needs newer-than-2024). Lint is now 0 warnings, 0
  errors (was 35 warnings, invisible in normal `npm run lint | tail`
  usage).
- **MCP `CLIENT_INFO`/`SERVER_INFO` version drift.** `src/tools/mcp/
  {http-client,stdio-client}.mjs` and `src/mcp/upstage-server.mjs` each
  hardcoded their own `version: "2.6.1"` string, independent of
  `package.json`'s actual version and of each other. Now import
  `package.json`'s `version` directly (`with { type: "json" }`) so this
  can't drift again.

### Changed
- **TUI rewritten on OpenTUI, runtime switched to Bun.** Replaced the Ink/React
  terminal UI with [OpenTUI](https://opentui.com) (`@opentui/core` +
  `@opentui/react`) — the same engine opencode ships on — for a native Zig
  rendering core instead of Ink's JS-based layout. This moves the CLI's
  runtime requirement from `node >=20` to `bun >=1.3` (`engines` updated;
  `bin` shebangs now `#!/usr/bin/env bun`). `npm install -g` still works,
  it just needs `bun` on `PATH`. Business-logic tests/lint/check stay on
  Node (`npm test`); new UI render tests run under `bun test` (`npm run
  test:ui`), since they need the native renderer. Full event coverage: the
  new event-consumption layer handles all 20 `AgentEventType` values with an
  exhaustive switch + fallback (the old TUI silently dropped 12 of them,
  including `critic`/`replan`/`verify_start`/`compaction`, which now surface
  in the activity feed). `stream-batcher.mjs` and `input-history.mjs` —
  written and tested previously but never wired in — are now live (token
  batching, composer ↑/↓ recall). Deleted the dead legacy ANSI TUI renderer
  and a duplicate command-palette registry.
- **MCP client/server bumped to the 2026-07-28 protocol version** (was
  `2024-11-05`, the original spec release). `HttpMcpClient`/`StdioMcpClient`
  (`src/tools/mcp/`) now offer this as their `initialize` request's
  `protocolVersion`; a server that only understands an older version still
  gets a working connection, since our HTTP client already adopts whatever
  version the server negotiates back (`initResult.protocolVersion`) rather
  than assuming its own offer was accepted. Our own bundled MCP server
  (`src/mcp/upstage-server.mjs`) now states the same version. Doesn't (yet)
  implement the 2026-07-28 rewrite's fully stateless model (per-request
  `_meta` identity, MRTR, `Mcp-Method`/`Mcp-Name` routing) — that's a bigger
  redesign of `http-client.mjs`'s session handling, tracked separately; this
  is the low-risk "stop offering a two-year-stale version string" fix.
  See `docs/new-concepts-aug2026-pt2.md` §0.
### Added
- **Solar Pro2 `reasoning_effort` switch** — exposes the model's own hybrid
  reasoning toggle (`auto`/`low`/`high`, cycled with **Ctrl+E** or clicking the
  new status-bar chip). `"high"` makes Solar Pro2 reason step-by-step with
  verification (per Upstage's own Solar Pro2 Prompting Handbook); `"low"` skips
  that for simple tasks. Wired through `UpstageAdapter`/`ModelRouter`;
  `"auto"` omits the field and lets the model pick its own default.
- **`check_groundedness` tool** — real hallucination check via Upstage's
  Groundedness Check API (`solar-1-mini-answer-verification`), not the model
  critiquing itself. Verify a claim is actually supported by its source
  context before presenting it.
- **`read_document` tool** — reads scanned/photographed PDFs and images via
  Upstage Document AI (OCR + Layout Analysis), for inputs `read_file` can't
  handle: design specs, scanned contracts, whiteboard photos, screenshots.
- **`semantic_search` tool** — ranks gathered text candidates by relevance
  using Solar's Korean-optimized embeddings, for queries keyword/grep search
  misses (paraphrasing, Korean identifiers, synonym mismatch).
- **Korean PII guardrail** — detects 주민등록번호/사업자등록번호 (resident &
  business registration numbers, real checksum-validated, not just shape
  match) plus card numbers and phone numbers in write/network tool calls,
  forcing a confirmation gate with a distinct **PIPA** warning when personal
  data is about to leave the machine over the network (`src/permissions/
  korean-pii-check.mjs`, wired into `PolicyEngine`).
- **Cost budget guardrail** — `maxCostUsd` hard-stops a turn when actual USD
  spend crosses the cap (default $5), alongside the existing tool-call/
  wall-time budgets. Previously the only cost-adjacent guardrail was a
  context-window *warning* that never actually stopped anything.
- **`AGENTS.md` interop** — falls back to the Linux-Foundation-stewarded
  `AGENTS.md` convention (read by 30+ agents) when a directory has no
  `UPSTAGE.md`; `UPSTAGE.md` stays primary.
- **Session forking (`/branch`, `/branch list`)** — fork the current session
  at any point into an independently-resumable branch that starts from a copy
  of the conversation so far (`forkSession()` in `src/runtime/session.mjs`).
- **Watch mode (`/watch`, `/unwatch`)** — drop a `// ai! <instruction>` or
  `# ai? <question>` comment in a file you're editing and save; the agent
  picks it up automatically (`src/core/watch-mode.mjs`), Aider's own
  file-comment-trigger convention. Watches each project directory
  individually rather than one recursive call on the repo root, which blocks
  on any tree with `node_modules` under it.
- **Recipes (`/recipe save|run|list`)** — named, parameterized prompt
  templates (`{{param}}` substitution) persisted under `.upstage/recipes/`,
  a natural extension of `/spec`'s spec-driven-memory direction.
- **Inline checkpoint undo** — a clickable "↺ undo" next to any diff in the
  chat pane reverts that specific file via the existing `/rewind` mechanism,
  without needing the separate text command.
- Stronger Korean system-prompt guidance: keep standard dev terms in English
  rather than switching turn to turn, hold a consistent professional register
  (합쇼체/하십시오체), plus MUST/NEVER-style emphasis on the two
  non-negotiable constraints (verify before claiming, never fabricate) —
  repeated at both the start and end of a long system prompt, per Solar
  Pro2's own prompting handbook.
- **IDE bridge (`upstage-bridge`)** — bidirectional NDJSON-over-stdio protocol so
  an editor extension can drive the agent (initialize/prompt/cancel/ping; streams
  every agent event tagged by prompt id, ends with a result). Testable protocol
  core (`src/bridge/bridge-server.mjs`) + real entrypoint. See `docs/ide-bridge.md`.
- **`run_subagent({ isolate: true })`** — run a delegated subagent on an isolated
  git worktree/branch; writes stay confined to the worktree, its diff is returned,
  and it's always cleaned up. Enables safe parallel subagent edits.
- **Claude-compatible hooks** — command hooks now use the Claude contract (event
  JSON on stdin, exit 2 blocks, stdout JSON decision). New lifecycle events wired
  in: `UserPromptSubmit` (block/inject context), `PreCompact` (veto compaction),
  `SessionEnd`, `SubagentStop`. (`src/hooks/engine.mjs`)
- **`/rewind`** — list and restore the on-disk file checkpoints (revert a file to
  its pre-edit content, or delete it if it was new). (`src/core/rewind.mjs`)
- **`.claude-plugin` PluginLoader** — discover Claude-compatible plugins under
  `.claude/plugins`/`.upstage/plugins` and merge their commands/agents/skills/
  hooks/`.mcp.json` at startup. (`src/plugins/loader.mjs`)
- **`@file` mentions** — `@path` tokens in a prompt inject file contents (confined
  to cwd, 64KB cap). (`src/agent/file-mentions.mjs`)
- **TUI**: composer slash-command autocomplete strip, **Tab** to accept,
  **shift+tab** permission-mode cycling (default → accept edits → plan), and a
  responsive logo (full ASCII on large terminals, compact wordmark when cramped).
  Backed by tested pure-logic modules (autocomplete, input-history, mode-cycle,
  stream-batcher, responsive-logo).
- **Git-worktree isolation** (`src/core/worktree.mjs`) — run work on an isolated
  checkout/branch and collect its diff; foundation for safe parallel subagents.
- **`/spec`** — persist feature specs into `UPSTAGE.md`'s `## Specs` section
  (auto-merged into the system prompt) for spec-driven memory. (`src/core/spec.mjs`)
- **MCP Streamable-HTTP transport (`src/tools/mcp/http-client.mjs`)** — connect to
  remote MCP servers, not just local stdio. Implements the current Streamable HTTP
  transport (MCP spec 2025-03-26+): single-endpoint JSON-RPC over POST, responses
  as JSON *or* SSE, `Mcp-Session-Id` propagation, `MCP-Protocol-Version` header,
  and session teardown via HTTP DELETE. `.mcp.json` `url` entries now connect
  (`{ "<name>": { "url": "https://host/mcp", "headers": {...} } }`) instead of
  being skipped. Verified live against `@modelcontextprotocol/server-everything`
  in `streamableHttp` mode. Tests: `tests/m19-mcp-http.test.mjs`.
- **Real MCP client (`src/tools/mcp/stdio-client.mjs`)** — a genuine JSON-RPC 2.0
  client over the MCP stdio transport (initialize handshake +
  `notifications/initialized`, `tools/list`, `tools/call`, id correlation,
  per-request timeouts, isolated failure). Replaces the previous in-memory stub:
  upstage-cli can now **consume the real MCP ecosystem**. Verified live against
  `@modelcontextprotocol/server-everything` (13 tools, `echo` round-trip).
- **Claude-compatible `.mcp.json` config** (`src/tools/mcp/config.mjs`) — reads
  `{ "mcpServers": { name: { command, args, env } } }` from project `.mcp.json`
  and `settings.mcpServers`, connects each stdio server at CLI startup, and
  registers their tools (`<server>__<tool>`). Remote `url`/`http`/`sse` entries
  are recognized and skipped with a warning (stdio-only for now). A failing
  server is logged and skipped, never fatal. Legacy `UPSTAGE_MCP_SERVERS_MODULE`
  still works. Tests: `tests/m18-mcp-client.test.mjs` (offline mock fixture).
- **MCP server (`src/mcp/upstage-server.mjs`, `upstage-mcp` bin)** — exposes the
  Solar agent as a delegatable subagent over standard MCP stdio (initialize /
  tools/list / tools/call). Two tools: `upstage_delegate` (read/write/test/
  self-correct, confined to `cwd`) and `upstage_ask` (read-only). Wireable into
  Claude Code via `.mcp.json`; see `docs/claude-code-integration.md`.
- `scripts/mcp-smoke.mjs` manual smoke client; `tests/m17-mcp-server.test.mjs`
  protocol-contract tests (no API key required).

- **Skills catalog wired live (`docs/skills-research-aug2026.md`)** — the
  previously-built-but-never-connected `SkillsLoader`/`SkillRunner`
  (`src/skills/`) is now actually reachable: a name+description catalog of
  every discovered skill is folded into the system prompt each turn (cheap,
  ~50-100 tokens/skill), a new `load_skill` tool lets the model pull a
  skill's full instructions autonomously once a task matches one, and
  typing `/skill-name args` (unrecognized as a builtin command) now falls
  through to run a matching skill manually, the same way `/recipe run`
  does. `SkillsLoader` gained two new search sources beyond
  `.upstage/skills/`: a package-bundled first-party pack (`skills/` at the
  repo root, sibling to `src/`, always available regardless of cwd — same
  relationship builtin tools have to the package root) and `.claude/skills/`
  interop, so any repo's existing Claude-Code-format skills — including
  third-party libraries like
  [NomaDamas/k-skill](https://github.com/NomaDamas/k-skill) — work here for
  free. Its frontmatter parser also gained block-scalar (`>`/`|`) support
  for descriptions long enough to wrap across lines. Ships three first-party
  skills filling the gap community Korean-skill libraries don't cover
  (dev-infrastructure, not consumer lifestyle automation):
  `korean-pii-guard`, `groundedness-check`, and `toss-payments-integration`.
  Tests: `tests/m31-skills.test.mjs`.
- **Skills are now tab-completable.** The composer's `/`-autocomplete only
  knew about built-in commands; loaded skills (bundled, project, or
  `.claude/skills/`) are now merged into the same suggestion list with their
  descriptions, so `/kt<Tab>` surfaces `/ktx-booking` the same way any
  built-in command would. `/skills` output now shows the `/<name>` form
  (matching how you actually invoke one) and its license tag.

### Fixed
- **TUI approval dialog received the wrong payload shape.** `registry.execute()`
  calls `context.confirm()` with a single object (`{ tool, args, risk, ... }`),
  matching what the non-interactive approval handlers already expected — but
  the TUI's `confirm` destructured it as `(tool, params)`, so every real call
  silently received the whole payload object as `tool` (compared against
  string tool names, always false) and `undefined` as `params`
  (`params.command`/`params.diff` would throw). Untested path, no prior repro;
  caught while wiring the Korean PII guardrail's confirmation details through
  the same payload (`src/ui/event-consumer.mjs`).
- **Windows: sandboxed `spawn` of `.cmd` shims** (`npm`, `npx`, …) failed with
  `ENOENT` because `shell: false` can't resolve them — broke the critic loop and
  `run_tests`. Now enables the shell only on `win32` (args are already validated
  against shell metacharacters).
- **`TOOL_LOG` runtime event was unregistered** in the event schema, so any tool
  emitting a log line (e.g. `run_tests` stderr) threw `Unsupported runtime event
  type` and crashed the run. Added it to the allowed set.

## [2.4.0] - 2026-04-27
### Added
- 7 new built-in tools: `glob`, `grep`, `delete_file`, `rename_file`, `multi_edit`, `web_fetch`, `web_search`
- `read_file` now accepts `offset` and `limit` params for reading slices of large files
- `web_search` uses Tavily API (`TAVILY_API_KEY`); returns content snippets and AI-synthesized answer
- `grep` uses ripgrep when available, falls back to JS regex scan
- `glob` supports full `**` patterns with configurable root and maxResults
- Total built-in tools: 24 → 30

## [2.3.0] - 2026-04-27
### Added (harness Phase D)
- `ReplayEngine`: replay recorded agent runs without calling the live model; detects tool divergences
- MCP stdio server with 8 harness tools (filesystem/read/write/list, shell/run, git/diff/status, test/run, static_analysis/run)
- 6 context injection strategies: default, full-repo, failing-test, recent-diffs, retrieval, symbol-graph
- Human review: 5-dimension (1–5) scoring saved back to run artifact
- HTML dashboard: dark-theme multi-run table with SVG sparkline trend charts
- `harness replay` and `harness review` CLI commands
- Tests: 135 passing (h1–h5, h7–h9)

## [2.2.0] - 2026-04-27
### Added (harness Phase C)
- `DockerSandbox`: 3-tier layered image cache, bind-mount workspace, `--network none`
- `NativeSandbox`: thin wrapper over existing `src/sandbox/exec.mjs`
- `selectSandbox()`: auto-detects Docker availability, falls back to native gracefully
- `SafetyGuardrails`: 5 detection categories (secret exfiltration, destructive commands, dependency confusion, prompt injection, privilege escalation)
- `SKIP_DOCKER=1` env gate for CI environments without Docker

## [2.1.0] - 2026-04-27
### Added (harness Phase B)
- `AgentRegistry`: discover and instantiate adapters by id
- External subprocess adapters: `ClaudeCodeAgent`, `AiderAgent`, `OpenCodeAgent`
- `comparisonTable()`: 10-column Markdown side-by-side diff of two agent runs
- `harness compare` command with `--parallel` flag

## [2.0.0] - 2026-04-27
### Added (harness Phase A)
- Evaluation harness (`harness/`) — zero modifications to `src/`
- Task spec format (YAML with `_import` composition, SWE-bench FAIL_TO_PASS + PASS_TO_PASS split)
- `TaskRunner`: 12-step orchestration (validate → copy fixture → git init → baseline → agent → checks → score → diff → taxonomy → persist)
- 5-component weighted scoring formula (checks 60%, patchMinimality 15%, toolCallCount 10%, costUsd 10%, speedMs 5%)
- 5-dimension failure taxonomy (12 root-cause symptoms, deterministic detection)
- `MockAgent`: applies fixture patches from `README.fixture.md`, usable with no API key
- `UpstageAgent`: wraps existing `runAgentLoop` / `collectAgentLoop`
- `PatchTracker`, `AuditLog`, `CostTracker` tracking subsystem
- Reports: Markdown, JSON, SWE-bench JSONL predictions
- Fixtures: `missing-import`, `flaky-test`, `security-bug`
- `harness run`, `harness report` CLI commands
- `pass@k` unbiased estimator

## [1.9.0] - 2026-04-27
### Added
- ContextManager + CheckpointManager with auto-compaction at 80% token usage
- Slash command registry and markdown renderer
- TUI redesign: compact ✦✧ logo, vim-modal navigation, sidebar tabs

## [1.4.1] - 2026-04-27
### Added
- CI harness: GitHub Actions (ci.yml, release.yml), ESLint flat config, c8 coverage, smoke test
- `npm run lint`, `npm run smoke`, `npm run ci` scripts

## [1.4.0] - 2026-04-27
### Added
- 6 permission modes: default, bypassPermissions, acceptEdits, auto, dontAsk, plan
- Shell injection detection in permission checker
- Write-path validation (restricts edits to `process.cwd()`)
- `SECURITY_OVERRIDE=true` env bypass for development

## [1.3.0] - 2026-04-26
### Added
- 5-layer settings cascade: global → project → local → env → CLI flags
- `UPSTAGE.md` project context loader (analogous to CLAUDE.md)
- `loadSettings()` with `deepMerge` for nested config

## [1.2.0] - 2026-04-25
### Changed
- Rewrote agent loop as `async function*` (typed event generator)
- All consumers (TUI, CLI) now receive a unified event stream
- New event types: `stream_token`, `tool_start`, `tool_result`, `thinking`, `patch_preview`, `token_usage`, `system_warning`, `compaction`

## [1.1.0] - 2026-04-24
### Changed
- Removed Babel build step — all source is `.mjs` ESM, zero build
- `node src/cli/index.mjs` runs directly

## [1.0.0] - 2026-04-23
### Added
- Multi-pane Ink/React TUI (chat + sidebar + status bar)
- Solar Pro2 adapter with streaming SSE
- Tool registry with 17 built-in tools (read, write, exec, intel, github)
- Session persistence (`~/.upstage-cli/sessions/`)
- Korean-first i18n (KO/EN)
- Policy engine with risk-based action classes
- Hook system (BeforeAgent, BeforeTool, AfterTool, etc.)
- MCP client integration
- Subagent support via `run_subagent` tool
