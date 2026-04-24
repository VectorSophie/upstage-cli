import test from "node:test";
import assert from "node:assert/strict";
import { readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import { join } from "node:path";

import {
  createDiscoveredToolInvoker,
  createRegistryWithExtensions
} from "../src/tools/create-registry.mjs";
import {
  createSession,
  listSessions,
  loadLatestSession,
  resetSession,
  saveSession
} from "../src/runtime/session.mjs";

test("createRegistryWithExtensions wires discovered tools with command invoker", async () => {
  const scriptPath = join(process.cwd(), `.tmp-discovery-${Date.now()}.mjs`);
  const script = [
    'const mode = process.argv[2];',
    'if (mode === "discover") {',
    '  process.stdout.write(JSON.stringify([',
    '    {',
    '      name: "echo_payload",',
    '      description: "Echo payload",',
    '      risk: "low",',
    '      actionClass: "read",',
    '      inputSchema: { type: "object", properties: { value: { type: "string" } }, additionalProperties: false }',
    '    }',
    '  ]));',
    '  process.exit(0);',
    '}',
    'if (mode === "invoke") {',
    '  const tool = process.argv[3];',
    '  const encoded = process.argv[4] || "";',
    '  const payload = JSON.parse(Buffer.from(encoded, "base64").toString("utf8"));',
    '  process.stdout.write(JSON.stringify({ tool, payload }));',
    '  process.exit(0);',
    '}',
    'process.stdout.write("[]");'
  ].join("\n");
  await writeFile(scriptPath, script, "utf8");

  try {
    const registry = await createRegistryWithExtensions({
      policy: {
        allowHighRiskTools: true,
        requireConfirmationForHighRisk: false
      },
      cwd: process.cwd(),
      discovery: {
        command: `node ${scriptPath} discover`,
        invoke: createDiscoveredToolInvoker({
          command: `node ${scriptPath} invoke`,
          cwd: process.cwd()
        })
      }
    });

    const discovered = registry.get("discovered__echo_payload");
    assert.ok(discovered);

    const result = await registry.execute("discovered__echo_payload", { value: "hello" }, { cwd: process.cwd() });
    assert.equal(result.ok, true);
    assert.equal(result.data.tool, "echo_payload");
    assert.equal(result.data.payload.args.value, "hello");
  } finally {
    await rm(scriptPath, { force: true });
  }
});

test("session list uses persisted index metadata", async () => {
  const uniqueCwd = `${process.cwd()}/.__session-index-${Date.now()}`;
  const first = createSession(uniqueCwd);
  const second = createSession(uniqueCwd);
  second.updatedAt = first.updatedAt + 10;

  await saveSession(first);
  await saveSession(second);

  try {
    const sessions = await listSessions();
    const firstMeta = sessions.find((item) => item.id === first.id);
    const secondMeta = sessions.find((item) => item.id === second.id);

    assert.ok(firstMeta);
    assert.ok(secondMeta);

    const latest = await loadLatestSession(uniqueCwd);
    assert.ok(latest);
    assert.equal(latest.id, second.id);

    const indexPath = join(os.homedir(), ".upstage-cli", "sessions", "index.json");
    const rawIndex = await readFile(indexPath, "utf8");
    const parsedIndex = JSON.parse(rawIndex);
    const indexedIds = new Set((parsedIndex.sessions || []).map((item) => item.id));

    assert.ok(indexedIds.has(first.id));
    assert.ok(indexedIds.has(second.id));
  } finally {
    await resetSession(first.id);
    await resetSession(second.id);
  }
});
