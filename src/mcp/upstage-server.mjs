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
 * It also exposes Upstage's Document AI endpoints as 5 standalone tools —
 * `upstage_parse`, `upstage_extract`, `upstage_classify`, `upstage_embed`,
 * `upstage_groundedness` — each a thin wrapper calling the matching
 * src/upstage/*.mjs service function directly (no agent loop involved), per
 * this repo's "one implementation, multiple surfaces" principle: the same
 * functions the built-in agent tools already call. See the "Document AI
 * tools" section below for the handlers and the TOOLS object for the full
 * list.
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
import { parseDocument } from "../upstage/documents.mjs";
import { classifyDocument } from "../upstage/classification.mjs";
import { extractStructured } from "../upstage/extraction.mjs";
import { embed } from "../upstage/embeddings.mjs";
import { checkGroundedness } from "../upstage/groundedness.mjs";
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

// ── Document AI tools (thin wrappers over src/upstage/*.mjs) ────────────────
//
// Unlike upstage_delegate/upstage_ask above (which run the full agent loop),
// these tools call a single src/upstage/*.mjs service function directly, per
// architectural principle 2 ("one implementation, multiple surfaces") — the
// same functions src/tools/builtin/*.mjs's agent-tool wrappers call. This MCP
// server is already its own separate process (own cwd/args), so there is no
// registry/policy/permission layer to route through here; each handler just
// awaits the service call and reshapes its result into the
// `{text, isError}` convention runDelegate() above establishes. None of these
// functions write to stdout, but they're still run under withCleanStdout for
// the same defense-in-depth reason runDelegate() uses it: a stray write deep
// in a dependency (retry logging, a future change) must never reach the
// JSON-RPC stream. Thrown errors (UpstageApiError or plain Error — see
// src/upstage/errors.mjs) are left to propagate; handleRequest()'s tools/call
// catch block already turns any thrown error into an `isError: true` result,
// so no per-handler try/catch is needed here (matching how upstage_delegate/
// upstage_ask, which also don't catch locally, rely on that same catch).

async function runParse({ path, format, mode, ocr }) {
  const result = await withCleanStdout(() => parseDocument({ path, format, mode, ocr }));
  // parseDocument()'s result has no dedicated `.html` field — per
  // documents.mjs's normalizeResponse(), `.markdown` also carries the
  // combined HTML string when format === "html" (only `.text` gets its own
  // field, for format === "text"). This is documents.mjs's own convention,
  // not a bug here — don't "fix" this by adding a `.html` lookup.
  const content = format === "text" ? result.text : result.markdown;
  const lines = [
    `## Document Parse result`,
    ``,
    `- path: ${path}`,
    `- elements: ${result.elements.length}`,
    `- pageCount: ${result.pageCount}`,
    ``,
    // Combined text only, not the per-element structure (unlike runExtract(),
    // which preserves full result fidelity since its shape is caller-defined
    // via `schema`) — parseDocument()'s `elements` array is often large/deep
    // and the combined text is what most MCP callers actually want; this is
    // a deliberate MCP-surface simplification, not a fidelity oversight.
    `### Content`,
    content || "(no content extracted)"
  ];
  return { text: lines.join("\n") };
}

async function runClassify({ path, categories }) {
  const { label, confidence } = await withCleanStdout(() => classifyDocument({ path, categories }));
  const lines = [
    `## Document Classification result`,
    ``,
    `- path: ${path}`,
    `- label: ${label}`,
    `- confidence: ${confidence === undefined ? "(not reported)" : confidence}`
  ];
  return { text: lines.join("\n") };
}

async function runExtract({ path, schema }) {
  const data = await withCleanStdout(() => extractStructured({ path, schema }));
  const lines = [
    `## Structured Extraction result`,
    ``,
    `- path: ${path}`,
    ``,
    "```json",
    JSON.stringify(data, null, 2),
    "```"
  ];
  return { text: lines.join("\n") };
}

async function runEmbed({ texts, type }) {
  const vectors = await withCleanStdout(() => embed({ texts, type }));
  const lines = [
    `## Embeddings result`,
    ``,
    `- type: ${type}`,
    `- count: ${vectors.length}`,
    `- dims: ${vectors[0]?.length ?? 0}`,
    ``,
    "```json",
    JSON.stringify(vectors),
    "```"
  ];
  return { text: lines.join("\n") };
}

async function runGroundedness({ context, answer }) {
  const { grounded, raw } = await withCleanStdout(() => checkGroundedness({ context, answer }));
  const lines = [
    `## Groundedness Check result`,
    ``,
    `- grounded: ${grounded}`,
    ``,
    `### Raw model response`,
    raw || "(empty)"
  ];
  return { text: lines.join("\n") };
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
  },
  // ── Document AI tools ───────────────────────────────────────────────────
  // Exactly the 5 tools the 3.2.0 release plan's task 7.7 names (parse,
  // extract, classify, embed, groundedness) — deliberately NOT also exposing
  // ocrDocument()/generateSchema() (documents.mjs / extraction.mjs) here.
  // Both of those two carry their own header-comment caveats marking them
  // as *not* live-verified against a real API call (ocrDocument's `ocr`
  // field omission, and schema-generation's genuinely disputed endpoint
  // path/response shape) — MCP exposure hands these to external, untrusted
  // clients as if they were settled, so the two least-verified endpoints
  // are the right ones to leave out of this first pass. Add them as
  // upstage_ocr / upstage_schema_generate in a follow-up once verified live.
  upstage_parse: {
    description:
      "Parse a document (PDF/PNG/JPG/TIFF/HEIC) into structured layout elements " +
      "via Upstage Document Parse, returning the combined text in the requested " +
      "output format plus a page count.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Absolute or relative path to the file to parse." },
        format: { type: "string", enum: ["markdown", "html", "text"], description: "Output format (default markdown)." },
        mode: { type: "string", enum: ["standard", "enhanced", "auto"], description: "Parse mode (default standard)." },
        ocr: { type: "string", enum: ["auto", "force"], description: "OCR trigger mode (default auto)." }
      },
      required: ["path"]
    },
    handler: (args) =>
      runParse({
        path: args.path,
        format: args.format || "markdown",
        mode: args.mode || "standard",
        ocr: args.ocr || "auto"
      })
  },
  upstage_extract: {
    description:
      "Extract structured data from a document (PDF/image) matching a caller-" +
      "supplied JSON Schema, via Upstage's Universal Extraction model. Schema " +
      "root properties are restricted by Upstage to string|integer|number|array " +
      "(no nested arrays).",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Absolute or relative path to the file to extract from." },
        schema: { type: "object", description: "A JSON Schema object describing the fields to extract." }
      },
      required: ["path", "schema"]
    },
    handler: (args) => runExtract({ path: args.path, schema: args.schema })
  },
  upstage_classify: {
    description:
      "Classify a document (PDF/image) into one of a caller-supplied set of " +
      "categories via Upstage's Document Classification model. Requires 2 to " +
      "1,000 candidate category labels.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Absolute or relative path to the file to classify." },
        categories: {
          type: "array",
          items: { type: "string" },
          description: "Candidate category labels (2 to 1,000 entries)."
        }
      },
      required: ["path", "categories"]
    },
    handler: (args) => runClassify({ path: args.path, categories: args.categories })
  },
  upstage_embed: {
    description:
      "Embed a batch of texts via Upstage's Solar embeddings. Solar embeddings " +
      "are asymmetric — pick `type: \"query\"` for the user's search text and " +
      "`type: \"passage\"` for the candidate/document text being searched over.",
    inputSchema: {
      type: "object",
      properties: {
        texts: { type: "array", items: { type: "string" }, description: "Texts to embed (non-empty)." },
        type: { type: "string", enum: ["query", "passage"], description: "Which side of a search this batch represents (default query)." }
      },
      required: ["texts"]
    },
    handler: (args) => runEmbed({ texts: args.texts, type: args.type || "query" })
  },
  upstage_groundedness: {
    description:
      "Verify that an answer/claim is actually supported by its source context, " +
      "via Upstage's Groundedness Check — a real second model call, not self-" +
      "critique. Returns \"grounded\", \"notGrounded\", or \"notSure\".",
    inputSchema: {
      type: "object",
      properties: {
        context: { type: "string", description: "The source text the answer should be checked against." },
        answer: { type: "string", description: "The claim/answer/summary to verify." }
      },
      required: ["context", "answer"]
    },
    handler: (args) => runGroundedness({ context: args.context, answer: args.answer })
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
        // Generic across every tool (agent-loop delegates and the direct
        // src/upstage/*.mjs service calls alike) — none of them catch
        // locally, they all rely on this one place to convert a thrown
        // UpstageApiError/Error into an isError result instead of crashing
        // the server process.
        send(id, {
          content: [{ type: "text", text: `upstage-mcp tool error (${params.name}): ${err?.message || err}` }],
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
