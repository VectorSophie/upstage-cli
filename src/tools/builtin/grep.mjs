import { readFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { collectWorkspaceFiles, isLikelyTextFile } from "../lib/fs-utils.mjs";
import { resolveWorkspacePath } from "../lib/fs-utils.mjs";

const MAX_MATCHES = 100;
const CONTEXT_LINES = 2;

function tryRipgrep(pattern, root, args) {
  const rgArgs = [
    "--line-number",
    "--no-heading",
    "--color=never",
    `--max-count=${MAX_MATCHES}`,
    "-e", pattern
  ];
  if (args.ignoreCase) rgArgs.push("--ignore-case");
  if (args.glob) rgArgs.push("--glob", args.glob);
  if (CONTEXT_LINES > 0) rgArgs.push(`--context=${CONTEXT_LINES}`);
  rgArgs.push(root);

  const result = spawnSync("rg", rgArgs, { encoding: "utf8", timeout: 15000 });
  if (result.error) return null; // rg not available
  return result.stdout || "";
}

async function jsGrep(pattern, root, args) {
  const flags = args.ignoreCase ? "gi" : "g";
  let regex;
  try { regex = new RegExp(pattern, flags); } catch (e) { throw new Error(`Invalid regex: ${e.message}`); }

  const files = await collectWorkspaceFiles(root, { maxFiles: 500, maxDepth: 8 });
  const lines = [];

  for (const filePath of files) {
    if (lines.length >= MAX_MATCHES) break;
    if (!(await isLikelyTextFile(filePath))) continue;
    if (args.glob && !filePath.includes(args.glob.replace(/\*/g, ""))) continue;
    let content;
    try { content = await readFile(filePath, "utf8"); } catch { continue; }
    const fileLines = content.split(/\r?\n/);
    for (let i = 0; i < fileLines.length; i++) {
      if (regex.test(fileLines[i])) {
        const rel = relative(root, filePath).replace(/\\/g, "/");
        lines.push(`${rel}:${i + 1}: ${fileLines[i]}`);
        if (lines.length >= MAX_MATCHES) break;
      }
    }
  }
  return lines.join("\n");
}

export const grepTool = {
  name: "grep",
  description: "Search for a regex pattern across files (uses ripgrep if available, JS fallback otherwise)",
  risk: "low",
  inputSchema: {
    type: "object",
    properties: {
      pattern:    { type: "string",  description: "Regex pattern to search for" },
      path:       { type: "string",  description: "Directory or file to search (default: cwd)" },
      glob:       { type: "string",  description: "File glob filter, e.g. *.ts" },
      ignoreCase: { type: "boolean", description: "Case-insensitive search (default: false)" }
    },
    required: ["pattern"],
    additionalProperties: false
  },
  async execute(args, context) {
    if (typeof args.pattern !== "string" || !args.pattern) {
      throw new Error("pattern is required");
    }
    const root = args.path
      ? resolveWorkspacePath(context.cwd, args.path)
      : (context.cwd || process.cwd());

    let output = tryRipgrep(args.pattern, root, args);
    let engine = "ripgrep";
    if (output === null) {
      output = await jsGrep(args.pattern, root, args);
      engine = "js";
    }

    const matchLines = output.trim().split("\n").filter(Boolean);
    return {
      pattern: args.pattern,
      engine,
      matchCount: matchLines.filter((l) => !l.startsWith("--")).length,
      output: output.trim(),
      truncated: matchLines.length >= MAX_MATCHES
    };
  }
};
