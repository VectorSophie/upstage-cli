import { AgentState, StopReason } from "../protocol/messages.js";
import { DEFAULT_LOOP_BUDGET } from "../config/defaults.js";
import { buildContext, formatContextForModel } from "./context-builder.js";
import { planNextAction } from "../model/mock-planner.js";
import {
  appendAppliedPatch,
  appendHistory,
  appendRuntimeEvent,
  appendToolResult
} from "../runtime/session.js";

function resolveTokenLimit() {
  const rawLimit = Number(process.env.UPSTAGE_MODEL_CONTEXT_LIMIT);
  if (Number.isFinite(rawLimit) && rawLimit > 0) {
    return Math.floor(rawLimit);
  }
  return 65_536;
}

const SOLAR_PRO2_TOKEN_LIMIT = resolveTokenLimit();
const SOLAR_PRO2_WARNING_THRESHOLD = Math.floor(SOLAR_PRO2_TOKEN_LIMIT * 0.8);
const DEFAULT_MAX_CONVERSATION_MESSAGES = 40;
const CONTEXT_EXCEEDED_RETRY_MESSAGES = 12;

function safeJsonParse(value) {
  try {
    return JSON.parse(value);
  } catch {
    return {};
  }
}

function toToolMessage(result) {
  return JSON.stringify(result.ok ? result.data : { error: result.error });
}

function emit(onEvent, event) {
  if (typeof onEvent === "function") {
    onEvent(event);
  }
}

function emitRuntime(registry, session, type, payload) {
  const eventBus = registry?.eventBus;
  if (eventBus && typeof eventBus.emit === "function") {
    eventBus.emit(type, payload);
  }
}

function toFiniteNumber(value) {
  const numericValue = Number(value);
  if (!Number.isFinite(numericValue) || numericValue <= 0) {
    return 0;
  }
  return numericValue;
}

function normalizeTokenUsage(rawUsage) {
  if (!rawUsage || typeof rawUsage !== "object") {
    return null;
  }

  const promptTokens = toFiniteNumber(
    rawUsage.promptTokens ?? rawUsage.prompt_tokens ?? rawUsage.inputTokens ?? rawUsage.input_tokens
  );
  const completionTokens = toFiniteNumber(
    rawUsage.completionTokens ?? rawUsage.completion_tokens ?? rawUsage.outputTokens ?? rawUsage.output_tokens
  );
  const reportedTotalTokens = toFiniteNumber(rawUsage.totalTokens ?? rawUsage.total_tokens);
  const totalTokens = reportedTotalTokens > 0 ? reportedTotalTokens : promptTokens + completionTokens;
  const cost = toFiniteNumber(rawUsage.cost);

  if (totalTokens <= 0 && promptTokens <= 0 && completionTokens <= 0 && cost <= 0) {
    return null;
  }

  return {
    promptTokens,
    completionTokens,
    totalTokens,
    cost
  };
}

function readSessionTokenBaseline(session) {
  if (!session || !Array.isArray(session.runtimeEvents)) {
    return {
      totalTokens: 0,
      warningEmitted: false
    };
  }

  let totalTokens = 0;
  let warningEmitted = false;
  for (const event of session.runtimeEvents) {
    if (event?.type === "TOKEN_USAGE") {
      const usage = normalizeTokenUsage(event.usage);
      if (usage) {
        totalTokens += usage.totalTokens;
      }
    }
    if (event?.type === "SYSTEM_WARNING" && event?.code === "TOKEN_CONTEXT_HIGH") {
      warningEmitted = true;
    }
  }

  if (totalTokens > SOLAR_PRO2_WARNING_THRESHOLD) {
    warningEmitted = true;
  }

  return {
    totalTokens,
    warningEmitted
  };
}

function createTokenBudgeter(session) {
  const baseline = readSessionTokenBaseline(session);
  let sessionTotalTokens = baseline.totalTokens;
  let warningEmitted = baseline.warningEmitted;

  return {
    consume(usageInput) {
      const normalizedUsage = normalizeTokenUsage(usageInput);
      if (!normalizedUsage) {
        return null;
      }

      sessionTotalTokens += normalizedUsage.totalTokens;

      const usage = {
        ...normalizedUsage,
        sessionTotalTokens,
        limit: SOLAR_PRO2_TOKEN_LIMIT
      };

      if (warningEmitted || sessionTotalTokens <= SOLAR_PRO2_WARNING_THRESHOLD) {
        return {
          usage,
          warning: null
        };
      }

      warningEmitted = true;
      return {
        usage,
        warning: {
          level: "warning",
          code: "TOKEN_CONTEXT_HIGH",
          message: `Session context usage is above 80% of Solar Pro2 limit (${sessionTotalTokens}/${SOLAR_PRO2_TOKEN_LIMIT} tokens).`,
          usage: {
            totalTokens: sessionTotalTokens,
            threshold: SOLAR_PRO2_WARNING_THRESHOLD,
            limit: SOLAR_PRO2_TOKEN_LIMIT
          }
        }
      };
    }
  };
}

