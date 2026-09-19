import { ToolRegistry } from "./registry.mjs";
import { createPermissionChecker } from "../permissions/checker.mjs";
import { echoTool } from "./builtin/echo.mjs";
import { listFilesTool } from "./builtin/list-files.mjs";
import { readFileTool } from "./builtin/read-file.mjs";
import { writeFileTool } from "./builtin/write-file.mjs";
import { editFileTool } from "./builtin/edit-file.mjs";
import { createPatchTool } from "./builtin/create-patch.mjs";
import { applyPatchTool } from "./builtin/apply-patch.mjs";
import { searchCodeTool } from "./builtin/search-code.mjs";
import { repoMapTool } from "./builtin/repo-map.mjs";
import { runShellTool } from "./builtin/run-shell.mjs";
import { runLinterTool } from "./builtin/run-linter.mjs";
import { runTypecheckTool } from "./builtin/run-typecheck.mjs";
import { runTestsTool } from "./builtin/run-tests.mjs";
import { runVerificationTool } from "./builtin/run-verification.mjs";
import {
  findReferencesTool,
  findSymbolTool,
  indexHealthTool,
  listModulesTool
} from "./builtin/intelligence-tools.mjs";
import { ghIssueCommentTool, ghIssueReadTool, ghPrCreateTool, ghPrReviewTool } from "./builtin/github-tools.mjs";
import { runSubagentTool } from "./builtin/run-subagent.mjs";
import { globTool } from "./builtin/glob.mjs";
import { deleteFileTool } from "./builtin/delete-file.mjs";
import { renameFileTool } from "./builtin/rename-file.mjs";
import { grepTool } from "./builtin/grep.mjs";
import { multiEditTool } from "./builtin/multi-edit.mjs";
import { webFetchTool } from "./builtin/web-fetch.mjs";
import { webSearchTool } from "./builtin/web-search.mjs";
import { todoWriteTool, todoReadTool } from "./builtin/todo.mjs";
import { checkGroundednessTool } from "./builtin/check-groundedness.mjs";
import {
  browserOpenTool, browserSnapshotTool, browserClickTool, browserTypeTool,
  browserConsoleTool, browserScreenshotTool, browserCloseTool
} from "./builtin/browser-tools.mjs";
import { readDocumentTool } from "./builtin/read-document.mjs";
import { semanticSearchTool } from "./builtin/semantic-search.mjs";
import { loadSkillTool } from "./builtin/load-skill.mjs";
import { McpClientManager } from "./mcp/client-manager.mjs";
import { createMcpTool } from "./mcp/mcp-tool.mjs";
import { createDiscoveredTool } from "./discovery/discovered-tool.mjs";
import { discoverToolSpecsFromCommand } from "./discovery/loader.mjs";
import { runSandboxedProcess } from "../sandbox/exec.mjs";

function parseCommand(command) {
  if (typeof command !== "string" || command.trim().length === 0) {
    return null;
  }
  const parts = command.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) {
    return null;
  }
  return {
    binary: parts[0],
    args: parts.slice(1)
  };
}

export function createDiscoveredToolInvoker({ command, cwd, onLog }) {
  const parsed = parseCommand(command);
  if (!parsed) {
    throw new Error("discovery invoke command is required");
  }

  return async (toolName, args, context = {}) => {
    const payload = {
      tool: toolName,
      args: args || {},
      context: {
        cwd: context.cwd || cwd,
        sessionId: context.session?.id || null
      }
    };
    const payloadBase64 = Buffer.from(JSON.stringify(payload), "utf8").toString("base64");

    const result = await runSandboxedProcess(
      parsed.binary,
      [...parsed.args, toolName, payloadBase64],
      {
        cwd: context.cwd || cwd,
        timeoutMs: 120000,
        outputLimit: 120000,
        networkBlocked: false,
        onStdout: (text) => onLog?.({ stage: "discover-invoke", channel: "stdout", text }),
        onStderr: (text) => onLog?.({ stage: "discover-invoke", channel: "stderr", text })
      }
    );

    if (!result.ok) {
      throw new Error(result.stderr || result.stdout || `discovered tool failed: ${toolName}`);
    }

    const output = String(result.stdout || "").trim();
    if (!output) {
      return {};
    }

    try {
      return JSON.parse(output);
    } catch {
      return { output };
    }
  };
}

