import test from "node:test";
import assert from "node:assert/strict";

import {
  createRegistry,
  registerDiscoveredTools,
  registerMcpServerTools
} from "../src/tools/create-registry.js";
import { McpClientManager } from "../src/tools/mcp/client-manager.js";

test("registry supports builtin + discovered + mcp tools together", async () => {
  const registry = createRegistry({
    allowHighRiskTools: true,
    requireConfirmationForHighRisk: false
  });

  registerDiscoveredTools(
    registry,
    [
      {
        name: "project_lint",
        description: "Run project lint",
        risk: "medium",
        actionClass: "exec",
        inputSchema: {
          type: "object",
          properties: {},
          additionalProperties: false
        }
      }
    ],
    async (name, args) => ({ invoked: name, args })
  );

  const manager = new McpClientManager();
  manager.registerServer("repo", {
    async listTools() {
      return [
        {
          name: "issue_read",
          description: "Read issue",
          risk: "medium",
          actionClass: "network",
          inputSchema: {
            type: "object",
            properties: { id: { type: "number" } },
            required: ["id"],
            additionalProperties: false
          }
        }
      ];
    },
    async callTool(toolName, args) {
      return { server: "repo", toolName, args };
    }
  });

  await registerMcpServerTools(registry, manager, "repo");

  const discovered = registry.get("discovered__project_lint");
  const mcp = registry.get("repo__issue_read");
  const builtin = registry.get("read_file");

  assert.ok(discovered);
  assert.ok(mcp);
  assert.ok(builtin);
  assert.equal(discovered.source, "discovered");
  assert.equal(mcp.source, "mcp");
  assert.equal(builtin.source, "builtin");

  const sortedNames = registry.sortedList().map((tool) => tool.name);
  assert.ok(sortedNames.includes("read_file"));
  assert.ok(sortedNames.includes("discovered__project_lint"));
  assert.ok(sortedNames.includes("repo__issue_read"));

  const discoveryResult = await registry.execute("discovered__project_lint", {}, {});
  const mcpResult = await registry.execute("repo__issue_read", { id: 12 }, {});

  assert.equal(discoveryResult.ok, true);
  assert.equal(mcpResult.ok, true);
  assert.equal(mcpResult.data.server, "repo");
});
