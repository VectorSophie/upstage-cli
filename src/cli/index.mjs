#!/usr/bin/env node
import readline from "node:readline";
import process from "node:process";
import { isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  createDiscoveredToolInvoker,
  createRegistryWithExtensions
} from "../tools/create-registry.mjs";
import { runAgentLoop } from "../agent/loop.mjs";
import { DEFAULT_POLICY } from "../config/defaults.mjs";
import { loadProjectEnv } from "../config/load-env.mjs";
import { loadSettings } from "../config/settings.mjs";
import { parseCliArgs, getUsageText } from "../config/cli-args.mjs";
import { UpstageAdapter } from "../model/upstage-adapter.mjs";
import {
  createInteractiveApprovalHandler,
  createNonInteractiveApprovalHandler
} from "../core/policy/approvals.mjs";
import { createPermissionChecker } from "../permissions/checker.mjs";
import {
  createSession,
  listSessions,
  loadLatestSession,
  loadSession,
  resetSession,
  saveSession
} from "../runtime/session.mjs";
import {
  canUseFullscreenTui,
  createChatScreen,
  enterFullscreenTui,
  exitFullscreenTui,
  renderEvent,
  renderFileTree,
  renderHelpKorean,
  renderMainHeader,
  renderSessionList,
  renderTaskSummary,
  renderToolList
} from "../ui/tui.mjs";
import { getDefaultCommands, rankCommands } from "../ui/command-palette.mjs";

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
  const screen = args.__screen || null;
  const bridgeJson = args.bridgeJson === true;
  let streamedAnyToken = false;
  const emitBridge = (payload) => {
    process.stdout.write(`${JSON.stringify(payload)}\n`);
  };
  if (screen) {
    screen.setStatus("추론 중");
    screen.clearAssistant();
    screen.pushUserMessage(prompt);
    screen.redraw();
  }
  const approvalHandler =
    args.confirmPatches && args.command === "chat" && rl
      ? createInteractiveApprovalHandler({
          rl,
          onEvent: (event) => {
            if (bridgeJson) {
              emitBridge({ type: "event", event });
            } else if (screen) {
              screen.onEvent(event);
              screen.redraw();
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
              } else if (screen) {
                screen.onEvent(event);
                screen.redraw();
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
        } else if (screen) {
          screen.appendAssistantToken(token);
          screen.redraw();
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
      } else if (screen) {
        screen.onEvent(legacyEvent);
        screen.redraw();
      } else {
        renderEvent(legacyEvent);
      }
      return;
    }
    if (event.type === "tool_result") {
      const legacyEvent = { type: "OBSERVATION", tool: event.tool, ok: event.ok, result: event.result };
      if (bridgeJson) {
        emitBridge({ type: "event", event: legacyEvent });
      } else if (screen) {
        screen.onEvent(legacyEvent);
        screen.redraw();
      } else {
        renderEvent(legacyEvent);
      }
      return;
    }
    if (event.type === "thinking") {
      const legacyEvent = { type: "THINKING", thought: event.thought };
      if (bridgeJson) {
        emitBridge({ type: "event", event: legacyEvent });
      } else if (screen) {
        screen.onEvent(legacyEvent);
        screen.redraw();
      } else {
        renderEvent(legacyEvent);
      }
      return;
    }
    if (event.type === "plan") {
      const legacyEvent = { type: "PLAN", mode: event.mode, contextSummary: event.contextSummary, keywords: event.keywords };
      if (bridgeJson) {
        emitBridge({ type: "event", event: legacyEvent });
      } else if (screen) {
        screen.onEvent(legacyEvent);
        screen.redraw();
      } else {
        renderEvent(legacyEvent);
      }
      return;
    }
    if (event.type === "patch_preview") {
      const legacyEvent = { type: "PATCH_PREVIEW", patch: event.patch };
      if (bridgeJson) {
        emitBridge({ type: "event", event: legacyEvent });
      } else if (screen) {
        screen.onEvent(legacyEvent);
        screen.redraw();
      } else {
        renderEvent(legacyEvent);
      }
      return;
    }
    if (event.type === "token_usage") {
      const legacyEvent = { type: "TOKEN_USAGE", usage: event.usage, model: event.model, source: event.source };
      if (bridgeJson) {
        emitBridge({ type: "event", event: legacyEvent });
      } else if (screen) {
        screen.onEvent(legacyEvent);
        screen.redraw();
      } else {
        renderEvent(legacyEvent);
      }
      return;
    }
    if (event.type === "system_warning") {
      const legacyEvent = { type: "SYSTEM_WARNING", level: event.level, code: event.code, message: event.message, usage: event.usage };
      if (bridgeJson) {
        emitBridge({ type: "event", event: legacyEvent });
      } else if (screen) {
        screen.onEvent(legacyEvent);
        screen.redraw();
      } else {
        renderEvent(legacyEvent);
      }
      return;
    }
    if (event.type === "verify_start" || event.type === "verify_end") {
      const legacyEvent = { type: "VERIFY_RESULT", stage: event.type === "verify_start" ? "start" : "end" };
      if (bridgeJson) {
        emitBridge({ type: "event", event: legacyEvent });
      } else if (screen) {
        screen.onEvent(legacyEvent);
        screen.redraw();
      } else {
        renderEvent(legacyEvent);
      }
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

  if (stream && streamedAnyToken) {
    if (!screen && !bridgeJson) {
      process.stdout.write("\n");
    }
  }
  if (!streamedAnyToken || !result.ok) {
    if (bridgeJson) {
      emitBridge({ type: "assistant", text: result.response });
    } else if (screen) {
      screen.setAssistantFinal(result.response);
      screen.redraw();
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
  } else if (screen) {
    screen.pushSolarMessage(result.response);
    screen.setStatus(result.ok ? "완료" : "실패");
    screen.setStopReason(result.stopReason);
    screen.log(`[stop_reason=${result.stopReason}]`);
    screen.redraw();
  } else {

    console.log(`[stop_reason=${result.stopReason}]`);
  }
  await saveSession(result.session || session);
  if (!result.ok) {
    process.exitCode = 1;
  }
}

import React from "react";
import { render } from "ink";
import App from "../ui/App.mjs";

async function runInteractive(registry, adapter, args, session, runtimeCache, settings) {
  const { waitUntilExit } = render(React.createElement(App, {
    sessionId: session.id,
    registry,
    adapter,
    args,
    session,
    runtimeCache,
    settings
  }));
  await waitUntilExit();
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
  const restoreTerminal = () => {
    if (restored) {
      return;
    }
    restored = true;
    if (canUseFullscreenTui()) {
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
  const mcpServers = await loadMcpServersFromEnv(cwd);
  const runtimeCache = {
    verifyStages
  };
  const registry = await createRegistryWithExtensions({
    policy,
    cwd,
    discovery,
    mcpServers,
    permissionMode,
    permissionChecker
  });
  const adapter = new UpstageAdapter({ model: args.model || undefined });
  const session = await loadOrCreateSession(args, process.cwd());
  await saveSession(session);

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
    process.off("uncaughtException", onFatal);
    process.off("unhandledRejection", onFatal);
    return;
  }

  await runInteractive(registry, adapter, args, session, runtimeCache, settings);
  process.off("uncaughtException", onFatal);
  process.off("unhandledRejection", onFatal);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : "Unhandled error");
  process.exit(1);
});