export function createRegistry(policy) {
  const registry = new ToolRegistry({ ...policy, hookEngine: policy.hookEngine });
  if (policy.permissionMode) {
    registry.permissionChecker = createPermissionChecker({ mode: policy.permissionMode });
  }
  if (policy.permissionChecker) {
    registry.permissionChecker = policy.permissionChecker;
  }
  registry.register(echoTool);
  registry.register(listFilesTool);
  registry.register(readFileTool);
  registry.register(writeFileTool);
  registry.register(editFileTool);
  registry.register(createPatchTool);
  registry.register(applyPatchTool);
  registry.register(searchCodeTool);
  registry.register(repoMapTool);
  registry.register(findSymbolTool);
  registry.register(findReferencesTool);
  registry.register(listModulesTool);
  registry.register(indexHealthTool);
  registry.register(runShellTool);
  registry.register(runLinterTool);
  registry.register(runTypecheckTool);
  registry.register(runTestsTool);
  registry.register(runVerificationTool);
  registry.register(runSubagentTool);
  registry.register(ghIssueReadTool);
  registry.register(ghIssueCommentTool);
  registry.register(ghPrCreateTool);
  registry.register(ghPrReviewTool);
  registry.register(globTool);
  registry.register(deleteFileTool);
  registry.register(renameFileTool);
  registry.register(grepTool);
  registry.register(multiEditTool);
  registry.register(webFetchTool);
  registry.register(webSearchTool);
  registry.register(todoWriteTool);
  registry.register(todoReadTool);
  registry.register(checkGroundednessTool);
  registry.register(browserOpenTool);
  registry.register(browserSnapshotTool);
  registry.register(browserClickTool);
  registry.register(browserTypeTool);
  registry.register(browserConsoleTool);
  registry.register(browserScreenshotTool);
  registry.register(browserCloseTool);
  registry.register(readDocumentTool);
  registry.register(semanticSearchTool);
  registry.register(loadSkillTool);
  return registry;
}

export function registerDiscoveredTools(registry, specs = [], invoke) {
  for (const spec of specs) {
    const tool = createDiscoveredTool(spec, invoke);
    registry.register(tool);
  }
}

export async function registerMcpServerTools(registry, manager, serverName) {
  const tools = await manager.listTools(serverName);
  for (const toolSpec of tools) {
    const tool = createMcpTool({
      serverName,
      toolName: toolSpec.name,
      description: toolSpec.description,
      inputSchema: toolSpec.inputSchema,
      risk: toolSpec.risk,
      actionClass: toolSpec.actionClass,
      manager
    });
    registry.register(tool);
  }
}

/**
 * Resolves the `discovery` option `createRegistryWithExtensions()` expects
 * (`{command, onLog, invoke}`), reading the two env vars a tool-discovery
 * subprocess is configured with (`UPSTAGE_DISCOVERY_COMMAND`, optionally a
 * distinct `UPSTAGE_DISCOVERY_INVOKE_COMMAND` — falls back to the discover
 * command when unset). Returns `null` when discovery isn't configured, so
 * callers can pass the result straight through as `discovery` unconditionally.
 *
 * The single source of truth for this resolution — every caller that builds
 * a registry from live process env (src/cli/index.mjs's session wiring,
 * `upstage tools list/show`'s buildFullToolRegistry(), and
 * computeContextBudget()'s repo-level report) must resolve discovery
 * identically, or some of them will silently miss discovered tools relative
 * to the others. `onLog` defaults to a no-op; pass one to surface
 * discover/invoke subprocess stdout/stderr.
 */
export function discoveryConfigFromEnv({ cwd, onLog = () => {} } = {}) {
  const discoverCommand = process.env.UPSTAGE_DISCOVERY_COMMAND;
  if (typeof discoverCommand !== "string" || discoverCommand.trim().length === 0) {
    return null;
  }

  const invokeCommand =
    process.env.UPSTAGE_DISCOVERY_INVOKE_COMMAND && process.env.UPSTAGE_DISCOVERY_INVOKE_COMMAND.trim().length > 0
      ? process.env.UPSTAGE_DISCOVERY_INVOKE_COMMAND
      : discoverCommand;

  return {
    command: discoverCommand,
    onLog,
    invoke: createDiscoveredToolInvoker({ command: invokeCommand, cwd, onLog })
  };
}

export async function createRegistryWithExtensions({ policy = {}, cwd, discovery, mcpServers = [], permissionMode, permissionChecker, hookEngine } = {}) {
  const registry = createRegistry({ ...policy, permissionMode, permissionChecker, hookEngine });

  if (discovery?.command && typeof discovery.invoke === "function") {
    const specs = await discoverToolSpecsFromCommand({
      command: discovery.command,
      cwd,
      onLog: discovery.onLog
    });
    registerDiscoveredTools(registry, specs, discovery.invoke);
  }

  if (Array.isArray(mcpServers) && mcpServers.length > 0) {
    const manager = new McpClientManager();
    for (const server of mcpServers) {
      manager.registerServer(server.name, server.client);
      await registerMcpServerTools(registry, manager, server.name);
    }
  }

  return registry;
}
