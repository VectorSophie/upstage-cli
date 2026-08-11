import { runAgentLoop } from "../agent/loop.mjs";
import { saveSession } from "../runtime/session.mjs";
import { AgentEventType } from "../protocol/events.mjs";
import { StreamBatcher } from "./stream-batcher.mjs";
import { t } from "../i18n/index.mjs";

/**
 * Drives one turn of the agent loop and translates its AgentEvent stream
 * into TUI state updates. Extracted out of App.mjs so the event-to-state
 * mapping is testable without mounting a renderer, and so every event type
 * is provably handled (an exhaustive switch with one generic fallback,
 * rather than the silent drop the previous TUI had for 12 of 20 types).
 *
 * `set` is the small slice of React state setters this needs; `refs` carries
 * mutable per-turn accumulators that don't need to trigger renders on their
 * own (assistant text buffer, last diff).
 */
export function createTurnRunner({ set, getState }) {
  return async function runTurn(query, { registry, adapter, session, runtimeCache, settings, args }) {
    set.setIsProcessing(true);
    set.setStatusKey("thinking");
    set.setMessages((prev) => [...prev, { role: "user", content: query }]);
    set.setSteps([]);
    set.setCurrentThought(null);

    let assistantResponse = "";
    let lastDiff = null;
    let lastFiletype = null;
    let lastFilePath = null; // §3.5 — lets the chat pane offer inline per-step undo, not just /rewind

    const flushAssistant = (nextText) => {
      assistantResponse = nextText;
      set.setMessages((prev) => {
        const last = prev[prev.length - 1];
        const entry = { role: "assistant", content: assistantResponse, diff: lastDiff, filetype: lastFiletype, filePath: lastFilePath };
        if (last && last.role === "assistant") {
          return [...prev.slice(0, -1), entry];
        }
        return [...prev, entry];
      });
    };

    const batcher = new StreamBatcher((chunk) => flushAssistant(assistantResponse + chunk), { intervalMs: 24 });

    const pushStep = (step) => set.setSteps((prev) => [...prev, step]);

    const handleEvent = (event) => {
      switch (event.type) {
        case AgentEventType.STREAM_START: {
          set.setStatusKey("thinking");
          break;
        }
        case AgentEventType.STREAM_TOKEN: {
          batcher.push(event.text || "");
          break;
        }
        case AgentEventType.STREAM_END: {
          batcher.flush();
          break;
        }
        case AgentEventType.PLAN: {
          pushStep({ type: "plan", label: t("steps.plan", { mode: event.mode }), done: true });
          break;
        }
        case AgentEventType.TOOL_START: {
          pushStep({ type: "tool", tool: event.tool, label: t("steps.tool", { tool: event.tool }), done: false });
          break;
        }
        case AgentEventType.TOOL_RESULT: {
          set.setSteps((prev) => {
            const idx = [...prev].reverse().findIndex((s) => s.type === "tool" && s.tool === event.tool && !s.done);
            if (idx === -1) return prev;
            const realIdx = prev.length - 1 - idx;
            const next = [...prev];
            next[realIdx] = { ...next[realIdx], done: true };
            return next;
          });
          break;
        }
        case AgentEventType.THINKING: {
          set.setCurrentThought(event.thought?.subject || t("steps.analyzing"));
          break;
        }
        case AgentEventType.PATCH_PREVIEW: {
          lastDiff = event.patch?.unifiedDiff || null;
          lastFiletype = event.patch?.filetype || event.patch?.path?.split(".").pop() || null;
          lastFilePath = event.patch?.path || null;
          batcher.flush();
          flushAssistant(assistantResponse);
          break;
        }
        case AgentEventType.VERIFY_START: {
          set.setStatusKey("verifying");
          pushStep({ type: "verify", label: t("steps.verifying"), done: false });
          break;
        }
        case AgentEventType.VERIFY_END: {
          set.setSteps((prev) => {
            const idx = [...prev].reverse().findIndex((s) => s.type === "verify" && !s.done);
            if (idx === -1) return prev;
            const realIdx = prev.length - 1 - idx;
            const next = [...prev];
            next[realIdx] = { ...next[realIdx], done: true };
            return next;
          });
          break;
        }
        case AgentEventType.CRITIC: {
          const stage = event.stage || "start";
          const label = stage === "pass"
            ? t("steps.criticPass")
            : stage === "fail"
              ? t("steps.criticFail", { cycle: event.cycles })
              : t("steps.criticStart");
          pushStep({ type: "critic", label, done: stage !== "start" });
          break;
        }
        case AgentEventType.REPLAN: {
          pushStep({ type: "replan", label: t("steps.replan", { trigger: event.trigger, count: event.count }), done: true });
          break;
        }
        case AgentEventType.COMPACTION: {
          pushStep({ type: "compaction", label: t("steps.compaction", { count: event.removedCount ?? event.count ?? 0 }), done: true });
          break;
        }
        case AgentEventType.TOKEN_USAGE: {
          set.setTokenUsage((prev) => ({
            total: prev.total + (event.usage?.totalTokens || 0),
            cost: prev.cost + (event.usage?.cost || 0)
          }));
          break;
        }
        case AgentEventType.SYSTEM_WARNING: {
          set.setSystemWarning(event.message || t("warning.tokenContextHigh"));
          set.setStatusKey("warning");
          break;
        }
        case AgentEventType.LIFECYCLE:
        case AgentEventType.TOOL_LOG:
        case AgentEventType.HOOK_PERMISSION_RESULT:
        case AgentEventType.ERROR:
        case AgentEventType.STOP:
        default: {
          // Exhaustive-by-design fallback: any event type not given bespoke
          // handling above (including future ones) still surfaces instead of
          // silently vanishing, which is what the previous TUI did for 12 of
          // the 20 defined AgentEventType values.
          if (event.type && event.type !== AgentEventType.LIFECYCLE) {
            pushStep({ type: "generic", label: `${event.type}${event.message ? `: ${event.message}` : ""}`, done: true });
          }
          break;
        }
      }
    };

    try {
      const gen = runAgentLoop({
        input: query,
        registry,
        cwd: process.cwd(),
        adapter,
        stream: true,
        session,
        runtimeCache,
        settings,
        systemPromptOverride: args?.systemPrompt || null,
        addDirs: args?.addDirs || [],
        // registry.execute() (src/tools/registry.mjs) calls confirm with a
        // single payload object — { tool, args, risk, description,
        // actionClass, ... } — matching what the non-interactive approval
        // handlers in core/policy/approvals.mjs already expect. This used
        // to destructure as (tool, params), which silently received the
        // whole payload object as `tool` and `undefined` as `params` on
        // every real call — ApprovalDialog would compare that object
        // against string tool names (always false) and dereference
        // `params.command`/`params.diff` on undefined. Untested path, no
        // prior repro; caught while wiring the PII guardrail's
        // confirmation details through the same payload.
        confirm: (payload) => new Promise((resolve) => {
          set.setApproval({
            tool: payload.tool,
            params: payload.args,
            risk: payload.risk,
            actionClass: payload.actionClass,
            pii: payload.pii || null,
            onApprove: () => { set.setApproval(null); resolve(true); },
            onDeny: () => { set.setApproval(null); resolve(false); }
          });
        })
      });

      let result;
      while (true) {
        const next = await gen.next();
        if (next.done) {
          result = next.value;
          break;
        }
        handleEvent(next.value);
      }
      batcher.stop();

      if (!assistantResponse && result.response) {
        flushAssistant(result.response);
      }

      const currentSession = getState().currentSession;
      if (result.session) {
        set.setCurrentSession(result.session);
        await saveSession(result.session);
      } else if (currentSession) {
        await saveSession(currentSession);
      }

      set.setStatusKey("idle");
    } catch (err) {
      batcher.stop();
      const message = err instanceof Error ? err.message : String(err);
      set.setMessages((prev) => [...prev, { role: "assistant", content: t("errors.prefix", { message }) }]);
      set.setStatusKey("error");
    } finally {
      set.setIsProcessing(false);
      set.setCurrentThought(null);
    }
  };
}
