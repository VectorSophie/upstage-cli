#!/usr/bin/env node
/**
 * upstage-mcp — a standard MCP (Model Context Protocol) stdio server that
 * exposes the upstage-cli agent as a *delegatable coding subagent*.
 *
 * Wire it into Claude Code (or any MCP client) via `.mcp.json`:
 *
 *   {
 *     "mcpServers": {
 *       "upstage": {
 *         "command": "node",
 *         "args": ["C:/Workspace/upstage-cli/src/mcp/upstage-server.mjs"],
 *         "env": { "UPSTAGE_API_KEY": "up_...", "UPSTAGE_MODEL": "solar-pro2" }
 *       }
 *     }
 *   }
 *
 * Claude Code (the strong orchestrator) plans, then offloads narrow, well-scoped
 * sub-tasks to Solar through the `upstage_delegate` / `upstage_ask` tools.
 *
 * Transport: newline-delimited JSON-RPC 2.0 over stdin/stdout (the MCP stdio
 * transport). Protocol surface: initialize, ping, tools/list, tools/call, plus
 * notifications/* (ignored). The result shape matches the MCP spec:
 *   { content: [{ type: "text", text }], isError?: boolean }
 *
 * IMPORTANT: stdout is reserved for JSON-RPC frames. While the agent runs we
 * redirect any stray stdout writes (from adapters/tools) to stderr so the
 * protocol stream stays clean.
 */

import { execFileSync } from "node:child_process";
import { createInterface } from "node:readline";
import { resolve } from "node:path";

import { loadProjectEnv } from "../config/load-env.mjs";
import { createRegistryWithExtensions } from "../tools/create-registry.mjs";
import { DEFAULT_POLICY } from "../config/defaults.mjs";
import { createPermissionChecker } from "../permissions/checker.mjs";
import { HookEngine } from "../hooks/engine.mjs";
import { createSession } from "../runtime/session.mjs";
import { runAgentLoop, collectAgentLoop } from "../agent/loop.mjs";
import { UpstageAdapter } from "../model/upstage-adapter.mjs";
import { OpenAIAdapter } from "../model/openai-adapter.mjs";
import { GeminiAdapter } from "../model/gemini-adapter.mjs";
import { getProvider } from "../core/providers.mjs";
import pkg from "../../package.json" with { type: "json" };

// See src/tools/mcp/http-client.mjs's PROTOCOL_VERSION comment for context
// (2026-07-28 spec rewrite). This server always speaks one version rather
// than negotiating per-client; stdio has no per-request headers so we're
// already "stateless" at the transport level.
const PROTOCOL_VERSION = "2026-07-28";
const SERVER_INFO = { name: "upstage-cli", version: pkg.version };

function log(...args) {
  // Diagnostics go to stderr — stdout is JSON-RPC only.
  process.stderr.write(`[upstage-mcp] ${args.join(" ")}\n`);
}

function buildAdapter(model) {
  const provider = getProvider(model);
  if (provider.id === "openai") return new OpenAIAdapter({ model });
  if (provider.id === "gemini") return new GeminiAdapter({ model });
  return new UpstageAdapter({ model: model || undefined });
}

/** Run `fn` with stdout redirected to stderr so the agent can't corrupt the
 *  JSON-RPC stream. Restores stdout afterwards. */
async function withCleanStdout(fn) {
  const realWrite = process.stdout.write.bind(process.stdout);
  process.stdout.write = (chunk, enc, cb) => process.stderr.write(chunk, enc, cb);
  try {
    return await fn();
  } finally {
    process.stdout.write = realWrite;
  }
}

const INTERNAL_PATHS = /(^|[\\/])(\.upstage|\.upstage-cli|\.env|\.git)([\\/]|$)/;

/** Summarize working-tree changes WITHOUT mutating the user's git index.
 *  Lists tracked modifications (diff --stat) + new untracked files, and filters
 *  out upstage-cli's own scratch artifacts so Claude sees a meaningful summary. */
function gitChangeSummary(cwd) {
  const out = [];
  try {
    const stat = execFileSync("git", ["diff", "--stat"], { cwd, encoding: "utf8" }).trim();
    for (const line of stat.split("\n")) {
      if (line && !INTERNAL_PATHS.test(line)) out.push(line);
    }
  } catch { /* not a git repo */ }
  try {
    const untracked = execFileSync("git", ["ls-files", "--others", "--exclude-standard"], { cwd, encoding: "utf8" }).trim();
    for (const f of untracked.split("\n")) {
      if (f && !INTERNAL_PATHS.test(f)) out.push(`${f} (new)`);
    }
  } catch { /* ignore */ }
  return out.join("\n");
}

// ── The delegated agent run ──────────────────────────────────────────────────

