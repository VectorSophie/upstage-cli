import { readFile } from "node:fs/promises";
import { relative } from "node:path";
import { createUnifiedDiff } from "../lib/patch.mjs";
import { resolveWorkspacePath } from "../lib/fs-utils.mjs";

export const createPatchTool = {
  name: "create_patch",
  description: "Create a patch preview for file changes without applying",
  risk: "low",
  inputSchema: {
    type: "object",
    properties: {
      path: { type: "string" },
      newContent: { type: "string" }
    },
    required: ["path", "newContent"],
    additionalProperties: false
  },
  async execute(args, context) {
    if (typeof args.path !== "string" || typeof args.newContent !== "string") {
      throw new Error("path and newContent are required");
    }
    const absolutePath = resolveWorkspacePath(context.cwd, args.path);
    let previousContent = "";
    try {
      previousContent = await readFile(absolutePath, "utf8");
    } catch (e) {
      if (e.code !== "ENOENT") throw e;
    }
    const relativePath = relative(context.cwd, absolutePath).split("\\").join("/");
    const unifiedDiff = createUnifiedDiff(previousContent, args.newContent, relativePath);

    return {
      patch: {
        version: 1,
        path: relativePath,
        previousContent,
        newContent: args.newContent,
        unifiedDiff
      }
    };
  }
};
