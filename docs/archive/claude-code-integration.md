# Wiring upstage-cli into Claude Code (as a delegatable subagent)

> **Strategic framing superseded (2026-09-03):** the direction below —
> "Claude Code plans, Solar executes small scoped sub-tasks" — was the
> project's strategy as of 2026-06-14, motivated by an eval against
> `solar-pro2` that found weak multi-step planning. That direction has since
> been explicitly superseded: **upstage-cli now targets a Claude-Code-quality
> bar with Solar itself as the engine** (native-Solar-driven, not a
> delegate), following the 2026-09-02 Model Modernization plan (default
> model is now `solar-pro4`, with a per-model capability table). See memory
> `project-mcp-subagent-direction` for the full history.
>
> The MCP mechanics documented below (the server, its two tools, the
> config wiring) are still real, working code — nothing here was removed.
> This remains a legitimate way to use upstage-cli *as a tool from Claude
> Code* if that workflow is useful to you; it's just no longer this
> project's primary strategic direction for itself.

`upstage-cli` ships an **MCP server** (`src/mcp/upstage-server.mjs`) that exposes
the Solar agent as two tools any MCP client — including Claude Code — can call:

| Tool | What it does | Writes? |
|---|---|---|
| `upstage_delegate` | Runs the full Solar agent on a narrow coding task in a `cwd`: read/write/edit files, run tests, self-correct. Returns a summary + `git` change list. | ✅ (confined to `cwd`) |
| `upstage_ask` | Read-only question about a codebase — reads/searches files, never modifies. | ❌ |

## Setup

### 1. Make sure the key is available
The server auto-loads a `.env` from its working directory, or reads
`UPSTAGE_API_KEY` from the environment.

### 2. Register the server with Claude Code

**Option A — CLI:**
```bash
claude mcp add upstage -- node C:/Workspace/upstage-cli/src/mcp/upstage-server.mjs
```

**Option B — project `.mcp.json`** (copy from `.mcp.json.example`):
```json
{
  "mcpServers": {
    "upstage": {
      "command": "node",
      "args": ["C:/Workspace/upstage-cli/src/mcp/upstage-server.mjs"],
      "env": {
        "UPSTAGE_API_KEY": "up_...",
        "UPSTAGE_MODEL": "solar-pro4"
      }
    }
  }
}
```

If you `npm install -g @jackochesstern/upstage-cli`, you can use the installed
`upstage-mcp` binary instead of the absolute path:
```bash
claude mcp add upstage -- upstage-mcp
```

### 3. Use it from Claude Code
```
> Use the upstage subagent to write calc.mjs (add/sub/mul/divide-by-zero throw)
  plus a passing node:test suite, in ./scratch.
```
Claude will call `upstage_delegate({ task, cwd })`; Solar does the work and
returns the result + a `git diff --stat` of what changed.

## Behaviour notes

- **Non-interactive & sandboxed.** `upstage_delegate` runs in `bypassPermissions`
  mode so it never blocks on an approval prompt, but the path validator still
  confines all writes to `cwd`. `upstage_ask` runs read-only (`plan` mode).
- **It runs its own tests.** High-risk tools (`run_shell`, `run_tests`) are
  enabled for the write-delegate so Solar can verify itself before reporting
  done — in practice it iterates until tests pass.
- **No git side effects.** The change summary is computed from `git diff --stat`
  + untracked files; it does **not** stage anything in your repo.
- **`cwd` is yours to pick.** Point it at a scratch dir for throwaway work, or at
  a real package for a scoped fix. The server's own index/checkpoint artifacts
  (`.upstage/`, `.upstage-cli/`) are filtered out of the reported changes.

## Verifying the server by hand
```bash
node scripts/mcp-smoke.mjs src/mcp/upstage-server.mjs /path/to/scratch "your task"
```
Prints the `initialize` / `tools/list` handshake, then calls `upstage_delegate`
and shows the result.
