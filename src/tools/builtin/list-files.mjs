import { readdir } from "node:fs/promises";
import { relative } from "node:path";
import { resolveWorkspacePath } from "../lib/fs-utils.mjs";

export const listFilesTool = {
  name: "list_files",
  description: "Lists files in a directory",
  risk: "low",
  inputSchema: {
    type: "object",
    properties: {
      path: { type: "string" }
    },
    additionalProperties: false
  },
  async execute(args, context) {
    const target =
      typeof args.path === "string" && args.path.length > 0
        ? resolveWorkspacePath(context.cwd, args.path)
        : context.cwd;
    const entries = await readdir(target, { withFileTypes: true });
    return {
      path: relative(context.cwd, target) || ".",
      entries: entries.map((entry) => (entry.isDirectory() ? `${entry.name}/` : entry.name))
    };
  }
};
