import { readFile } from "node:fs/promises";
import { relative } from "node:path";
import { resolveWorkspacePath } from "../lib/fs-utils.js";

export const readFileTool = {
  name: "read_file",
  description: "Reads a text file",
  risk: "low",
  inputSchema: {
    type: "object",
    properties: {
      path: { type: "string" }
    },
    required: ["path"],
    additionalProperties: false
  },
  async execute(args, context) {
    if (!args.path || typeof args.path !== "string") {
      throw new Error("path is required");
    }
    const filePath = resolveWorkspacePath(context.cwd, args.path);
    const content = await readFile(filePath, "utf8");
    return { filePath: relative(context.cwd, filePath), content };
  }
};
