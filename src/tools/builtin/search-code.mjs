import { readFile } from "node:fs/promises";
import { relative } from "node:path";
import { collectWorkspaceFiles, isLikelyTextFile } from "../lib/fs-utils.mjs";

export const searchCodeTool = {
  name: "search_code",
  description: "Search for a text pattern across repository files",
  risk: "low",
  inputSchema: {
    type: "object",
    properties: {
      pattern: { type: "string" },
      maxResults: { type: "number" }
    },
    required: ["pattern"],
    additionalProperties: false
  },
  async execute(args, context) {
    if (typeof args.pattern !== "string" || args.pattern.length === 0) {
      throw new Error("pattern is required");
    }
    const maxResults = Number.isInteger(args.maxResults) ? args.maxResults : 25;
    const files = await collectWorkspaceFiles(context.cwd, {
      maxFiles: 600,
      maxDepth: 8
    });
    const matches = [];
    const lowerPattern = args.pattern.toLowerCase();

    for (const filePath of files) {
      if (matches.length >= maxResults) {
        break;
      }
      if (!(await isLikelyTextFile(filePath))) {
        continue;
      }
      const content = await readFile(filePath, "utf8");
      const lines = content.split(/\r?\n/);
      for (let i = 0; i < lines.length; i += 1) {
        if (lines[i].toLowerCase().includes(lowerPattern)) {
          matches.push({ path: relative(context.cwd, filePath), line: i + 1, text: lines[i] });
          if (matches.length >= maxResults) {
            break;
          }
        }
      }
    }

    return { pattern: args.pattern, matches };
  }
};
