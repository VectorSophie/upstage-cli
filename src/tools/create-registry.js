import { ToolRegistry } from "./registry.js";
import { echoTool } from "./builtin/echo.js";
import { listFilesTool } from "./builtin/list-files.js";
import { readFileTool } from "./builtin/read-file.js";
import { writeFileTool } from "./builtin/write-file.js";
import { editFileTool } from "./builtin/edit-file.js";
import { createPatchTool } from "./builtin/create-patch.js";
import { applyPatchTool } from "./builtin/apply-patch.js";
import { searchCodeTool } from "./builtin/search-code.js";
import { repoMapTool } from "./builtin/repo-map.js";
import { runShellTool } from "./builtin/run-shell.js";
import { runLinterTool } from "./builtin/run-linter.js";
import { runTypecheckTool } from "./builtin/run-typecheck.js";
import { runTestsTool } from "./builtin/run-tests.js";
import { runVerificationTool } from "./builtin/run-verification.js";
import {
  findReferencesTool,
  findSymbolTool,
  indexHealthTool,
  listModulesTool
} from "./builtin/intelligence-tools.js";
import { ghIssueCommentTool, ghIssueReadTool, ghPrCreateTool, ghPrReviewTool } from "./builtin/github-tools.js";
import { runSubagentTool } from "./builtin/run-subagent.js";
import { McpClientManager } from "./mcp/client-manager.js";
import { createMcpTool } from "./mcp/mcp-tool.js";
import { createDiscoveredTool } from "./discovery/discovered-tool.js";
import { discoverToolSpecsFromCommand } from "./discovery/loader.js";
import { runSandboxedProcess } from "../sandbox/exec.js";

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
  const registry = new ToolRegistry(policy);
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

export async function createRegistryWithExtensions({ policy = {}, cwd, discovery, mcpServers = [] } = {}) {
  const registry = createRegistry(policy);

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
