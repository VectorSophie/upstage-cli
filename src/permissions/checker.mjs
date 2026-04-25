import { checkInjection } from "./injection-check.mjs";
import { validatePath } from "./path-check.mjs";
import { requiresPermission, formatToolSummary } from "./prompt.mjs";

const PERMISSION_MODES = new Set([
  "default",
  "bypassPermissions",
  "acceptEdits",
  "auto",
  "dontAsk",
  "plan",
]);

export function createPermissionChecker(config = {}) {
  const mode = config.mode || config.defaultMode || process.env.UPSTAGE_PERMISSION_MODE || "default";
  const rl = config.rl || null;
  const bypassBash = config.bypassBash === true;

  return {
    mode,

    async check(toolName, input) {
      if (!PERMISSION_MODES.has(mode)) {
        return false;
      }

      if (toolName === "run_shell" && input?.command) {
        const injection = checkInjection(input.command);
        if (!injection.safe) {
          return false;
        }
      }

      const filePathKeys = ["path", "file_path", "filePath"];
      const writeTools = new Set(["write_file", "edit_file", "apply_patch", "create_patch"]);
      const readTools = new Set(["read_file", "list_files", "search_code", "repo_map"]);

      if (writeTools.has(toolName) || readTools.has(toolName)) {
        for (const key of filePathKeys) {
          if (typeof input?.[key] === "string") {
            const pathResult = validatePath(input[key], {
              write: writeTools.has(toolName),
              cwd: input.cwd,
            });
            if (!pathResult.safe) {
              return false;
            }
          }
        }
      }

      switch (mode) {
        case "bypassPermissions":
          return true;

        case "acceptEdits":
          if (toolName === "run_shell" || toolName === "run_subagent") {
            return !requiresPermission(toolName) || bypassBash;
          }
          return true;

        case "auto":
          return true;

        case "dontAsk":
          return false;

        case "plan":
          return toolName === "read_file" || toolName === "list_files" || toolName === "search_code" || toolName === "repo_map" || toolName === "echo";

        case "default":
        default:
          if (!requiresPermission(toolName)) return true;
          if (!rl) return true;
          return true;
      }
    },
  };
}

export function getPermissionModes() {
  return [...PERMISSION_MODES];
}
