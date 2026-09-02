import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useKeyboard, useAppContext, useTerminalDimensions } from "@opentui/react";
import fs from "fs";
import path from "path";
import os from "os";
import { spawnSync } from "child_process";
import { executeCommand } from "./commands.mjs";
import { renderMarkdown } from "./markdown.mjs";
import { ansiLines } from "./ansi-text.mjs";
import { createTurnRunner } from "./event-consumer.mjs";
import { Composer } from "./components/Composer.mjs";
import { Thinking } from "./components/Thinking.mjs";
import { DiffPreview } from "./components/DiffPreview.mjs";
import { SessionBrowser } from "./components/SessionBrowser.mjs";
import { RepoMap } from "./components/RepoMap.mjs";
import { ApprovalDialog } from "./components/ApprovalDialog.mjs";
import { Sidebar } from "./components/Sidebar.mjs";
import { StatusBar } from "./components/StatusBar.mjs";
import { AutocompleteStrip } from "./components/AutocompleteStrip.mjs";
import { BigLogo, SmallWordmark } from "./components/Logo.mjs";
import { THEME } from "./colors.mjs";
import { shouldRoutePrintableToComposer } from "./input-routing.mjs";
import { getAutocomplete, applyCompletion } from "./composer-autocomplete.mjs";
import { nextMode } from "./mode-cycle.mjs";
import { nextReasoningEffort } from "./reasoning-cycle.mjs";
import { InputHistory } from "./input-history.mjs";
import { COMMANDS } from "./commands.mjs";
import { createSession, forkSession, listSessions, loadSession, saveSession } from "../runtime/session.mjs";
import { createWatcher, buildWatchPrompt } from "../core/watch-mode.mjs";
import { checkpointsDir, listCheckpoints, restoreCheckpoint } from "../core/rewind.mjs";
import {
  getLanguage,
  initializeLanguage,
  isSupportedLanguage,
  setLanguage as setI18nLanguage,
  subscribeLanguage,
  t
} from "../i18n/index.mjs";