function appendToolMessageToConversation(conversation, session, toolCall, toolName, result) {
  const toolMessage = {
    role: "tool",
    tool_call_id: toolCall?.id,
    name: toolName,
    content: toToolMessage(result)
  };
  conversation.push(toolMessage);
  appendHistory(session, toolMessage);
}

function createConversationFromSession(session) {
  if (!Array.isArray(session?.history)) {
    return [];
  }
  return session.history
    .filter((item) => ["user", "assistant", "tool"].includes(item.role))
    .map((item) => {
      if (item.role === "tool") {
        return {
          role: "tool",
          tool_call_id: item.tool_call_id,
          name: item.name,
          content: item.content
        };
      }
      return { role: item.role, content: item.content, tool_calls: item.tool_calls };
    });
}

function buildModelMessages({ systemPrompt, contextBlock, conversation, maxConversationMessages }) {
  const rawConversation = Array.isArray(conversation)
    ? conversation.slice(-Math.max(1, maxConversationMessages || DEFAULT_MAX_CONVERSATION_MESSAGES))
    : [];
  const trimmedConversation = [];
  for (let i = 0; i < rawConversation.length; i += 1) {
    const message = rawConversation[i];
    if (!message || typeof message !== "object") {
      continue;
    }

    if (message.role === "tool") {
      continue;
    }

    if (message.role === "assistant" && Array.isArray(message.tool_calls) && message.tool_calls.length > 0) {
      const expected = new Set(message.tool_calls.map((toolCall) => toolCall?.id).filter(Boolean));
      if (expected.size === 0) {
        continue;
      }

      const toolMessages = [];
      let cursor = i + 1;
      while (cursor < rawConversation.length) {
        const next = rawConversation[cursor];
        if (!next || next.role !== "tool") {
          break;
        }
        if (expected.has(next.tool_call_id)) {
          toolMessages.push(next);
          expected.delete(next.tool_call_id);
        }
        cursor += 1;
      }

      if (expected.size === 0) {
        trimmedConversation.push(message, ...toolMessages);
        i = cursor - 1;
      }
      continue;
    }

    trimmedConversation.push(message);
  }
  return [
    { role: "system", content: systemPrompt },
    { role: "system", content: contextBlock },
    ...trimmedConversation
  ];
}

function isContextLengthExceededMessage(message) {
  if (typeof message !== "string") {
    return false;
  }
  return (
    message.includes("context_length_exceeded") ||
    message.includes("maximum context length") ||
    message.includes("too many tokens")
  );
}

function createCompactContextBlock(context) {
  const lines = ["Repository context (compacted):"];
  lines.push(`- totalFiles: ${context?.repoSummary?.totalFiles || 0}`);
  lines.push(`- keywordHints: ${(context?.keywords || []).join(", ") || "none"}`);
  const snippets = Array.isArray(context?.snippets) ? context.snippets.slice(0, 2) : [];
  if (snippets.length > 0) {
    lines.push("- key snippets:");
    for (const snippet of snippets) {
      lines.push(`  - ${snippet.path}`);
      lines.push("```text");
      lines.push(String(snippet.content || "").slice(0, 500));
      lines.push("```");
    }
  }
  return lines.join("\n");
}

async function fireBeforeAgentHook(registry, input, cwd, sessionId) {
  if (!registry?.hookSystem) {
    return;
  }
  emitRuntime(registry, { id: sessionId }, "HOOK_LIFECYCLE", {
    hook: "BeforeAgent",
    stage: "start"
  });
  await registry.hookSystem.fire("BeforeAgent", { input, cwd, sessionId });
  emitRuntime(registry, { id: sessionId }, "HOOK_LIFECYCLE", {
    hook: "BeforeAgent",
    stage: "end"
  });
}

