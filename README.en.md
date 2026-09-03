# ✦✧ upstage-cli

An agentic coding assistant powered by **Upstage Solar Pro4** — runs entirely in your terminal with a full TUI (OpenTUI, native-rendered on Bun), 36 built-in tools, MCP client/server support, and an evaluation harness for benchmarking agents on real coding tasks. A per-model capability table also supports `solar-pro3`/`solar-pro2`.

## Installation

**Standalone binary (macOS/Linux)** — no Node or Bun install required:

```bash
curl -fsSL https://raw.githubusercontent.com/VectorSophie/upstage-cli/master/scripts/install.sh | bash
```

Downloads the right `upstage-<platform>-<arch>` build from the [latest release](https://github.com/VectorSophie/upstage-cli/releases/latest) and installs it to `~/.local/bin`. **Windows**: download `upstage-windows-x64.zip` from the releases page and run `upstage.exe` directly.

**npm** (if you already have Node and don't mind a separate Bun install):

```bash
npm install -g @jackochesstern/upstage-cli
```

Requires **[Bun](https://bun.sh) ≥ 1.3** on `PATH` (the TUI runs on a Bun-native renderer) — the standalone binary above doesn't have this requirement, since Bun's runtime is compiled directly into it.

## Quick start

```bash
export UPSTAGE_API_KEY=your_key   # get one at console.upstage.ai

upstage                            # open the interactive TUI
upstage -p "fix the failing test"  # one-shot prompt and exit
upstage ask "summarize package.json"
```

## Environment variables

| Variable | Required | Description |
|---|---|---|
| `UPSTAGE_API_KEY` | Yes | Upstage API key — get one at [console.upstage.ai](https://console.upstage.ai) |
| `TAVILY_API_KEY` | No | Enables `web_search` — free key at [app.tavily.com](https://app.tavily.com) |
| `EDITOR` | No | External editor for `Ctrl+X` (default: `vim`) |
| `SECURITY_OVERRIDE` | No | Set `true` to bypass write-path restrictions (dev only) |
| `UPSTAGE_VERIFY_STAGES` | No | Comma-separated verification order, e.g. `run_linter,run_tests` |
| `UPSTAGE_DISCOVERY_COMMAND` | No | Command that prints discovered tool specs as JSON |
| `UPSTAGE_DISCOVERY_INVOKE_COMMAND` | No | Command to invoke discovered tools |
| `UPSTAGE_MCP_SERVERS_MODULE` | No | Path to a module exporting MCP server configs |

## CLI options

Run `upstage --help` for the authoritative list. As of this writing:

```
Usage: upstage [command] [options] [prompt]

Commands:
  chat              Interactive chat mode (default)
  ask               One-shot prompt mode
  tui               Fullscreen terminal UI

Options:
  -h, --help                Show this help
  -p, --prompt <text>       Run prompt and exit
  -m, --model <model>       Model to use (default: solar-pro4)
  --no-stream               Disable streaming
  --session <id>            Resume session by ID
  --new-session             Start a new session
  --reset-session           Reset and create new session
  --confirm-patches         Require confirmation for patches
  --bridge-json             Output JSON bridge format
  --permission-mode <mode>  Permission mode
  --system-prompt <text>    Override system prompt
  --cwd <dir>               Run as if launched from this directory (changes
                            process cwd before anything else loads)
  --add-dir <dir>           Additional directory for UPSTAGE.md
  --max-turns <n>           Maximum conversation turns
  --max-time <sec>          Wall-time budget in seconds (default: 180)
  --allowedTools <tools>    Comma-separated allowed tools
  --disallowedTools <tools> Comma-separated denied tools
  --lang <code>             Language (ko/en)
  -v, --verbose             Verbose output
  -d, --debug               Debug mode

Examples:
  upstage                        Start interactive REPL
  upstage -p "Fix bug in app"    Run prompt and exit
  upstage ask "Read package.json"
  upstage --lang en -p "hello"   English mode
```

## TUI layout

```
┌─ Chat (left) ──────────────────┐┌─ Sidebar (right) ──────────────┐
│                                ││ [ PLAN ] [ CONTEXT ] [ TOOLS ] │
│  Agent responses and diffs     ││                                 │
│  appear here in real time      ││ Active plan, repo map, tool log │
└────────────────────────────────┘└─────────────────────────────────┘
┌─ Status bar ───────────────────────────────────────────────────────┐
│  ✦✧  solar-pro4 · session-id · Tokens: N | Cost: $N | Lang: EN    │
└────────────────────────────────────────────────────────────────────┘
```

## Keyboard shortcuts

| Key | Action |
|-----|--------|
| `Tab` | Accept top autocomplete suggestion, or cycle focus (input → chat → sidebar) |
| `Shift+Tab` | Cycle permission mode |
| `Ctrl+X` | Open current input in `$EDITOR` |
| `Ctrl+E` | Cycle reasoning effort (low/auto/high) |
| `Ctrl+S` | Toggle session browser |
| `Ctrl+T` | Toggle repo map |
| `Ctrl+C` | Copy current selection |
| `Ctrl+R` | Clear screen |
| `Esc` | Clear selection, or enter navigation mode |
| `Esc` × 2 (within 500ms) | Rewind — undo last agent turn |
| `↑` / `↓` *(input focused)* | Recall previous prompts |
| `j` / `k` *(chat focused)* | Scroll down / up |
| `g` / `G` *(chat focused)* | Scroll to top / follow latest (sticky scroll) |
| `i` *(chat focused)* | Back to input focus |
| `p` / `c` / `t` *(sidebar focused)* | Switch to Plan / Context / Tools tab |

## Slash commands

36 commands total. Run `/help` in-app for the current list; grouped here by purpose:

| Group | Commands |
|-------|----------|
| Session | `/new`, `/sessions`, `/branch [list]` (fork session), `/undo`, `/rewind` |
| Context | `/compact`, `/forget`, `/memory`, `/tree` (repo map), `/diff` |
| Model & cost | `/model`, `/fast`, `/think`, `/tokens`, `/cost` |
| Info & config | `/status`, `/config`, `/permissions`, `/doctor`, `/tools`, `/mcp`, `/hooks`, `/agents`, `/skills` |
| Workflow | `/plan`, `/spec`, `/recipe`, `/init`, `/watch`, `/unwatch` |
| UI | `/vim`, `/lang <ko\|en>`, `/clear`, `/help` |
| Exit | `/exit`, `/quit` |

## Built-in tools (36)

### File I/O
| Tool | Description |
|------|-------------|
| `read_file` | Read a file; `offset`+`limit` params for large files |
| `write_file` | Create or overwrite a file |
| `edit_file` | Replace `oldText` with `newText` |
| `multi_edit` | Multiple replacements in one file, one call |
| `delete_file` | Delete a file |
| `rename_file` | Move or rename a file |
| `create_patch` / `apply_patch` | Diff-style patch workflow |

### Search & navigation
| Tool | Description |
|------|-------------|
| `glob` | Find files by pattern — `**/*.ts`, `src/**/*.mjs` |
| `grep` | Regex search (ripgrep if installed, JS fallback) |
| `search_code` | Keyword search across the repo |
| `semantic_search` | Rank text candidates by relevance using Solar's Korean-optimized embeddings |
| `list_files` | List a directory |
| `repo_map` | Concise repo overview with key symbols |

### Intelligence (tree-sitter)
| Tool | Description |
|------|-------------|
| `find_symbol` | Find a symbol by name |
| `find_references` | Find all references to a symbol |
| `list_modules` | List modules in the workspace |
| `index_health` | Report tree-sitter index status |

### Execution
| Tool | Description |
|------|-------------|
| `run_shell` | Run an allowlisted shell command |
| `run_tests` | Run the project test suite |
| `run_linter` | Run the project linter |
| `run_typecheck` | Run type checking |
| `run_verification` | Linter + typecheck + tests in sequence |

### Web
| Tool | Description |
|------|-------------|
| `web_fetch` | Fetch a URL and return plain text |
| `web_search` | Search the web via Tavily (`TAVILY_API_KEY` required) |

### GitHub
| Tool | Description |
|------|-------------|
| `gh_issue_read` | Read a GitHub issue |
| `gh_issue_comment` | Comment on a GitHub issue |
| `gh_pr_create` | Create a pull request |
| `gh_pr_review` | Review a pull request |

### Document AI & verification
| Tool | Description |
|------|-------------|
| `read_document` | OCR + layout analysis for scanned/photographed PDFs and images (Upstage Document AI) |
| `check_groundedness` | Verify a claim is actually supported by its source context (Upstage Groundedness Check API) |

### Skills & tasks
| Tool | Description |
|------|-------------|
| `load_skill` | Load a SKILL.md-format skill's full prompt on demand |
| `todo_read` / `todo_write` | Read/write the in-session task checklist |

### Meta
| Tool | Description |
|------|-------------|
| `run_subagent` | Spawn a scoped subagent, optionally on an isolated git worktree |
| `echo` | Echo text |

## Permission modes

| Mode | Behaviour |
|------|-----------|
| `default` | Confirms high-risk actions interactively |
| `acceptEdits` | Auto-approves file edits, confirms shell |
| `auto` | Fully autonomous within workspace |
| `bypassPermissions` | No prompts (use with caution) |
| `dontAsk` | Never ask; deny anything not pre-approved |
| `plan` | Read-only — all writes blocked |

## Runtime extensions

### MCP servers
```bash
UPSTAGE_MCP_SERVERS_MODULE=./tools/mcp-servers.mjs
```
```js
export default [
  { name: "my-server", client: { async listTools() { return []; }, async callTool(name, args) { return {}; } } }
];
```

### Discovered tools
```bash
UPSTAGE_DISCOVERY_COMMAND="node tools/bridge.mjs discover"
UPSTAGE_DISCOVERY_INVOKE_COMMAND="node tools/bridge.mjs invoke"
```
The `discover` command must print a JSON array of tool specs:
```json
[{ "name": "my_tool", "description": "...", "risk": "low", "inputSchema": { "type": "object", "properties": {}, "additionalProperties": false } }]
```

### Real MCP servers via `.mcp.json` (Claude Code-compatible)

Drop a `.mcp.json` in the project root to connect real MCP servers automatically — both **stdio** and **Streamable HTTP** transports, standard JSON-RPC 2.0 `tools/list`/`tools/call`, tools exposed as `<server-name>__<tool-name>`:

```json
{
  "mcpServers": {
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "."]
    },
    "remote-api": {
      "url": "https://your-host.example.com/mcp",
      "headers": { "Authorization": "Bearer ..." }
    }
  }
}
```

`command` → stdio transport, `url` → Streamable HTTP transport (session + SSE handling included). Merges with `settings.json`'s `mcpServers`; a server that fails to connect is skipped with a warning, not a hard failure.

## Project context files

Place an `UPSTAGE.md` in any directory — it is automatically merged into the system prompt when the agent runs there or in a subdirectory (analogous to Claude's `CLAUDE.md`). Falls back to a directory's `AGENTS.md` (the cross-tool convention read by 30+ agents) when there's no `UPSTAGE.md`.

## Security

- Writes are restricted to `process.cwd()` by default
- Shell injection patterns are detected and blocked
- High-risk actions require explicit confirmation in `default` mode
- `SECURITY_OVERRIDE=true` relaxes path restrictions for development

## License

MIT © VectorSophie