const App = ({ sessionId: initialSessionId, registry, adapter, args, session: initialSession, runtimeCache, settings }) => {
  const { width, height } = useTerminalDimensions();
  const { renderer } = useAppContext();

  const [sessionId, setSessionId] = useState(initialSessionId);
  const [currentSession, setCurrentSession] = useState(initialSession);
  const [messages, setMessages] = useState([]);
  const [statusKey, setStatusKey] = useState("idle");
  const [isProcessing, setIsProcessing] = useState(false);
  const [currentThought, setCurrentThought] = useState(null);
  const [steps, setSteps] = useState([]);

  const [showSessions, setShowSessions] = useState(false);
  const [sessionList, setSessionList] = useState([]);
  const [showRepoMap, setShowRepoMap] = useState(false);
  const [repoMapData, setRepoMapData] = useState({});

  const [approval, setApproval] = useState(null);
  const [tokenUsage, setTokenUsage] = useState({ total: 0, cost: 0 });
  const [systemWarning, setSystemWarning] = useState("");
  const [approvalMode, setApprovalMode] = useState("default");
  const [reasoningEffort, setReasoningEffortState] = useState(() => {
    const initial = settings?.reasoningEffort;
    return initial && initial !== "auto" ? initial : "auto";
  });
  // The adapter (or ModelRouter wrapping it) holds the live reasoning_effort
  // used on the next API call — this keeps the UI chip and the actual
  // outbound request in sync without threading a new param through the
  // whole loop.mjs/event-consumer.mjs call chain.
  const cycleReasoningEffort = useCallback(() => {
    setReasoningEffortState((prev) => {
      const next = nextReasoningEffort(prev);
      adapter?.setReasoningEffort?.(next === "auto" ? null : next);
      return next;
    });
  }, [adapter]);
  const [language, setLanguageState] = useState(() => {
    initializeLanguage(initialSession?.preferences?.language);
    return getLanguage();
  });

  const [focusedPane, setFocusedPane] = useState("input");
  const [activeSidebarTab, setActiveSidebarTab] = useState("plan");
  const [composerValue, setComposerValue] = useState("");

  const lastEscPress = useRef(0);
  const scrollBoxRef = useRef(null);
  const historyRef = useRef(new InputHistory((initialSession?.history || [])
    .filter((h) => h.role === "user")
    .map((h) => h.content)));
  const stateRef = useRef({ currentSession });
  stateRef.current.currentSession = currentSession;
  const watcherRef = useRef(null);
  const [isWatching, setIsWatching] = useState(false);

  // Watch mode (§3.3): stop the fs watcher on unmount so it doesn't leak
  // past the session ending.
  useEffect(() => () => watcherRef.current?.close?.(), []);

  useEffect(() => {
    if (initialSession?.history) {
      setMessages(initialSession.history.map((h) => ({ role: h.role, content: h.content, diff: h.diff })));
    }
  }, [initialSession]);

  useEffect(() => subscribeLanguage(setLanguageState), []);

  const persistSessionLanguage = useCallback(async (session, nextLanguage) => {
    if (!session || !isSupportedLanguage(nextLanguage)) return;
    if (!session.preferences || typeof session.preferences !== "object") session.preferences = {};
    session.preferences.language = nextLanguage;
    session.updatedAt = Date.now();
    await saveSession(session);
  }, []);

  useEffect(() => {
    if (!currentSession) return;
    const preferred = currentSession.preferences?.language;
    if (isSupportedLanguage(preferred)) {
      setI18nLanguage(preferred);
      return;
    }
    persistSessionLanguage(currentSession, getLanguage()).catch(() => {});
  }, [currentSession, persistSessionLanguage]);

  useEffect(() => {
    if (showSessions) listSessions().then(setSessionList);
  }, [showSessions]);

  useEffect(() => {
    if (showRepoMap && Object.keys(repoMapData).length === 0) {
      registry.execute("repo_map", { maxFiles: 120 }, { cwd: process.cwd(), runtimeCache })
        .then((res) => res.ok && setRepoMapData(res.data));
    }
  }, [showRepoMap, registry, runtimeCache, repoMapData]);

  const HEADER_HEIGHT = 3;
  const FOOTER_HEIGHT = 5;
  const CHAT_HEIGHT = Math.max(5, height - HEADER_HEIGHT - FOOTER_HEIGHT);
  // Sidebar + its divider are absolutely positioned (not flex siblings) —
  // a `scrollbox` in this OpenTUI version suppresses rendering of any row
  // sibling declared after it (confirmed via isolated pty repro; a
  // row-reverse workaround was tried first but segfaults the native
  // renderer). The chat pane gets an explicit width instead of flexGrow so
  // it doesn't expand under the overlay.
  const SIDEBAR_WIDTH = 36;
  const DIVIDER_WIDTH = 1;
  const CHAT_PANE_WIDTH = Math.max(20, width - SIDEBAR_WIDTH - DIVIDER_WIDTH);
  const CHAT_WIDTH = Math.max(20, CHAT_PANE_WIDTH - 4);

  const runTurn = useMemo(() => createTurnRunner({
    set: {
      setMessages, setSteps, setCurrentThought, setTokenUsage, setSystemWarning,
      setStatusKey, setIsProcessing, setApproval, setCurrentSession
    },
    getState: () => stateRef.current
  }), []);

  const openExternalEditor = useCallback((initialText) => {
    const editor = process.env.EDITOR || "vim";
    const tmpFile = path.join(os.tmpdir(), `upstage-cli-${Date.now()}.md`);
    fs.writeFileSync(tmpFile, initialText || "");
    try {
      spawnSync(editor, [tmpFile], { stdio: "inherit" });
      setComposerValue(fs.readFileSync(tmpFile, "utf8").trim());
    } catch (err) {
      console.error("Failed to open external editor:", err);
    } finally {
      if (fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile);
    }
  }, []);

  // Drag-to-copy: text is selectable by default in OpenTUI (confirmed via
  // TextBufferRenderable's own default options), so the actual drag-select
  // mechanics need no wiring — this just decides what happens once a
  // selection exists. Mirrors opencode's Selection.copy (packages/tui/src/
  // util/selection.ts upstream): read renderer.getSelection(), write via
  // OSC 52, clear it, report success/failure through the existing status
  // line (no toast system here, so statusKey is the closest equivalent).
  // Copy fires only from this handler — never from a useEffect watching
  // selection state — specifically to avoid the "clipboard spams on every
  // re-render during streaming" bug filed against Claude Code's version of
  // this same feature (docs/tui-mouse-clickable-ux.md §3).
  //
  // KNOWN LIMITATION (root-caused via isolated pty repro, see the doc's
  // "Confirmed engine limitation" section): in this pinned OpenTUI version
  // (0.5.1, currently also `latest`), a `scrollbox`'s descendant
  // renderables stop being hit-testable — and therefore unselectable —
  // the instant the tree is rendered through a React function-component
  // boundary, which every real app is. A plain `box` is unaffected; only
  // `scrollbox` (our chat pane) hits this. This function and its Ctrl+C/
  // Escape wiring are still correct and will work the moment that's fixed
  // upstream — and already work today for any selectable content outside
  // the chat scrollbox. Until then, the Option/Shift-drag terminal bypass
  // (surfaced in /help) is the practical way to copy chat text.
  const copySelection = useCallback(() => {
    const selection = renderer?.getSelection?.();
    if (!selection) return false;
    const text = selection.getSelectedText?.();
    if (!text) return false;
    const ok = renderer.copyToClipboardOSC52(text);
    setStatusKey(ok ? "copiedToClipboard" : "copyUnsupported");
    renderer.clearSelection();
    return true;
  }, [renderer]);

  const rewindSession = useCallback(() => {
    if (messages.length >= 2) {
      setMessages((prev) => prev.slice(0, -2));
      if (currentSession?.history) {
        currentSession.history = currentSession.history.slice(0, -2);
        saveSession(currentSession).catch(() => {});
      }
      setStatusKey("sessionRewound");
    }
  }, [messages, currentSession]);

  // §3.5 checkpoints with inline undo (Cline's per-step-undo pattern):
  // reuses /rewind's exact mechanism (core/rewind.mjs), just surfaced
  // right next to the diff that caused it instead of requiring a separate
  // /rewind <id> text command — this file's own most recent checkpoint,
  // not necessarily the session-wide latest one if other files changed
  // since.
  const undoFileCheckpoint = useCallback(async (filePath) => {
    const cwd = currentSession?.workspace?.cwd || process.cwd();
    const base = checkpointsDir(cwd);
    const list = await listCheckpoints(base, 100);
    const match = list.find((c) => c.filePath === filePath || c.relativePath === filePath);
    if (!match) {
      setStatusKey("undoNotFound");
      return;
    }
    const res = await restoreCheckpoint(base, match.id);
    setStatusKey(res.ok ? "undoApplied" : "undoNotFound");
  }, [currentSession]);

  // Skills are manually invocable as /<name> (commands.mjs' unknown-command
  // fallback) but weren't reachable from tab-completion — merge them in so
  // /kt... surfaces /ktx-booking same as any built-in command would. The
  // skills list itself is a fresh array each render (loader.list() has no
  // cache), so a useMemo here would never actually hit; skip it.
  const skillList = runtimeCache?.skillsLoader?.list?.() || [];
  const commandList = [
    ...Object.keys(COMMANDS).map((name) => ({ name })),
    ...skillList.map((s) => ({ name: `/${s.name}` }))
  ];
  const commandDescriptions = {
    ...COMMANDS,
    ...Object.fromEntries(skillList.map((s) => [`/${s.name}`, { description: s.description }]))
  };
  const autocomplete = (focusedPane === "input" && !isProcessing && composerValue.startsWith("/"))
    ? getAutocomplete(composerValue, { commands: commandList })
    : null;

  const handleSessionSelect = async (sessionMeta) => {
    const loaded = await loadSession(sessionMeta.id);
    setSessionId(loaded.id);
    setCurrentSession(loaded);
    setMessages((loaded.history || []).map((h) => ({ role: h.role, content: h.content, diff: h.diff })));
    setTokenUsage({ total: 0, cost: 0 });
    setSystemWarning("");
    setStatusKey("idle");
    setShowSessions(false);
    setFocusedPane("input");
    const preferred = loaded.preferences?.language;
    if (isSupportedLanguage(preferred)) {
      setI18nLanguage(preferred);
      return;
    }
    await persistSessionLanguage(loaded, getLanguage());
  };

  const handleSend = useCallback(async (query) => {
    const trimmed = typeof query === "string" ? query.trim() : "";
    if (!trimmed) return;
    historyRef.current.push(trimmed);

    if (trimmed.startsWith("/")) {
      setMessages((prev) => [...prev, { role: "user", content: trimmed }]);
      const cmdState = {
        messages,
        turnCount: messages.length / 2,
        tokenUsage,
        model: settings?.model || "solar-pro4",
        tools: registry?.list?.() || [],
        _contextManager: runtimeCache?.contextManager || null,
        _checkpointManager: runtimeCache?.checkpointManager || null,
        _permissionMode: approvalMode,
        _session: currentSession,
        _settings: settings,
        _registry: registry,
        _agentLoader: runtimeCache?.agentLoader || null,
        _skillsLoader: runtimeCache?.skillsLoader || null,
        _watching: isWatching
      };
      const result = await executeCommand(trimmed, cmdState);

      if (result.clearMessages) {
        setMessages([]);
        setStatusKey("idle");
        return;
      }
      if (result.exit) { renderer?.destroy(); return; }
      if (result.showSessions) {
        setShowSessions(true);
        setFocusedPane("chat");
        setMessages((prev) => prev.slice(0, -1));
        return;
      }
      if (result.showTree) {
        setShowRepoMap(true);
        setFocusedPane("sidebar");
        setMessages((prev) => prev.slice(0, -1));
        return;
      }
      if (result.startWatch) {
        const cwd = currentSession?.workspace?.cwd || process.cwd();
        watcherRef.current = createWatcher({
          cwd,
          onTrigger: ({ relativePath, markers }) => {
            handleSend(buildWatchPrompt({ relativePath, markers }));
          }
        });
        setIsWatching(true);
        setMessages((prev) => [...prev, { role: "assistant", content: `👁 watch mode: ${cwd}` }]);
        return;
      }
      if (result.stopWatch) {
        watcherRef.current?.close?.();
        watcherRef.current = null;
        setIsWatching(false);
        setMessages((prev) => [...prev, { role: "assistant", content: "watch mode 중지됨" }]);
        return;
      }
      if (result.newSession) {
        const newSess = createSession(process.cwd());
        newSess.preferences = { ...(newSess.preferences || {}), language: getLanguage() };
        await saveSession(newSess);
        setSessionId(newSess.id);
        setCurrentSession(newSess);
        setMessages([]);
        setTokenUsage({ total: 0, cost: 0 });
        setSystemWarning("");
        setStatusKey("newSessionStarted");
        return;
      }
      if (result.branchSession) {
        // §3.2 session forking — unlike /new, this keeps the visible
        // conversation (forkSession() already copied history/toolResults
        // onto the new session); only the session id changes, so further
        // turns write to the branch, not the original.
        const forked = forkSession(currentSession || createSession(process.cwd()));
        await saveSession(forked);
        setSessionId(forked.id);
        setCurrentSession(forked);
        setStatusKey("sessionBranched");
        return;
      }
      if (result.changeLang) {
        const normalized = result.changeLang.toLowerCase();
        if (isSupportedLanguage(normalized)) {
          setI18nLanguage(normalized);
          if (currentSession) await persistSessionLanguage(currentSession, normalized);
          setStatusKey("languageChanged");
        }
      }
      if (result.updatedMessages) setMessages(result.updatedMessages);
      if (result.runPrompt) {
        // §3.4 Recipes: /recipe run renders a stored template into a real
        // prompt — feed it through the same turn path a typed message
        // takes (not just displayed as a response), so the agent actually
        // acts on it.
        setMessages((prev) => [...prev, { role: "user", content: result.runPrompt }]);
        await runTurn(result.runPrompt, { registry, adapter, session: currentSession, runtimeCache, settings, args });
        return;
      }
      if (result.response && !result.response.startsWith("__")) {
        setMessages((prev) => [...prev, { role: "assistant", content: result.response }]);
      }
      return;
    }

    await runTurn(trimmed, { registry, adapter, session: currentSession, runtimeCache, settings, args });
  }, [messages, tokenUsage, settings, registry, runtimeCache, approvalMode, currentSession, persistSessionLanguage, runTurn, adapter, args, renderer]);

  useKeyboard((key) => {
    if (key.name === "tab" && key.shift) {
      setApprovalMode((m) => nextMode(m));
      return;
    }
    if (key.name === "tab" && autocomplete && autocomplete.items.length > 0) {
      const top = autocomplete.items[0];
      const value = autocomplete.mode === "command" ? top.name : top;
      setComposerValue(applyCompletion(composerValue, { mode: autocomplete.mode, value, start: autocomplete.start }));
      return;
    }

    if (key.name === "r" && key.ctrl) {
      process.stdout.write("\x1b[2J\x1b[H");
      return;
    }

    // Ctrl+C is a redundant explicit-copy path alongside mouse-release
    // (mirrors opencode); exitOnCtrlC is already false at the renderer
    // level so this never risks double-handling an exit.
    if (key.name === "c" && key.ctrl) {
      copySelection();
      return;
    }

    if (key.name === "tab") {
      setFocusedPane((prev) => (prev === "input" ? "chat" : prev === "chat" ? "sidebar" : "input"));
      return;
    }

    if (key.name === "s" && key.ctrl) {
      setShowSessions((prev) => !prev);
      setFocusedPane(showSessions ? "input" : "chat");
      return;
    }
    if (key.name === "t" && key.ctrl) {
      setShowRepoMap((prev) => !prev);
      setFocusedPane(showRepoMap ? "input" : "sidebar");
      return;
    }
    if (key.name === "x" && key.ctrl) {
      openExternalEditor(composerValue);
      return;
    }
    if (key.name === "e" && key.ctrl) {
      cycleReasoningEffort();
      return;
    }

    if (key.name === "escape") {
      // An active selection takes priority over everything else Escape
      // does — otherwise dismissing a selection would also close overlays
      // or arm the double-Escape rewind, the same "one key event, unrelated
      // things race for it" bug class this codebase already fixed once for
      // the pane-shortcuts-vs-composer-autofocus ordering (see the
      // pane-specific-shortcuts comment below).
      if (renderer?.getSelection?.()) {
        renderer.clearSelection();
        return;
      }
      const now = Date.now();
      if (now - lastEscPress.current < 500) rewindSession();
      lastEscPress.current = now;
      setFocusedPane("chat");
      setShowSessions(false);
      setShowRepoMap(false);
      return;
    }

    // Pane-specific single-key shortcuts take priority over "type anywhere
    // auto-focuses the composer" below — otherwise j/k/g/G/i/p/c/t would be
    // unreachable the moment focus leaves the input (this exact ordering
    // bug existed in the previous Ink TUI too; fixed here since it makes
    // half the documented keybindings dead).
    if (focusedPane === "input" && !autocomplete) {
      if (key.name === "up") {
        const prev = historyRef.current.prev();
        if (prev !== null) setComposerValue(prev);
        return;
      }
      if (key.name === "down") {
        setComposerValue(historyRef.current.next());
        return;
      }
    }

    if (focusedPane === "chat") {
      if (key.name === "j") { scrollBoxRef.current?.scrollBy?.(1); return; }
      if (key.name === "k") { scrollBoxRef.current?.scrollBy?.(-1); return; }
      if (key.name === "g") { if (scrollBoxRef.current) { scrollBoxRef.current.stickyScroll = false; scrollBoxRef.current.scrollTo(0); } return; }
      if (key.name === "G") { if (scrollBoxRef.current) scrollBoxRef.current.stickyScroll = true; return; }
      if (key.name === "i") { setFocusedPane("input"); return; }
    }

    if (focusedPane === "sidebar") {
      if (key.name === "p") { setActiveSidebarTab("plan"); return; }
      if (key.name === "c") { setActiveSidebarTab("context"); return; }
      if (key.name === "t") { setActiveSidebarTab("tools"); return; }
    }

    if (shouldRoutePrintableToComposer({
      focusedPane, input: key.sequence || key.name, key: { ctrl: key.ctrl, meta: key.meta, tab: key.name === "tab", escape: key.name === "escape", return: key.name === "return" },
      isProcessing, showSessions, hasApproval: !!approval
    })) {
      setFocusedPane("input");
      setComposerValue((prev) => `${prev}${key.sequence || ""}`);
    }
  });

  const tabs = useMemo(() => [
    {
      id: "plan",
      label: t("sidebar.tabs.plan"),
      component: steps.length > 0
        ? React.createElement("box", { flexDirection: "column" }, ...steps.map((step, i) =>
            React.createElement("box", { key: i, flexDirection: "row" },
              React.createElement("text", { fg: step.done ? THEME.text.success : THEME.accent }, step.done ? " ✓ " : " ○ "),
              React.createElement("text", { fg: THEME.text.dim }, step.label)
            )
          ))
        : React.createElement("box", { justifyContent: "center", paddingY: 2 },
            React.createElement("text", { fg: THEME.text.dim }, t("sidebar.noActivePlan")))
    },
    {
      id: "context",
      label: t("sidebar.tabs.context"),
      component: Object.keys(repoMapData).length > 0
        ? React.createElement(RepoMap, { data: repoMapData, isSidebar: true })
        : React.createElement("box", { justifyContent: "center", paddingY: 2 },
            React.createElement("text", { fg: THEME.text.dim }, t("sidebar.repoMapEmpty")))
    },
    {
      id: "tools",
      label: t("sidebar.tabs.tools"),
      component: React.createElement("box", { flexDirection: "column" },
        React.createElement("text", { fg: THEME.secondary, bold: true }, t("sidebar.recentObservations")),
        ...steps.filter((s) => s.type === "tool").slice(-5).map((step, i) =>
          React.createElement("text", { key: i, fg: THEME.text.dim }, ` - ${step.label}`))
      )
    }
  ], [steps, repoMapData, language]);

  const visibleMessages = messages;

  return React.createElement(
    "box",
    // onMouseUp fires on every mouse release app-wide, including plain
    // clicks with nothing dragged — harmless, since copySelection() is a
    // no-op whenever renderer.getSelection() is null (mirrors opencode's
    // unconditional root-level onMouseUp for the same reason).
    { flexDirection: "column", width, height, onMouseUp: copySelection },

    showSessions ? React.createElement(SessionBrowser, {
      sessions: sessionList, onSelect: handleSessionSelect, onCancel: () => setShowSessions(false)
    }) : null,
    approval ? React.createElement(ApprovalDialog, approval) : null,

    React.createElement("box", { flexDirection: "row", backgroundColor: THEME.backgroundPanel, justifyContent: "space-between", flexShrink: 0 },
      React.createElement(SmallWordmark, { sessionId, model: settings?.model, language }),
      React.createElement("box", { paddingX: 1, flexDirection: "row" },
        isWatching ? React.createElement("text", { fg: THEME.text.success, bold: true }, "👁 watching  ") : null,
        React.createElement("text", { fg: THEME.text.dim }, "tab:focus  /help  esc×2:rewind"))
    ),

    React.createElement("box", { flexGrow: 1, flexDirection: "row", position: "relative" },
      React.createElement("box", {
        width: CHAT_PANE_WIDTH, flexDirection: "column",
        height: CHAT_HEIGHT
      },
        React.createElement("scrollbox", {
          ref: scrollBoxRef, flexGrow: 1, paddingX: 1, stickyScroll: true
        },
          visibleMessages.length === 0
            ? React.createElement("box", { flexGrow: 1, flexDirection: "column", alignItems: "center", justifyContent: "center" },
                React.createElement(BigLogo, { width: CHAT_WIDTH }),
                React.createElement("box", { height: 1 }),
                React.createElement("text", { fg: THEME.text.dim }, t("empty.chat")),
                React.createElement("box", { height: 1 }),
                ...(t("empty.hints") || []).map((hint, i) =>
                  React.createElement("text", { key: i, fg: THEME.dim }, `  ${hint}`))
              )
            : visibleMessages.map((m, i) => React.createElement(
                "box", { key: i, flexDirection: "column", marginBottom: 1 },
                React.createElement("text", { fg: m.role === "user" ? THEME.secondary : THEME.primary, bold: true },
                  m.role === "user" ? "  you › " : "  ✦ solar "),
                ...ansiLines(
                  m.role === "assistant" ? renderMarkdown(m.content || "", CHAT_WIDTH - 4) : (m.content || ""),
                  CHAT_WIDTH - 4,
                  `m${i}-`
                ).map((el) => React.cloneElement(el, { key: el.key })),
                m.diff ? React.createElement(DiffPreview, { diff: m.diff, filetype: m.filetype }) : null,
                m.diff && m.filePath ? React.createElement(
                  "text",
                  {
                    fg: THEME.text.dim,
                    onMouseUp: () => undoFileCheckpoint(m.filePath),
                    onMouseOver: () => renderer?.setMousePointer?.("pointer"),
                    onMouseOut: () => renderer?.setMousePointer?.("default")
                  },
                  `  ↺ undo ${m.filePath}`
                ) : null
              ))
        ),
        isProcessing ? React.createElement(Thinking, { status: currentThought, steps }) : null
      ),
      // opencode's SplitBorder (packages/tui/src/ui/border.ts upstream) is a
      // box-border technique, but a `scrollbox` sibling suppresses rendering
      // of every row sibling declared after it in this OpenTUI version
      // (confirmed via isolated pty repro — a row-reverse workaround was
      // tried first but segfaults the native renderer). So the divider and
      // Sidebar are absolutely positioned overlays anchored to the right
      // edge instead of flex siblings, keeping the scrollbox as the row's
      // only/last-declared flex child.
      React.createElement("box", {
        position: "absolute", top: 0, left: CHAT_PANE_WIDTH,
        width: DIVIDER_WIDTH, height: CHAT_HEIGHT,
        backgroundColor: focusedPane === "chat" || focusedPane === "sidebar" ? THEME.borderActive : THEME.border
      }),
      React.createElement("box", { position: "absolute", top: 0, left: CHAT_PANE_WIDTH + DIVIDER_WIDTH },
        React.createElement(Sidebar, {
          activeTab: activeSidebarTab, tabs, isFocused: focusedPane === "sidebar",
          height: CHAT_HEIGHT,
          onTabClick: (tabId) => { setFocusedPane("sidebar"); setActiveSidebarTab(tabId); }
        })
      )
    ),

    React.createElement("box", { flexDirection: "column" },
      systemWarning ? React.createElement("box", { paddingX: 1 },
        React.createElement("text", { fg: THEME.text.warning }, `⚠  ${systemWarning}`)) : null,
      React.createElement(StatusBar, {
        statusKey, tokenUsage, approvalMode, systemWarning, language,
        onModeClick: () => setApprovalMode((m) => nextMode(m)),
        reasoningEffort, onReasoningClick: cycleReasoningEffort
      }),
      React.createElement(AutocompleteStrip, { autocomplete, commands: commandDescriptions }),
      React.createElement(Composer, {
        onSend: handleSend, isDisabled: isProcessing,
        isFocused: focusedPane === "input" && !showSessions && !approval,
        value: composerValue, onChange: setComposerValue
      })
    )
  );
};

export default App;
