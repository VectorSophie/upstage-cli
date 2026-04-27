# ✦✧ upstage-cli

An agentic coding assistant powered by **Upstage Solar Pro2** — runs entirely in your terminal with a full TUI, 30 built-in tools, MCP server support, and an evaluation harness for benchmarking agents on real coding tasks.

## Installation

```bash
npm install -g @jackochesstern/upstage-cli
```

Requires **Node.js ≥ 20**.

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

```
upstage [command] [options] [prompt]

Commands:
  chat              Interactive TUI (default)
  ask               One-shot prompt mode

Options:
  -p, --prompt      Run prompt and exit
  -m, --model       Model to use (default: solar-pro2)
  --session         Resume session by ID
  --new-session     Start a fresh session
  --reset-session   Reset and start fresh
  --permission-mode default|bypassPermissions|acceptEdits|auto|dontAsk|plan
  --confirm-patches Require confirmation before applying patches
  --lang            Response language: ko|en
  --max-turns       Max agent turns per prompt
  --allowedTools    Comma-separated allow-list
  --disallowedTools Comma-separated deny-list
  -v, --verbose     Verbose output
  -d, --debug       Debug mode
```

## TUI layout

```
┌─ Chat (left) ──────────────────┐┌─ Sidebar (right) ──────────────┐
│                                ││ [ PLAN ] [ CONTEXT ] [ TOOLS ] │
│  Agent responses and diffs     ││                                 │
│  appear here in real time      ││ Active plan, repo map, tool log │
└────────────────────────────────┘└─────────────────────────────────┘
┌─ Status bar ───────────────────────────────────────────────────────┐
│  ✦✧  solar-pro2 · session-id · Tokens: N | Cost: $N | Lang: EN    │
└────────────────────────────────────────────────────────────────────┘
```

## Keyboard shortcuts

| Key | Action |
|-----|--------|
| `Tab` | Cycle focus: input → chat → sidebar |
| `←` / `→` | Switch sidebar tabs (PLAN / CONTEXT / TOOLS) |
| `Ctrl+X` | Open current input in `$EDITOR` |
| `Esc` | Navigation mode — scroll with `j`/`k` |
| `Esc` × 2 | Rewind — undo last agent turn |
| `i` | Back to insert mode |

## Slash commands

| Command | Description |
|---------|-------------|
| `/help` | List all commands |
| `/tools` | Show all 30 registered tools |
| `/status` | Session state |
| `/cost` | Token usage + estimated cost |
| `/repo-map` | Trigger repo map |
| `/mode` | Current permission mode |
| `/lang en\|ko` | Switch response language |
| `/agents` | List custom agents |
| `/skills` | List skills |
| `/mcp` | MCP server status |
| `/hooks` | Configured hooks |
| `/forget N` | Drop last N messages |
| `/compact` | Manually compact context |
| `/new-session` | Start fresh |
| `/clear` | Clear display |
| `/quit` | Exit |

## Built-in tools (30)

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

### Meta
| Tool | Description |
|------|-------------|
| `run_subagent` | Spawn a scoped subagent |
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

## Project context files

Place an `UPSTAGE.md` in any directory — it is automatically merged into the system prompt when the agent runs there or in a subdirectory (analogous to Claude's `CLAUDE.md`).

## Security

- Writes are restricted to `process.cwd()` by default
- Shell injection patterns are detected and blocked
- High-risk actions require explicit confirmation in `default` mode
- `SECURITY_OVERRIDE=true` relaxes path restrictions for development

## License

MIT © VectorSophie
