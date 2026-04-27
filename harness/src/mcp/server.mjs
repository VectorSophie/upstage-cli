import { createReadStream, readdirSync, writeFileSync, readFileSync, statSync } from "node:fs";
import { execSync } from "node:child_process";
import { resolve, join } from "node:path";
import { createInterface } from "node:readline";

/**
 * MCP stdio server — exposes 8 harness tools over JSON-RPC 2.0 (stdio transport).
 *
 * Protocol: newline-delimited JSON-RPC 2.0 messages on stdin/stdout.
 * Each request:  { jsonrpc: "2.0", id, method, params }
 * Each response: { jsonrpc: "2.0", id, result } | { jsonrpc: "2.0", id, error }
 */

const TOOLS = {
  "filesystem/read": {
    description: "Read a file from the harness workdir",
    inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
    handler: async ({ path: p }, { workdir }) => {
      const abs = resolve(workdir, p);
      return { content: readFileSync(abs, "utf8") };
    }
  },
  "filesystem/write": {
    description: "Write a file to the harness workdir",
    inputSchema: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } }, required: ["path", "content"] },
    handler: async ({ path: p, content }, { workdir }) => {
      const abs = resolve(workdir, p);
      writeFileSync(abs, content, "utf8");
      return { ok: true, path: abs };
    }
  },
  "filesystem/list": {
    description: "List files in the harness workdir",
    inputSchema: { type: "object", properties: { path: { type: "string" } } },
    handler: async ({ path: p = "." }, { workdir }) => {
      const abs = resolve(workdir, p);
      const entries = readdirSync(abs, { withFileTypes: true });
      return { files: entries.map((e) => ({ name: e.name, type: e.isDirectory() ? "dir" : "file" })) };
    }
  },
  "shell/run": {
    description: "Run a sandboxed shell command in the harness workdir",
    inputSchema: { type: "object", properties: { command: { type: "string" }, timeout: { type: "number" } }, required: ["command"] },
    handler: async ({ command, timeout = 30 }, { workdir }) => {
      try {
        const stdout = execSync(command, { cwd: workdir, timeout: timeout * 1000, encoding: "utf8" });
        return { ok: true, stdout, exitCode: 0 };
      } catch (err) {
        return { ok: false, stdout: err.stdout || "", stderr: err.stderr || "", exitCode: err.status || 1 };
      }
    }
  },
  "git/diff": {
    description: "Get the unified diff of uncommitted changes in the workdir",
    inputSchema: { type: "object", properties: {} },
    handler: async (_params, { workdir }) => {
      try {
        execSync("git add -A", { cwd: workdir, stdio: "pipe" });
        const diff = execSync("git diff --cached", { cwd: workdir, encoding: "utf8" });
        return { diff };
      } catch (err) {
        return { diff: "", error: err.message };
      }
    }
  },
  "git/status": {
    description: "Get the git status of the workdir",
    inputSchema: { type: "object", properties: {} },
    handler: async (_params, { workdir }) => {
      try {
        const status = execSync("git status --short", { cwd: workdir, encoding: "utf8" });
        return { status };
      } catch (err) {
        return { status: "", error: err.message };
      }
    }
  },
  "test/run": {
    description: "Run configured checks for the current task",
    inputSchema: {
      type: "object",
      properties: {
        checkType: { type: "string", enum: ["fail_to_pass", "pass_to_pass", "custom", "all"] }
      }
    },
    handler: async ({ checkType = "all" }, { workdir, task }) => {
      const { runAll } = await import("../evaluation/checks.mjs");
      const checks = task?.checks || {};
      const toRun = checkType === "all"
        ? [...(checks.fail_to_pass || []), ...(checks.pass_to_pass || []), ...(checks.custom || [])]
        : checks[checkType] || [];
      const results = await runAll(toRun, workdir, task?.sandbox?.timeout || 60);
      return { results };
    }
  },
  "static_analysis/run": {
    description: "Run a static analysis command in the workdir",
    inputSchema: {
      type: "object",
      properties: { command: { type: "string" }, timeout: { type: "number" } },
      required: ["command"]
    },
    handler: async ({ command, timeout = 30 }, { workdir }) => {
      try {
        const output = execSync(command, { cwd: workdir, timeout: timeout * 1000, encoding: "utf8" });
        return { ok: true, output, exitCode: 0 };
      } catch (err) {
        return { ok: false, output: (err.stdout || "") + (err.stderr || ""), exitCode: err.status || 1 };
      }
    }
  }
};

function respond(id, result) {
  const msg = JSON.stringify({ jsonrpc: "2.0", id, result });
  process.stdout.write(msg + "\n");
}

function respondError(id, code, message) {
  const msg = JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } });
  process.stdout.write(msg + "\n");
}

export async function startMcpServer({ workdir = process.cwd(), task = null } = {}) {
  const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });

  // Send server capabilities on startup
  process.stdout.write(JSON.stringify({
    jsonrpc: "2.0",
    method: "server/capabilities",
    params: {
      tools: Object.entries(TOOLS).map(([name, t]) => ({
        name,
        description: t.description,
        inputSchema: t.inputSchema
      }))
    }
  }) + "\n");

  rl.on("line", async (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;

    let req;
    try {
      req = JSON.parse(trimmed);
    } catch {
      respondError(null, -32700, "Parse error");
      return;
    }

    const { id, method, params = {} } = req;

    if (method === "tools/list") {
      respond(id, {
        tools: Object.entries(TOOLS).map(([name, t]) => ({
          name,
          description: t.description,
          inputSchema: t.inputSchema
        }))
      });
      return;
    }

    if (method === "tools/call") {
      const toolName = params.name;
      const toolInput = params.arguments || {};
      const tool = TOOLS[toolName];

      if (!tool) {
        respondError(id, -32601, `Unknown tool: ${toolName}`);
        return;
      }

      try {
        const result = await tool.handler(toolInput, { workdir, task });
        respond(id, { content: [{ type: "text", text: JSON.stringify(result) }] });
      } catch (err) {
        respondError(id, -32603, err.message);
      }
      return;
    }

    if (method === "initialize") {
      respond(id, { protocolVersion: "2024-11-05", capabilities: { tools: {} } });
      return;
    }

    respondError(id, -32601, `Method not found: ${method}`);
  });

  rl.on("close", () => process.exit(0));
}

// Auto-start when run directly
const isMain = process.argv[1] && (
  process.argv[1].endsWith("server.mjs") ||
  process.argv[1].includes("mcp/server")
);
if (isMain) {
  const workdir = process.env.HARNESS_WORKDIR || process.cwd();
  startMcpServer({ workdir }).catch((err) => {
    process.stderr.write(`MCP server error: ${err.message}\n`);
    process.exit(1);
  });
}
