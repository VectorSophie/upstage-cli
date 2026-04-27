import { readFile } from "node:fs/promises";
import { relative } from "node:path";
import { resolveWorkspacePath } from "../lib/fs-utils.mjs";

export const readFileTool = {
  name: "read_file",
  description: "Reads a text file. Use offset and limit to read a slice of a large file.",
  risk: "low",
  inputSchema: {
    type: "object",
    properties: {
      path:   { type: "string" },
      offset: { type: "number", description: "First line to read, 1-based (default: 1)" },
      limit:  { type: "number", description: "Max lines to return (default: all)" }
    },
    required: ["path"],
    additionalProperties: false
  },
  async execute(args, context) {
    if (!args.path || typeof args.path !== "string") {
      throw new Error("path is required");
    }
    const filePath = resolveWorkspacePath(context.cwd, args.path);
    const raw = await readFile(filePath, "utf8");

    const hasSlice = typeof args.offset === "number" || typeof args.limit === "number";
    if (!hasSlice) {
      return { filePath: relative(context.cwd, filePath), content: raw, totalLines: raw.split(/\r?\n/).length };
    }

    const lines = raw.split(/\r?\n/);
    const start  = Math.max(0, (typeof args.offset === "number" ? args.offset : 1) - 1);
    const count  = typeof args.limit  === "number" ? args.limit : lines.length;
    const slice  = lines.slice(start, start + count);

    return {
      filePath:   relative(context.cwd, filePath),
      content:    slice.join("\n"),
      startLine:  start + 1,
      endLine:    start + slice.length,
      totalLines: lines.length,
      truncated:  start + slice.length < lines.length
    };
  }
};
