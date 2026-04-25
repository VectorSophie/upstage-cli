const SAFE_TOOLS = new Set([
  "echo",
  "read_file",
  "list_files",
  "search_code",
  "repo_map",
  "find_symbol",
  "find_references",
  "list_modules",
  "index_health",
]);

export function requiresPermission(toolName) {
  return !SAFE_TOOLS.has(toolName);
}

export function formatToolSummary(toolName, input) {
  switch (toolName) {
    case "run_shell":
      return `Bash: ${truncate(input.command || "", 60)}`;
    case "edit_file":
      return `Edit: ${input.path || input.file_path || "unknown file"}`;
    case "write_file":
      return `Write: ${input.path || input.file_path || "unknown file"} (${(input.content || "").length} chars)`;
    case "apply_patch":
      return `ApplyPatch: ${input.path || "unknown file"}`;
    case "create_patch":
      return `CreatePatch: ${input.path || "unknown file"}`;
    case "run_subagent":
      return `Subagent: ${truncate(input.prompt || "", 40)}`;
    default:
      return `${toolName}`;
  }
}

export async function promptPermission(toolName, input, rl) {
  if (!rl || typeof rl.question !== "function") {
    return false;
  }

  const summary = formatToolSummary(toolName, input);
  return new Promise((resolve) => {
    rl.question(`Allow ${summary}? [y/N] `, (answer) => {
      resolve(answer.trim().toLowerCase() === "y");
    });
  });
}

function truncate(str, maxLen) {
  if (str.length <= maxLen) return str;
  return str.substring(0, maxLen - 3) + "...";
}
