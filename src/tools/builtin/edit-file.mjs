import { readFile, writeFile } from "node:fs/promises";
import { relative, resolve } from "node:path";
import { PolicyEngine } from "../../core/policy/engine.mjs";

function createPolicyViolationError(message, details = {}) {
  const error = new Error(message);
  error.code = "POLICY_VIOLATION";
  error.details = details;
  return error;
}

function normalize(text) {
  return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

// Try exact match, then line-trimmed match. Returns matched strings or null.
function fuzzyFind(content, oldText) {
  const nc = normalize(content);
  const no = normalize(oldText);
  if (nc.includes(no)) return { nc, no };

  const tc = nc.split("\n").map((l) => l.trimEnd()).join("\n");
  const to = no.split("\n").map((l) => l.trimEnd()).join("\n");
  if (tc.includes(to)) return { nc: tc, no: to };

  return null;
}

function contextSnippet(content, hint, n = 8) {
  const lines = content.split("\n");
  const firstLine = hint.split("\n")[0].trim();
  const idx = lines.findIndex((l) => l.includes(firstLine));
  const start = Math.max(0, (idx === -1 ? 0 : idx) - 2);
  return lines.slice(start, start + n).join("\n");
}

export const editFileTool = {
  name: "edit_file",
  description: "Edit a file by replacing oldText with newText. Returns the edited region for verification. Normalizes line endings automatically.",
  risk: "medium",
  inputSchema: {
    type: "object",
    properties: {
      path:       { type: "string" },
      oldText:    { type: "string" },
      newText:    { type: "string" },
      replaceAll: { type: "boolean" }
    },
    required: ["path", "oldText", "newText"],
    additionalProperties: false
  },
  async execute(args, context) {
    if (typeof args.path !== "string") throw new Error("path is required");
    if (typeof args.oldText !== "string" || typeof args.newText !== "string") {
      throw new Error("oldText and newText are required");
    }

    const workspaceCwd =
      typeof context.cwd === "string" && context.cwd.length > 0 ? context.cwd : process.cwd();

    const candidatePolicyEngine = context.registry?.policyEngine || context.policyEngine;
    const policyEngine =
      candidatePolicyEngine && typeof candidatePolicyEngine.evaluateWritePath === "function"
        ? candidatePolicyEngine
        : new PolicyEngine();
    const writePathDecision = policyEngine.evaluateWritePath(args.path, { ...context, cwd: workspaceCwd });
    const absolutePath = writePathDecision.details?.absolutePath || resolve(workspaceCwd, args.path);

    if (!writePathDecision.allowed) {
      const message = `Write blocked by policy for path: ${absolutePath}`;
      context.onLog?.({ stage: "policy", channel: "security", text: `${message} (${writePathDecision.reason})` });
      context.eventBus?.emit?.("POLICY_DECISION", {
        source: "edit_file", tool: "edit_file", actionClass: "write",
        approved: false, allowed: false, reason: writePathDecision.reason
      });
      throw createPolicyViolationError(message, { ...writePathDecision.details, reason: writePathDecision.reason });
    }

    const original = await readFile(absolutePath, "utf8");
    const match = fuzzyFind(original, args.oldText);

    if (!match) {
      const snippet = contextSnippet(original, args.oldText);
      throw Object.assign(
        new Error(
          `oldText not found in ${relative(workspaceCwd, absolutePath)}. ` +
          `Read the file first and copy the exact text.\n` +
          `File excerpt near expected location:\n\`\`\`\n${snippet}\n\`\`\``
        ),
        { code: "EDIT_NOT_FOUND" }
      );
    }

    const { nc, no } = match;
    const nn = normalize(args.newText);
    const updated = args.replaceAll ? nc.split(no).join(nn) : nc.replace(no, nn);

    await writeFile(absolutePath, updated, "utf8");

    // Post-write: return lines around the insertion point so the model can verify
    const updatedLines = updated.split("\n");
    const insertionIdx = updated.indexOf(nn);
    const lineNo = updated.slice(0, insertionIdx).split("\n").length - 1;
    const start = Math.max(0, lineNo - 1);
    const preview = updatedLines.slice(start, start + nn.split("\n").length + 2).join("\n");

    return {
      path:     relative(workspaceCwd, absolutePath),
      replaced: args.replaceAll ? "all" : "first",
      preview
    };
  }
};
