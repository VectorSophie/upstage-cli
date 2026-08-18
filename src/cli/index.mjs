#!/usr/bin/env bun
import process from "node:process";
import { isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  createDiscoveredToolInvoker,
  createRegistryWithExtensions
} from "../tools/create-registry.mjs";
import { loadMcpServerConfigs, connectConfiguredServers } from "../tools/mcp/config.mjs";
import { runAgentLoop } from "../agent/loop.mjs";
import { DEFAULT_POLICY } from "../config/defaults.mjs";
import { loadProjectEnv } from "../config/load-env.mjs";
import { loadSettings } from "../config/settings.mjs";
import { parseCliArgs, getUsageText } from "../config/cli-args.mjs";
import { UpstageAdapter } from "../model/upstage-adapter.mjs";
import { OpenAIAdapter } from "../model/openai-adapter.mjs";
import { GeminiAdapter } from "../model/gemini-adapter.mjs";
import { ModelRouter } from "../model/router.mjs";
import { getProvider } from "../core/providers.mjs";

function createBaseAdapter({ model, reasoningEffort } = {}) {
  const provider = getProvider(model);
  if (provider.id === "openai") return new OpenAIAdapter({ model });
  if (provider.id === "gemini") return new GeminiAdapter({ model });
  // reasoning_effort is a Solar Pro2-specific parameter; only the Upstage
  // adapter understands it, so it's never passed to the other providers.
  return new UpstageAdapter({ model: model || undefined, reasoningEffort });
}

function createAdapter({ model, reasoningEffort } = {}) {
  const proAdapter = createBaseAdapter({ model, reasoningEffort });
  const fastModel = process.env.UPSTAGE_FAST_MODEL;
  if (fastModel && fastModel !== proAdapter.model) {
    const fastAdapter = createBaseAdapter({ model: fastModel, reasoningEffort });
    return new ModelRouter({ proAdapter, fastAdapter });
  }
  return proAdapter;
}
import {
  createInteractiveApprovalHandler,
  createNonInteractiveApprovalHandler
} from "../core/policy/approvals.mjs";
import { createPermissionChecker } from "../permissions/checker.mjs";
import {
  createSession,
  loadLatestSession,
  loadSession,
  resetSession,
  saveSession
} from "../runtime/session.mjs";
import {
  canUseFullscreenTui,
  exitFullscreenTui,
  renderEvent
} from "../ui/plain-event-renderer.mjs";
import { AgentLoader } from "../agents/loader.mjs";
import { SkillsLoader } from "../skills/loader.mjs";
import { HookEngine } from "../hooks/engine.mjs";
import { PluginLoader } from "../plugins/loader.mjs";

function mergeHookMaps(base, extra) {
  const out = { ...base };
  for (const [event, defs] of Object.entries(extra || {})) {
    if (!Array.isArray(defs)) continue;
    out[event] = (out[event] || []).concat(defs);
  }
  return out;
}

function parseArgs(argv) {
  const result = parseCliArgs(argv);
  const compat = {
    command: result.command,
    help: result.help,
    prompt: result.prompt,
    stream: result.stream,
    model: result.model,
    sessionId: result.sessionId,
    newSession: result.newSession,
    resetSession: result.resetSession,
    confirmPatches: result.confirmPatches,
    bridgeJson: result.bridgeJson,
  };
  if (result.permissionMode) compat.permissionMode = result.permissionMode;
  if (result.systemPrompt) compat.systemPrompt = result.systemPrompt;
  if (result.addDirs?.length) compat.addDirs = result.addDirs;
  if (result.maxTurns) compat.maxTurns = result.maxTurns;
  if (result.language) compat.language = result.language;
  if (result.verbose) compat.verbose = result.verbose;
  if (result.debug) compat.debug = result.debug;
  return compat;
}

function printHelp() {
  console.log(getUsageText());
}

function parseVerifyStages(rawValue) {
  if (typeof rawValue !== "string" || rawValue.trim().length === 0) {
    return null;
  }
  const stages = rawValue
    .split(",")
    .map((stage) => stage.trim())
    .filter((stage) => stage.length > 0);
  return stages.length > 0 ? stages : null;
}

function toAbsolutePath(baseDir, rawPath) {
  if (typeof rawPath !== "string" || rawPath.trim().length === 0) {
    return null;
  }
  return isAbsolute(rawPath) ? rawPath : resolve(baseDir, rawPath);
}

