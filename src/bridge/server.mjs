#!/usr/bin/env node
/**
 * upstage-bridge — entrypoint that runs the BridgeServer over stdio with the
 * real agent loop. An IDE extension spawns this and speaks NDJSON (see
 * docs/ide-bridge.md). Reuses the same agent stack as the CLI.
 */
import { BridgeServer } from "./bridge-server.mjs";
import { loadProjectEnv } from "../config/load-env.mjs";
import { createRegistryWithExtensions } from "../tools/create-registry.mjs";
import { DEFAULT_POLICY } from "../config/defaults.mjs";
import { createPermissionChecker } from "../permissions/checker.mjs";
import { HookEngine } from "../hooks/engine.mjs";
import { createSession } from "../runtime/session.mjs";
import { runAgentLoop } from "../agent/loop.mjs";
import { UpstageAdapter } from "../model/upstage-adapter.mjs";
import { OpenAIAdapter } from "../model/openai-adapter.mjs";
import { GeminiAdapter } from "../model/gemini-adapter.mjs";
import { getProvider } from "../core/providers.mjs";

function buildAdapter(model) {
  const provider = getProvider(model);
  if (provider.id === "openai") return new OpenAIAdapter({ model });
  if (provider.id === "gemini") return new GeminiAdapter({ model });
  return new UpstageAdapter({ model: model || undefined });
}

async function* runAgent({ prompt, cwd, sessionId }) {
  const permissionMode = process.env.UPSTAGE_PERMISSION_MODE || "acceptEdits";
  const registry = await createRegistryWithExtensions({
    policy: DEFAULT_POLICY,
    cwd,
    permissionMode,
    permissionChecker: createPermissionChecker({ mode: permissionMode }),
    hookEngine: new HookEngine({})
  });
  const session = createSession(cwd);
  session.id = sessionId || session.id;
  // Delegate to the shared loop; yields events, returns the result object.
  return yield* runAgentLoop({
    input: prompt,
    registry,
    cwd,
    adapter: buildAdapter(process.env.UPSTAGE_MODEL),
    stream: true,
    session,
    runtimeCache: {}
  });
}

export async function startBridge() {
  await loadProjectEnv(process.cwd()).catch(() => {});
  const server = new BridgeServer({ input: process.stdin, output: process.stdout, runAgent });
  await server.start();
}

const invokedDirectly =
  process.argv[1] && (process.argv[1].endsWith("server.mjs") || process.argv[1].includes("bridge/server"));
if (invokedDirectly) {
  startBridge().catch((err) => {
    process.stderr.write(`upstage-bridge fatal: ${err?.message || err}\n`);
    process.exit(1);
  });
}
