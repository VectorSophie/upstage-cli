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

const SOLAR_PRO2_TOKEN_LIMIT = 1_000_000;
const SOLAR_PRO2_WARNING_THRESHOLD = Math.floor(SOLAR_PRO2_TOKEN_LIMIT * 0.8);

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

async function runVerification(registry, cwd, onEvent, session) {
  emitRuntime(registry, session, "VERIFY_RESULT", { stage: "start" });
  emit(onEvent, { type: "VERIFY_RESULT", stage: "start" });
  const verification = await registry.execute(
    "run_verification",
    { stopOnFailure: true },
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
      const verify = await runVerification(registry, cwd, onEvent);
      if (!verify.ok || !verify.data?.ok) {
        if (result.data?.rollbackPatch) {
          await registry.execute("apply_patch", { patch: result.data.rollbackPatch }, { cwd, session });
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
  if (registry?.hookSystem) {
    emitRuntime(registry, session, "HOOK_LIFECYCLE", {
      hook: "BeforeAgent",
      stage: "start"
    });
    await registry.hookSystem.fire("BeforeAgent", { input, cwd, sessionId: session.id });
    emitRuntime(registry, session, "HOOK_LIFECYCLE", {
      hook: "BeforeAgent",
      stage: "end"
    });
  }
  const conversation = Array.isArray(session?.history)
    ? session.history
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
        })
    : [];

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
      emitRuntime(registry, session, "AGENT_PLAN", {
        stage: "step_start",
        step: steps + 1,
        toolCalls
      });
      if (registry?.hookSystem) {
        emitRuntime(registry, session, "HOOK_LIFECYCLE", {
          hook: "BeforeToolSelection",
          stage: "start",
          step: steps + 1
        });
        await registry.hookSystem.fire("BeforeToolSelection", {
          step: steps + 1,
          input,
          cwd,
          trace
        });
        emitRuntime(registry, session, "HOOK_LIFECYCLE", {
          hook: "BeforeToolSelection",
          stage: "end",
          step: steps + 1
        });
      }

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

      const messages = [
      { role: "system", content: systemPrompt },
      { role: "system", content: contextBlock },
      ...conversation
    ];

      let completion;
      try {
        completion = await adapter.complete({
        messages,
        tools: registry.toModelTools(),
        stream,
        onToken
        });
      } catch (error) {
        return {
        ok: false,
        state: AgentState.FAIL,
        stopReason: StopReason.MODEL_ERROR,
        response: error instanceof Error ? error.message : "Model adapter failed",
        trace,
        session
        };
      }

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

      state = AgentState.ACTING;
      for (const toolCall of toolCallList) {
      const toolName = toolCall.function?.name;
      const args = safeJsonParse(toolCall.function?.arguments || "{}");
      trace.push({ state, tool: toolName, args });
      emit(onEvent, { type: "TOOL", tool: toolName, args });

        const result = await registry.execute(toolName, args, {
        cwd,
        runtimeCache,
        session,
        adapter,
        confirm,
        onLog: (payload) => emit(onEvent, { type: "TOOL_LOG", tool: toolName, ...payload })
      });

        toolCalls += 1;
        state = AgentState.OBSERVING;
      trace.push({ state, tool: toolName, result });
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
          ok: false,
          state: AgentState.FAIL,
          stopReason,
          response: `Tool failed: ${result.error?.message || "unknown"}`,
          trace,
          session
        };
      }

      if (toolName === "create_patch" && result.data?.patch) {
        emit(onEvent, { type: "PATCH_PREVIEW", patch: result.data.patch });
      }

        if (toolName === "apply_patch") {
        state = AgentState.VERIFYING;
          const verify = await runVerification(registry, cwd, onEvent, session);
        if (!verify.ok || !verify.data?.ok) {
          if (result.data?.rollbackPatch) {
            await registry.execute("apply_patch", { patch: result.data.rollbackPatch }, { cwd, runtimeCache, session });
          }
          appendToolMessageToConversation(conversation, session, toolCall, toolName, result);
          return {
            ok: false,
            state: AgentState.FAIL,
            stopReason: StopReason.TOOL_ERROR,
            response: "Verification failed after patch apply. Rollback completed.",
            trace,
            session,
            verification: verify
          };
        }
          appendAppliedPatch(session, { path: result.data.path, verified: true });
      }
      appendToolMessageToConversation(conversation, session, toolCall, toolName, result);
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