async function loadMcpServersFromEnv(cwd) {
  const modulePath = toAbsolutePath(cwd, process.env.UPSTAGE_MCP_SERVERS_MODULE);
  if (!modulePath) {
    return [];
  }

  const loaded = await import(pathToFileURL(modulePath).href);
  const candidate = loaded?.default ?? loaded?.mcpServers;
  if (!Array.isArray(candidate)) {
    throw new Error("UPSTAGE_MCP_SERVERS_MODULE must export an array as default or mcpServers");
  }

  return candidate;
}

/**
 * Collect every MCP server to register: the legacy in-process module
 * (UPSTAGE_MCP_SERVERS_MODULE) plus real stdio servers connected from
 * `.mcp.json` / settings.mcpServers. Connection failures are isolated.
 */
async function loadAllMcpServers(cwd, settings) {
  const moduleServers = await loadMcpServersFromEnv(cwd);

  const onLog = (msg) => process.stderr.write(`[mcp] ${msg}\n`);
  const configs = await loadMcpServerConfigs(cwd, settings, { onLog });
  const { servers, closeAll } = await connectConfiguredServers(configs, { cwd, onLog });
  if (servers.length > 0) {
    process.once("exit", () => { closeAll().catch(() => {}); });
  }

  return [...moduleServers, ...servers];
}

function createDiscoveryConfigFromEnv(cwd) {
  const discoverCommand = process.env.UPSTAGE_DISCOVERY_COMMAND;
  if (typeof discoverCommand !== "string" || discoverCommand.trim().length === 0) {
    return null;
  }

  const invokeCommand =
    process.env.UPSTAGE_DISCOVERY_INVOKE_COMMAND &&
    process.env.UPSTAGE_DISCOVERY_INVOKE_COMMAND.trim().length > 0
      ? process.env.UPSTAGE_DISCOVERY_INVOKE_COMMAND
      : discoverCommand;

  const onLog = (payload) => {
    const text = typeof payload?.text === "string" ? payload.text.trim() : "";
    if (!text) {
      return;
    }
    process.stderr.write(`[discovery:${payload.stage || "log"}:${payload.channel || "out"}] ${text}\n`);
  };

  return {
    command: discoverCommand,
    onLog,
    invoke: createDiscoveredToolInvoker({
      command: invokeCommand,
      cwd,
      onLog
    })
  };
}

async function loadOrCreateSession(args, cwd) {
  if (args.sessionId) {
    const loaded = await loadSession(args.sessionId);
    if (args.resetSession) {
      await resetSession(args.sessionId);
      return createSession(cwd);
    }
    return loaded;
  }
  if (args.newSession) {
    return createSession(cwd);
  }
  const existing = await loadLatestSession(cwd);
  return existing || createSession(cwd);
}