async function runDelegate({ task, cwd, maxSteps, model, readOnly }) {
  // A write-delegate is non-interactive and sandboxed to `cwd`, so it must be
  // allowed to run its own tests/shell (and never wait on a confirmation that
  // can't arrive). A read-delegate keeps the safe defaults.
  const policy = readOnly
    ? DEFAULT_POLICY
    : { allowHighRiskTools: true, requireConfirmationForHighRisk: false };
  // Non-interactive: must never block on an approval prompt. Writes are still
  // confined to `cwd` by the path validator inside the registry.
  const permissionMode = readOnly ? "plan" : "bypassPermissions";
  const permissionChecker = createPermissionChecker({ mode: permissionMode });
  const hookEngine = new HookEngine({});

  const registry = await createRegistryWithExtensions({
    policy,
    cwd,
    permissionMode,
    permissionChecker,
    hookEngine
  });

  const adapter = buildAdapter(model);
  const session = createSession(cwd);

  const { result } = await withCleanStdout(() =>
    collectAgentLoop(
      runAgentLoop({
        input: task,
        registry,
        cwd,
        adapter,
        stream: false,
        session,
        runtimeCache: {},
        budget: {
          maxSteps: Number.isInteger(maxSteps) ? maxSteps : 12,
          maxToolCalls: 40,
          maxWallTimeMs: 180000
        }
      })
    )
  );

  const steps = Array.isArray(result.trace) ? result.trace.length : 0;
  const diffStat = readOnly ? "" : gitChangeSummary(cwd);

  const lines = [
    `## upstage subagent result`,
    ``,
    `- model: ${adapter.model || model || "solar-pro2"}`,
    `- stopReason: ${result.stopReason}`,
    `- ok: ${result.ok}`,
    `- steps: ${steps}`,
    ``,
    `### Response`,
    result.response || "(no response)"
  ];
  if (!readOnly) {
    lines.push("", "### Changes (git diff --stat)", diffStat || "(no file changes)");
  }

  return { text: lines.join("\n"), isError: result.ok === false };
}

// ── Tool definitions ─────────────────────────────────────────────────────────

const TOOLS = {
  upstage_delegate: {
    description:
      "Delegate a narrow, well-specified coding task to the Upstage Solar agent. " +
      "It can read, write, and edit files within `cwd`, run tests, and self-correct. " +
      "Best for small, self-contained sub-tasks (one file/function, a focused fix). " +
      "Returns the agent's summary plus a git diff --stat of what it changed.",
    inputSchema: {
      type: "object",
      properties: {
        task: { type: "string", description: "Precise task description. Be specific — this model follows narrow instructions best." },
        cwd: { type: "string", description: "Absolute path to the working directory. Defaults to the server's cwd." },
        maxSteps: { type: "number", description: "Max agent steps (default 12)." },
        model: { type: "string", description: "Override model (e.g. solar-pro2, solar-pro3)." }
      },
      required: ["task"]
    },
    handler: (args) =>
      runDelegate({
        task: args.task,
        cwd: args.cwd ? resolve(args.cwd) : process.cwd(),
        maxSteps: args.maxSteps,
        model: args.model,
        readOnly: false
      })
  },
  upstage_ask: {
    description:
      "Ask the Upstage Solar agent a read-only question about a codebase. It can " +
      "read and search files but cannot modify anything. Use for cheap exploration " +
      "or a second opinion that won't touch your working tree.",
    inputSchema: {
      type: "object",
      properties: {
        question: { type: "string", description: "The question about the codebase." },
        cwd: { type: "string", description: "Absolute path to the working directory. Defaults to the server's cwd." },
        model: { type: "string", description: "Override model." }
      },
      required: ["question"]
    },
    handler: (args) =>
      runDelegate({
        task: args.question,
        cwd: args.cwd ? resolve(args.cwd) : process.cwd(),
        maxSteps: 8,
        model: args.model,
        readOnly: true
      })
  }
};

// ── JSON-RPC plumbing ────────────────────────────────────────────────────────

function send(id, result) {
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\n");
}

function sendError(id, code, message) {
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } }) + "\n");
}

function toolList() {
  return {
    tools: Object.entries(TOOLS).map(([name, t]) => ({
      name,
      description: t.description,
      inputSchema: t.inputSchema
    }))
  };
}

async function handleRequest(req) {
  const { id, method, params = {} } = req;

  // Notifications carry no id and expect no response.
  if (id === undefined || id === null) {
    return;
  }

  switch (method) {
    case "initialize":
      send(id, {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO
      });
      return;
    case "ping":
      send(id, {});
      return;
    case "tools/list":
      send(id, toolList());
      return;
    case "tools/call": {
      const tool = TOOLS[params.name];
      if (!tool) {
        sendError(id, -32602, `Unknown tool: ${params.name}`);
        return;
      }
      try {
        const { text, isError } = await tool.handler(params.arguments || {});
        send(id, { content: [{ type: "text", text }], isError: !!isError });
      } catch (err) {
        // Tool-level failures are reported as a result with isError, per MCP.
        send(id, {
          content: [{ type: "text", text: `upstage subagent error: ${err?.message || err}` }],
          isError: true
        });
      }
      return;
    }
    default:
      sendError(id, -32601, `Method not found: ${method}`);
  }
}

export async function startServer({ cwd = process.cwd() } = {}) {
  await loadProjectEnv(cwd).catch(() => {});
  process.chdir(cwd);

  // A long-lived stdio server must survive a stray throw from deep in the agent
  // loop (e.g. an event-bus callback) — log it, keep serving.
  process.on("uncaughtException", (err) => log(`uncaughtException: ${err?.stack || err}`));
  process.on("unhandledRejection", (err) => log(`unhandledRejection: ${err?.stack || err}`));

  const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
  log(`ready (cwd=${cwd}, model=${process.env.UPSTAGE_MODEL || "solar-pro2"})`);

  rl.on("line", async (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let req;
    try {
      req = JSON.parse(trimmed);
    } catch {
      sendError(null, -32700, "Parse error");
      return;
    }
    try {
      await handleRequest(req);
    } catch (err) {
      sendError(req?.id ?? null, -32603, err?.message || "Internal error");
    }
  });

  rl.on("close", () => process.exit(0));
}

const invokedDirectly =
  process.argv[1] &&
  (process.argv[1].endsWith("upstage-server.mjs") || process.argv[1].includes("mcp/upstage-server"));

if (invokedDirectly) {
  startServer({ cwd: process.env.UPSTAGE_MCP_CWD || process.cwd() }).catch((err) => {
    process.stderr.write(`upstage-mcp fatal: ${err?.message || err}\n`);
    process.exit(1);
  });
}