async function fireBeforeToolSelectionHook(registry, session, { step, input, cwd, trace }) {
  if (!registry?.hookSystem) {
    return;
  }
  emitRuntime(registry, session, "HOOK_LIFECYCLE", {
    hook: "BeforeToolSelection",
    stage: "start",
    step
  });
  await registry.hookSystem.fire("BeforeToolSelection", {
    step,
    input,
    cwd,
    trace
  });
  emitRuntime(registry, session, "HOOK_LIFECYCLE", {
    hook: "BeforeToolSelection",
    stage: "end",
    step
  });
}

async function requestModelCompletion({ adapter, messages, registry, stream, onToken, trace, session }) {
  try {
    const completion = await adapter.complete({
      messages,
      tools: registry.toModelTools(),
      stream,
      onToken
    });
    return {
      ok: true,
      completion
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : "Model adapter failed";
    return {
      ok: false,
      errorMessage,
      isContextLengthExceeded: isContextLengthExceededMessage(errorMessage),
      terminal: {
        ok: false,
        state: AgentState.FAIL,
        stopReason: StopReason.MODEL_ERROR,
        response: errorMessage,
        trace,
        session
      }
    };
  }
}

function emitTokenUsageUpdate({ tokenBudgeter, completion, adapter, registry, session, onEvent }) {
  const tokenBudgetUpdate = tokenBudgeter.consume(completion?.usage);
  if (tokenBudgetUpdate?.usage) {
    const usagePayload = {
      usage: tokenBudgetUpdate.usage,
      model: adapter?.model || null,
      source: "model"
    };
    emitRuntime(registry, session, "TOKEN_USAGE", usagePayload);
    emit(onEvent, { type: "TOKEN_USAGE", ...usagePayload });
  }

  if (tokenBudgetUpdate?.warning) {
    emitRuntime(registry, session, "SYSTEM_WARNING", tokenBudgetUpdate.warning);
    emit(onEvent, { type: "SYSTEM_WARNING", ...tokenBudgetUpdate.warning });
  }
}

async function executeToolCallsPhase({
  toolCallList,
  toolCalls,
  trace,
  registry,
  cwd,
  runtimeCache,
  session,
  adapter,
  confirm,
  onEvent,
  conversation
}) {
  let nextState = AgentState.ACTING;
  let nextToolCalls = toolCalls;

  for (const toolCall of toolCallList) {
    const toolName = toolCall.function?.name;
    const args = safeJsonParse(toolCall.function?.arguments || "{}");
    trace.push({ state: nextState, tool: toolName, args });
    emit(onEvent, {
      type: "THINKING",
      thought: {
        subject: `Executing tool: ${toolName || "unknown"}`,
        description: "Running tool and collecting observation"
      }
    });
    emit(onEvent, { type: "TOOL", tool: toolName, args });

    const result = await registry.execute(toolName, args, {
      cwd,
      runtimeCache,
      session,
      adapter,
      confirm,
      onLog: (payload) => emit(onEvent, { type: "TOOL_LOG", tool: toolName, ...payload })
    });

    nextToolCalls += 1;
    nextState = AgentState.OBSERVING;
    trace.push({ state: nextState, tool: toolName, result });
    appendToolResult(session, { tool: toolName, args, result });
    emit(onEvent, { type: "OBSERVATION", tool: toolName, ok: result.ok, result: result.ok ? result.data : result.error });
    emitRuntime(registry, session, "AGENT_OBSERVATION", {
      tool: toolName,
      ok: result.ok,
      result: result.ok ? result.data : result.error
    });

    if (!result.ok) {
      appendToolMessageToConversation(conversation, session, toolCall, toolName, result);
      const stopReason =
        result.error?.code === "POLICY_BLOCKED" || result.error?.code === "POLICY_VIOLATION"
          ? StopReason.POLICY_BLOCKED
          : StopReason.TOOL_ERROR;
      return {
        terminal: {
          ok: false,
          state: AgentState.FAIL,
          stopReason,
          response: `Tool failed: ${result.error?.message || "unknown"}`,
          trace,
          session
        },
        state: nextState,
        toolCalls: nextToolCalls
      };
    }

    if (toolName === "create_patch" && result.data?.patch) {
      emit(onEvent, { type: "PATCH_PREVIEW", patch: result.data.patch });
    }

    if (toolName === "apply_patch") {
      nextState = AgentState.VERIFYING;
      const verify = await runVerification(registry, cwd, onEvent, session, runtimeCache);
      if (!verify.ok || !verify.data?.ok) {
        if (result.data?.rollbackPatch) {
          await registry.execute("apply_patch", { patch: result.data.rollbackPatch }, { cwd, runtimeCache, session });
        }
        appendToolMessageToConversation(conversation, session, toolCall, toolName, result);
        return {
          terminal: {
            ok: false,
            state: AgentState.FAIL,
            stopReason: StopReason.TOOL_ERROR,
            response: "Verification failed after patch apply. Rollback completed.",
            trace,
            session,
            verification: verify
          },
          state: nextState,
          toolCalls: nextToolCalls
        };
      }
      appendAppliedPatch(session, { path: result.data.path, verified: true });
    }

    appendToolMessageToConversation(conversation, session, toolCall, toolName, result);
  }

  return {
    terminal: null,
    state: nextState,
    toolCalls: nextToolCalls
  };
}

async function runVerification(registry, cwd, onEvent, session, runtimeCache) {
  emitRuntime(registry, session, "VERIFY_RESULT", { stage: "start" });
  emit(onEvent, { type: "VERIFY_RESULT", stage: "start" });
  emit(onEvent, {
    type: "THINKING",
    thought: {
      subject: "Running verification",
      description: "Executing linter, typecheck, and tests"
    }
  });
  const verification = await registry.execute(
    "run_verification",
    {
      stopOnFailure: true,
      stages: Array.isArray(runtimeCache?.verifyStages) ? runtimeCache.verifyStages : undefined
    },
    {
      cwd,
      session,
      onLog: (payload) => emit(onEvent, { type: "VERIFY_LOG", ...payload })
    }
  );
  emitRuntime(registry, session, "VERIFY_RESULT", {
    stage: "end",
    ok: verification.ok,
    result: verification.ok ? verification.data : verification.error
  });
  emit(onEvent, { type: "VERIFY_RESULT", stage: "end", result: verification });
  return verification;
}

async function runFallback({ input, registry, cwd, adapter, trace, session, onEvent, confirm, runtimeCache }) {
  const action = planNextAction(input, { registry, cwd, trace });
  emit(onEvent, { type: "PLAN", mode: "fallback", action });

  if (action.type === "respond") {
    appendHistory(session, { role: "assistant", content: action.response });
    return {
      ok: true,
      state: AgentState.DONE,
      stopReason: StopReason.DONE,
      response: action.response,
      trace,
      session
    };
  }

  if (action.type === "stop") {
    return {
      ok: true,
      state: AgentState.DONE,
      stopReason: action.stopReason || StopReason.NEEDS_USER_INPUT,
      response: action.response || "Stopped.",
      trace,
      session
    };
  }

  if (action.type === "tool_call") {
    emit(onEvent, { type: "TOOL", tool: action.toolName, args: action.args });
    const result = await registry.execute(action.toolName, action.args, {
      cwd,
      runtimeCache,
      session,
      adapter,
      confirm,
      onLog: (payload) => emit(onEvent, { type: "TOOL_LOG", tool: action.toolName, ...payload })
    });
    appendToolResult(session, { tool: action.toolName, args: action.args, result });

    if (!result.ok) {
      const stopReason =
        result.error?.code === "POLICY_BLOCKED" || result.error?.code === "POLICY_VIOLATION"
          ? StopReason.POLICY_BLOCKED
          : StopReason.TOOL_ERROR;
      return {
        ok: false,
        state: AgentState.FAIL,
        stopReason,
        response: `Tool failed: ${result.error?.message || "unknown"}`,
        trace,
        session
      };
    }

    if (action.toolName === "create_patch") {
      emit(onEvent, { type: "PATCH_PREVIEW", patch: result.data.patch });
    }

    if (action.toolName === "apply_patch") {
      const verify = await runVerification(registry, cwd, onEvent, session, runtimeCache);
      if (!verify.ok || !verify.data?.ok) {
        if (result.data?.rollbackPatch) {
          await registry.execute("apply_patch", { patch: result.data.rollbackPatch }, { cwd, runtimeCache, session });
        }
        return {
          ok: false,
          state: AgentState.FAIL,
          stopReason: StopReason.TOOL_ERROR,
          response: `Verification failed after patch apply. Rollback completed.`,
          trace,
          session,
          verification: verify
        };
      }
    }

    return {
      ok: true,
      state: AgentState.DONE,
      stopReason: StopReason.DONE,
      response: JSON.stringify(result.data, null, 2),
      trace,
      session
    };
  }

  return {
    ok: false,
    state: AgentState.FAIL,
    stopReason: StopReason.MODEL_ERROR,
    response: "Unknown fallback action.",
    trace,
    session
  };
}

export async function runAgentLoop({
  input,
  registry,
  cwd,
  adapter,
  stream = true,
  onToken,
  onEvent,
  confirm,
  session,
  runtimeCache,
  budget = DEFAULT_LOOP_BUDGET
}) {
  if (!session) {
    session = {
      id: "ephemeral",
      createdAt: Date.now(),
      updatedAt: Date.now(),
      workspace: { cwd },
      history: [],
      toolResults: [],
      appliedPatches: []
    };
  }

  const tokenBudgeter = createTokenBudgeter(session);

  const startedAt = Date.now();
  let state = AgentState.IDLE;
  let steps = 0;
  let toolCalls = 0;
  let offRuntimeEvent = null;
  const trace = [];
  if (registry?.eventBus && typeof registry.eventBus.on === "function") {
    offRuntimeEvent = registry.eventBus.on((event) => {
      appendRuntimeEvent(session, event);
    });
  }
  emitRuntime(registry, session, "AGENT_LIFECYCLE", {
    stage: "start",
    cwd,
    hasAdapter: !!adapter,
    stream
  });
  await fireBeforeAgentHook(registry, input, cwd, session.id);
  const conversation = createConversationFromSession(session);

  const systemPrompt =
    "You are upstage-cli coding agent. Use tools for repository inspection and safe patch workflows. Always verify after apply_patch.";

  appendHistory(session, { role: "user", content: input });
  conversation.push({ role: "user", content: input });

  try {
    while (steps < budget.maxSteps) {
    if (Date.now() - startedAt > budget.maxWallTimeMs) {
      return {
        ok: false,
        state: AgentState.FAIL,
        stopReason: StopReason.BUDGET_EXHAUSTED,
        response: "Stopped: wall-time budget exhausted.",
        trace,
        session
      };
    }

      state = AgentState.PLANNING;
      trace.push({ state, step: steps + 1 });
      emit(onEvent, {
        type: "THINKING",
        thought: {
          subject: `Planning step ${steps + 1}`,
          description: "Collecting context and deciding next action"
        }
      });
      emitRuntime(registry, session, "AGENT_PLAN", {
        stage: "step_start",
        step: steps + 1,
        toolCalls
      });
      await fireBeforeToolSelectionHook(registry, session, {
        step: steps + 1,
        input,
        cwd,
        trace
      });

      if (!adapter || !adapter.isConfigured()) {
        const fallback = await runFallback({
        input,
        registry,
        cwd,
        adapter,
        trace,
        session,
        onEvent,
        confirm,
        runtimeCache
      });
        if (fallback.ok && fallback.response && fallback.response.startsWith("{")) {
          fallback.response =
            "UPSTAGE_API_KEY is not configured. Running fallback planner.\n" + fallback.response;
        }
        return fallback;
      }

      const context = await buildContext({ input, registry, cwd, runtimeCache });
      const contextBlock = formatContextForModel(context);
      emit(onEvent, { type: "PLAN", mode: "model", contextSummary: context.repoSummary, keywords: context.keywords });
      emitRuntime(registry, session, "AGENT_PLAN", {
        stage: "context_ready",
        contextSummary: context.repoSummary,
        keywords: context.keywords
      });

      const messages = buildModelMessages({
        systemPrompt,
        contextBlock,
        conversation,
        maxConversationMessages: runtimeCache?.maxConversationMessages || DEFAULT_MAX_CONVERSATION_MESSAGES
      });

      emit(onEvent, {
        type: "THINKING",
        thought: {
          subject: "Calling model",
          description: "Waiting for response and possible tool requests"
        }
      });

      const completionResult = await requestModelCompletion({
        adapter,
        messages,
        registry,
        stream,
        onToken,
        trace,
        session
      });
      if (!completionResult.ok) {
        if (completionResult.isContextLengthExceeded) {
          const compactedMessages = buildModelMessages({
            systemPrompt,
            contextBlock: createCompactContextBlock(context),
            conversation,
            maxConversationMessages:
              runtimeCache?.contextExceededRetryMessages || CONTEXT_EXCEEDED_RETRY_MESSAGES
          });
          emitRuntime(registry, session, "SYSTEM_WARNING", {
            level: "warning",
            code: "CONTEXT_COMPACT_RETRY",
            message: "Model context limit exceeded. Retrying with compacted context."
          });
          emit(onEvent, {
            type: "SYSTEM_WARNING",
            level: "warning",
            code: "CONTEXT_COMPACT_RETRY",
            message: "Model context limit exceeded. Retrying with compacted context."
          });

          const retryCompletion = await requestModelCompletion({
            adapter,
            messages: compactedMessages,
            registry,
            stream,
            onToken,
            trace,
            session
          });
          if (!retryCompletion.ok) {
            return retryCompletion.terminal;
          }
          const completion = retryCompletion.completion;
          emitTokenUsageUpdate({ tokenBudgeter, completion, adapter, registry, session, onEvent });

          const toolCallList = Array.isArray(completion.toolCalls) ? completion.toolCalls : [];
          if (toolCallList.length === 0) {
            appendHistory(session, { role: "assistant", content: completion.content || "No content returned." });
            return {
              ok: true,
              state: AgentState.DONE,
              stopReason: StopReason.DONE,
              response: completion.content || "No content returned.",
              trace,
              session
            };
          }

          if (toolCalls + toolCallList.length > budget.maxToolCalls) {
            return {
              ok: false,
              state: AgentState.FAIL,
              stopReason: StopReason.BUDGET_EXHAUSTED,
              response: "Stopped: tool-call budget exhausted.",
              trace,
              session
            };
          }

          conversation.push({
            role: "assistant",
            content: completion.content || "",
            tool_calls: toolCallList
          });
          appendHistory(session, { role: "assistant", content: completion.content || "", tool_calls: toolCallList });

          const toolPhase = await executeToolCallsPhase({
            toolCallList,
            toolCalls,
            trace,
            registry,
            cwd,
            runtimeCache,
            session,
            adapter,
            confirm,
            onEvent,
            conversation
          });
          toolCalls = toolPhase.toolCalls;
          state = toolPhase.state;
          if (toolPhase.terminal) {
            return toolPhase.terminal;
          }

          steps += 1;
          continue;
        }
        return completionResult.terminal;
      }
      const completion = completionResult.completion;

      emitTokenUsageUpdate({ tokenBudgeter, completion, adapter, registry, session, onEvent });

      const toolCallList = Array.isArray(completion.toolCalls) ? completion.toolCalls : [];
      if (toolCallList.length === 0) {
      appendHistory(session, { role: "assistant", content: completion.content || "No content returned." });
        return {
        ok: true,
        state: AgentState.DONE,
        stopReason: StopReason.DONE,
        response: completion.content || "No content returned.",
        trace,
        session
        };
      }

      if (toolCalls + toolCallList.length > budget.maxToolCalls) {
        return {
        ok: false,
        state: AgentState.FAIL,
        stopReason: StopReason.BUDGET_EXHAUSTED,
        response: "Stopped: tool-call budget exhausted.",
        trace,
        session
        };
      }

      conversation.push({
      role: "assistant",
      content: completion.content || "",
      tool_calls: toolCallList
    });
      appendHistory(session, { role: "assistant", content: completion.content || "", tool_calls: toolCallList });

      const toolPhase = await executeToolCallsPhase({
        toolCallList,
        toolCalls,
        trace,
        registry,
        cwd,
        runtimeCache,
        session,
        adapter,
        confirm,
        onEvent,
        conversation
      });
      toolCalls = toolPhase.toolCalls;
      state = toolPhase.state;
      if (toolPhase.terminal) {
        return toolPhase.terminal;
      }

      steps += 1;
    }

    return {
    ok: false,
    state: AgentState.FAIL,
    stopReason: StopReason.BUDGET_EXHAUSTED,
    response: "Stopped: step budget exhausted.",
    trace,
    session
    };
  } finally {
    emitRuntime(registry, session, "AGENT_LIFECYCLE", {
      stage: "end",
      state,
      steps,
      toolCalls
    });
    if (registry?.hookSystem) {
      emitRuntime(registry, session, "HOOK_LIFECYCLE", {
        hook: "AfterAgent",
        stage: "start"
      });
      await registry.hookSystem.fire("AfterAgent", {
        input,
        cwd,
        sessionId: session.id,
        state,
        steps,
        toolCalls
      });
      emitRuntime(registry, session, "HOOK_LIFECYCLE", {
        hook: "AfterAgent",
        stage: "end"
      });
    }
    if (typeof offRuntimeEvent === "function") {
      offRuntimeEvent();
    }
  }
}