async function executePrompt({ prompt, registry, adapter, stream, session, args, runtimeCache, rl, settings }) {
  const bridgeJson = args.bridgeJson === true;
  let streamedAnyToken = false;
  const emitBridge = (payload) => {
    process.stdout.write(`${JSON.stringify(payload)}\n`);
  };
  const approvalHandler =
    args.confirmPatches && args.command === "chat" && rl
      ? createInteractiveApprovalHandler({
          rl,
          onEvent: (event) => {
            if (bridgeJson) {
              emitBridge({ type: "event", event });
            } else {
              renderEvent(event);
            }
          }
        })
      : args.confirmPatches
        ? createNonInteractiveApprovalHandler({
            mode: "deny",
            onEvent: (event) => {
              if (bridgeJson) {
                emitBridge({ type: "event", event });
              } else {
                renderEvent(event);
              }
            }
          })
        : undefined;

  const handleEvent = (event) => {
    if (event.type === "stream_token" && stream) {
      const token = event.text || "";
      if (token) {
        streamedAnyToken = true;
        if (bridgeJson) {
          emitBridge({ type: "token", token });
        } else {
          process.stdout.write(token);
        }
      }
      return;
    }
    if (event.type === "tool_start") {
      const legacyEvent = { type: "TOOL", tool: event.tool, args: event.args };
      if (bridgeJson) {
        emitBridge({ type: "event", event: legacyEvent });
      } else {
        renderEvent(legacyEvent);
      }
      return;
    }
    if (event.type === "tool_result") {
      const legacyEvent = { type: "OBSERVATION", tool: event.tool, ok: event.ok, result: event.result };
      if (bridgeJson) {
        emitBridge({ type: "event", event: legacyEvent });
      } else {
        renderEvent(legacyEvent);
      }
      return;
    }
    if (event.type === "thinking") {
      const legacyEvent = { type: "THINKING", thought: event.thought };
      if (bridgeJson) {
        emitBridge({ type: "event", event: legacyEvent });
      } else {
        renderEvent(legacyEvent);
      }
      return;
    }
    if (event.type === "plan") {
      const legacyEvent = { type: "PLAN", mode: event.mode, contextSummary: event.contextSummary, keywords: event.keywords };
      if (bridgeJson) {
        emitBridge({ type: "event", event: legacyEvent });
      } else {
        renderEvent(legacyEvent);
      }
      return;
    }
    if (event.type === "patch_preview") {
      const legacyEvent = { type: "PATCH_PREVIEW", patch: event.patch };
      if (bridgeJson) {
        emitBridge({ type: "event", event: legacyEvent });
      } else {
        renderEvent(legacyEvent);
      }
      return;
    }
    if (event.type === "token_usage") {
      const legacyEvent = { type: "TOKEN_USAGE", usage: event.usage, model: event.model, source: event.source };
      if (bridgeJson) {
        emitBridge({ type: "event", event: legacyEvent });
      } else {
        renderEvent(legacyEvent);
      }
      return;
    }
    if (event.type === "system_warning") {
      const legacyEvent = { type: "SYSTEM_WARNING", level: event.level, code: event.code, message: event.message, usage: event.usage };
      if (bridgeJson) {
        emitBridge({ type: "event", event: legacyEvent });
      } else {
        renderEvent(legacyEvent);
      }
      return;
    }
    if (event.type === "verify_start" || event.type === "verify_end") {
      const legacyEvent = { type: "VERIFY_RESULT", stage: event.type === "verify_start" ? "start" : "end" };
      if (bridgeJson) {
        emitBridge({ type: "event", event: legacyEvent });
      } else {
        renderEvent(legacyEvent);
      }
      return;
    }
    if (event.type === "critic") {
      if (!bridgeJson) {
        const stage = event.stage || "";
        if (stage === "start") process.stderr.write("\n[critic] running tests...\n");
        else if (stage === "pass") process.stderr.write("[critic] tests pass ✓\n");
        else if (stage === "fail") process.stderr.write(`[critic] tests failed (cycle ${event.cycles})\n`);
      }
      return;
    }
    if (event.type === "replan") {
      if (!bridgeJson) {
        process.stderr.write(`\n[replan] trigger=${event.trigger} count=${event.count}\n`);
      }
      return;
    }
    if (event.type === "tool_log" || event.type === "lifecycle" || event.type === "compaction" ||
        event.type === "hook_permission_result" || event.type === "stop" || event.type === "error") {
      // Known event types we intentionally suppress in plain output mode
      return;
    }
  };

  let result;
  const gen = runAgentLoop({
    input: prompt,
    registry,
    cwd: process.cwd(),
    adapter,
    stream,
    confirm: approvalHandler,
    session,
    runtimeCache,
    settings,
    systemPromptOverride: args.systemPrompt || null,
    addDirs: args.addDirs || []
  });

  while (true) {
    const next = await gen.next();
    if (next.done) {
      result = next.value;
      break;
    }
    handleEvent(next.value);
  }

  if (stream && streamedAnyToken && !bridgeJson) {
    process.stdout.write("\n");
  }
  if (!streamedAnyToken || !result.ok) {
    if (bridgeJson) {
      emitBridge({ type: "assistant", text: result.response });
    } else {
      console.log(result.response);
    }
  }
  if (bridgeJson) {
    emitBridge({
      type: "result",
      ok: result.ok,
      response: result.response,
      stopReason: result.stopReason,
      sessionId: result.session?.id || session.id
    });
  } else {
    console.log(`[stop_reason=${result.stopReason}]`);
  }
  await saveSession(result.session || session);
  if (!result.ok) {
    process.exitCode = 1;
  }
}

import React from "react";
import { createCliRenderer } from "@opentui/core";
import { createRoot } from "@opentui/react";
import App from "../ui/App.mjs";
import { THEME } from "../ui/colors.mjs";

async function runInteractive(registry, adapter, args, session, runtimeCache, settings, onRenderer) {
  const renderer = await createCliRenderer({ exitOnCtrlC: false, useKittyKeyboard: null, backgroundColor: THEME.background });
  onRenderer?.(renderer);
  const exited = new Promise((resolve) => renderer.once("destroy", resolve));
  createRoot(renderer).render(React.createElement(App, {
    sessionId: session.id,
    registry,
    adapter,
    args,
    session,
    runtimeCache,
    settings
  }));
  await exited;
  onRenderer?.(null);
}

