# IDE bridge (NDJSON over stdio)

`upstage-bridge` lets an editor/IDE extension drive the agent over a pipe. It
speaks newline-delimited JSON (one object per line) in both directions, reusing
the same agent stack as the CLI.

Spawn it:
```bash
upstage-bridge          # or: node src/bridge/server.mjs
```

## Protocol

**Client → server**
```json
{ "type": "initialize", "clientInfo": { "name": "my-ext" } }
{ "type": "prompt", "id": "p1", "text": "fix the failing test", "cwd": "/abs/project" }
{ "type": "cancel", "id": "p1" }
{ "type": "ping" }
```

**Server → client**
```json
{ "type": "ready", "serverInfo": { "name": "upstage-cli-bridge", "version": "..." } }
{ "type": "initialized", "capabilities": { "prompt": true, "cancel": true } }
{ "type": "event", "id": "p1", "event": { "type": "stream_token", "text": "..." } }
{ "type": "event", "id": "p1", "event": { "type": "tool_start", "tool": "write_file", "args": {...} } }
{ "type": "result", "id": "p1", "ok": true, "response": "…", "stopReason": "done" }
{ "type": "pong" }
{ "type": "error", "message": "…" }
```

- Every agent event from the loop (`stream_token`, `thinking`, `tool_start`,
  `tool_result`, `patch_preview`, `token_usage`, …) is forwarded as an `event`
  tagged with the prompt `id`, ending with a single `result`.
- `cancel` aborts an in-flight prompt (best-effort); the server stays up for the
  next request.
- Permission mode defaults to `acceptEdits` (override with
  `UPSTAGE_PERMISSION_MODE`); the model is selected by `UPSTAGE_MODEL`.

## Embedding

The protocol layer is `BridgeServer` (`src/bridge/bridge-server.mjs`) with an
injectable `runAgent` async generator, so it can be embedded/tested without the
model. `src/bridge/server.mjs` wires the real `runAgentLoop`.
