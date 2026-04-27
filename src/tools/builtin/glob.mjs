import { readdir, stat } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { resolveWorkspacePath } from "../lib/fs-utils.mjs";

function globToRegex(pattern) {
  let src = "";
  let i = 0;
  while (i < pattern.length) {
    const ch = pattern[i];
    if (ch === "*" && pattern[i + 1] === "*") {
      src += ".*";
      i += 2;
      if (pattern[i] === "/") i++; // consume trailing slash after **
    } else if (ch === "*") {
      src += "[^/]*";
      i++;
    } else if (ch === "?") {
      src += "[^/]";
      i++;
    } else if (ch === "{") {
      const end = pattern.indexOf("}", i);
      if (end === -1) { src += "\\{"; i++; continue; }
      const alts = pattern.slice(i + 1, end).split(",").map(globToRegex);
      src += `(${alts.join("|")})`;
      i = end + 1;
    } else if (".+^$|\\()[]".includes(ch)) {
      src += "\\" + ch;
      i++;
    } else {
      src += ch;
      i++;
    }
  }
  return src;
}

const SKIP_DIRS = new Set(["node_modules", ".git", ".next", "dist", "build", "__pycache__", ".cache"]);

async function walk(dir, baseDir, regex, results, maxResults) {
  if (results.length >= maxResults) return;
  let entries;
  try { entries = await readdir(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    if (results.length >= maxResults) break;
    if (SKIP_DIRS.has(e.name)) continue;
    const abs = join(dir, e.name);
    const rel = relative(baseDir, abs).replace(/\\/g, "/");
    if (e.isDirectory()) {
      await walk(abs, baseDir, regex, results, maxResults);
    } else if (regex.test(rel)) {
      results.push(rel);
    }
  }
}

export const globTool = {
  name: "glob",
  description: "Find files matching a glob pattern (e.g. **/*.ts, src/**/*.mjs, tests/**/*.test.*)",
  risk: "low",
  inputSchema: {
    type: "object",
    properties: {
      pattern:    { type: "string" },
      path:       { type: "string", description: "Root directory to search from (default: cwd)" },
      maxResults: { type: "number", description: "Max files to return (default: 200)" }
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
    const maxResults = typeof args.maxResults === "number" ? args.maxResults : 200;
    const regex = new RegExp("^" + globToRegex(args.pattern) + "$");
    const results = [];
    await walk(root, root, regex, results, maxResults);
    return {
      pattern: args.pattern,
      root: relative(context.cwd || process.cwd(), root) || ".",
      count: results.length,
      files: results,
      truncated: results.length >= maxResults
    };
  }
};