async function main() {
  await loadProjectEnv(process.cwd());

  const args = parseArgs(process.argv.slice(2));
  const settings = await loadSettings({ cwd: process.cwd() });

  if (args.model) {
    settings.model = args.model;
  }
  if (args.language) {
    settings.language = args.language;
  }
  if (args.debug) {
    settings.debugMode = true;
  }

  let restored = false;
  // Set while the OpenTUI renderer is mounted (see runInteractive). destroy()
  // is the authoritative terminal-state reversal — it undoes everything the
  // renderer itself turned on (mouse tracking, kitty-keyboard protocol,
  // synchronized-update mode, alt-screen, cursor), not just alt-screen like
  // the legacy exitFullscreenTui() fallback below. It must be used here
  // rather than left to fire on its own: OpenTUI wires its own cleanup to
  // `beforeExit`, which Node/Bun skips entirely once something calls
  // process.exit() explicitly, as onFatal does a few lines down.
  let activeRenderer = null;
  const restoreTerminal = () => {
    if (restored) {
      return;
    }
    restored = true;
    if (activeRenderer) {
      activeRenderer.destroy();
    } else if (canUseFullscreenTui()) {
      exitFullscreenTui();
    }
  };

  const onFatal = (error) => {
    restoreTerminal();
    if (error) {
      console.error(error instanceof Error ? error.message : String(error));
    }
    process.exit(1);
  };

  process.on("uncaughtException", onFatal);
  process.on("unhandledRejection", onFatal);

  if (args.help) {
    printHelp();
    process.off("uncaughtException", onFatal);
    process.off("unhandledRejection", onFatal);
    return;
  }

  const policy = {
    ...DEFAULT_POLICY,
    allowHighRiskTools: !args.confirmPatches,
    requireConfirmationForHighRisk: args.confirmPatches
  };

  const permissionMode = args.permissionMode || settings.permissions?.defaultMode || "default";
  const permissionChecker = createPermissionChecker({ mode: permissionMode });

  const cwd = process.cwd();
  const verifyStages = parseVerifyStages(process.env.UPSTAGE_VERIFY_STAGES);
  const discovery = createDiscoveryConfigFromEnv(cwd);

  // Discover Claude-compatible plugins and merge their components into the
  // settings/loaders before everything downstream is built.
  const pluginLoader = await new PluginLoader().load(cwd);
  const mergedSettings = {
    ...settings,
    hooks: mergeHookMaps(settings.hooks || {}, pluginLoader.hooks),
    mcpServers: { ...pluginLoader.mcpServers, ...(settings.mcpServers || {}) }
  };

  const mcpServers = await loadAllMcpServers(cwd, mergedSettings);
  const agentLoader = new AgentLoader();
  await agentLoader.load(cwd);
  for (const def of pluginLoader.agents) {
    if (!agentLoader.has(def.name)) agentLoader.agents.set(def.name, def);
  }
  const skillsLoader = new SkillsLoader();
  await skillsLoader.load(cwd);
  for (const s of pluginLoader.skills) {
    if (!skillsLoader.skills.has(s.name)) {
      skillsLoader.skills.set(s.name, { name: s.name, description: s.description, aliases: [], trigger: null, prompt: s.prompt });
    }
  }

  const hookEngine = new HookEngine(mergedSettings.hooks || {});

  const runtimeCache = {
    verifyStages,
    agentLoader,
    skillsLoader,
    // checkpointManager is attached by runAgentLoop when fileCheckpointingEnabled
  };
  const registry = await createRegistryWithExtensions({
    policy,
    cwd,
    discovery,
    mcpServers,
    permissionMode,
    permissionChecker,
    hookEngine
  });
  const adapter = createAdapter({
    model: args.model || settings.model || undefined,
    reasoningEffort: settings.reasoningEffort && settings.reasoningEffort !== "auto" ? settings.reasoningEffort : undefined
  });
  const session = await loadOrCreateSession(args, process.cwd());
  await saveSession(session);
  hookEngine.runSessionStart(session.id || "");

  if (args.command === "ask" || args.prompt) {
    const prompt = args.prompt || "";
    if (!prompt) {
      console.log("프롬프트를 입력해 주세요.");
      process.exitCode = 1;
      return;
    }
    await executePrompt({
      prompt,
      registry,
      adapter,
      stream: args.stream,
      session,
      args,
      runtimeCache,
      rl: null,
      settings
    });
    await hookEngine.runSessionEnd(session.id || "", "prompt_complete");
    process.off("uncaughtException", onFatal);
    process.off("unhandledRejection", onFatal);
    return;
  }

  await runInteractive(registry, adapter, args, session, runtimeCache, settings, (r) => { activeRenderer = r; });
  await hookEngine.runSessionEnd(session.id || "", "exit");
  process.off("uncaughtException", onFatal);
  process.off("unhandledRejection", onFatal);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : "Unhandled error");
  process.exit(1);
});
