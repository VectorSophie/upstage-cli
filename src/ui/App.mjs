import React, { useState, useCallback, useEffect, useMemo, useRef } from 'react';
import { Box, Text, useInput, useApp } from 'ink';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { spawnSync } from 'child_process';
import { executeCommand } from "./commands.mjs";
import { renderMarkdown } from "./markdown.mjs";
import { Composer } from "./components/Composer.mjs";
import { Thinking } from "./components/Thinking.mjs";
import { DiffPreview } from "./components/DiffPreview.mjs";
import { SessionBrowser } from "./components/SessionBrowser.mjs";
import { RepoMap } from "./components/RepoMap.mjs";
import { ApprovalDialog } from "./components/ApprovalDialog.mjs";
import { Sidebar } from "./components/Sidebar.mjs";
import { StatusBar } from "./components/StatusBar.mjs";
import { THEME } from "./colors.mjs";
import { canUseFullscreenTui, enterFullscreenTui, exitFullscreenTui } from "./tui.mjs";
import { shouldRoutePrintableToComposer } from "./input-routing.mjs";
import { runAgentLoop } from "../agent/loop.mjs";
import { createSession, listSessions, loadSession, saveSession } from "../runtime/session.mjs";
import {
  getLanguage,
  initializeLanguage,
  isSupportedLanguage,
  setLanguage as setI18nLanguage,
  subscribeLanguage,
  t
} from "../i18n/index.mjs";

// Compact wordmark — replaces the 19-line ASCII logo
const renderWordmark = (sessionId, model, language) => {
  return React.createElement(
    Box,
    { flexDirection: "row", paddingX: 1, paddingY: 0 },
    React.createElement(Text, { color: '#E899F2', bold: true }, '◉ solar'),
    React.createElement(Text, { color: '#3D6AF2', bold: true }, '  '),
    React.createElement(Text, { color: '#ACBEF2' }, `${model || 'solar-pro2'}  ·  `),
    React.createElement(Text, { color: '#7C8DB2' }, `${sessionId?.slice(0, 8) || '--------'}  ·  ${(language || 'ko').toUpperCase()}`)
  );
};

const App = ({ sessionId: initialSessionId, registry, adapter, args, session: initialSession, runtimeCache, settings }) => {
  const [sessionId, setSessionId] = useState(initialSessionId);
  const [currentSession, setCurrentSession] = useState(initialSession);
  const [messages, setMessages] = useState([]);
  const [statusKey, setStatusKey] = useState('idle');
  const [isProcessing, setIsProcessing] = useState(false);
  const [currentThought, setCurrentThought] = useState(null);
  const [steps, setSteps] = useState([]);
  
  const [showSessions, setShowSessions] = useState(false);
  const [sessionList, setSessionList] = useState([]);
  const [showRepoMap, setShowRepoMap] = useState(false);
  const [repoMapData, setRepoMapData] = useState({});

  const [approval, setApproval] = useState(null);
  const [tokenUsage, setTokenUsage] = useState({ total: 0, cost: 0 });
  const [systemWarning, setSystemWarning] = useState('');
  const [approvalMode, setApprovalMode] = useState('default');
  const [language, setLanguageState] = useState(() => {
    initializeLanguage(initialSession?.preferences?.language);
    return getLanguage();
  });

  const [scrollIndex, setScrollIndex] = useState(0);
  const [autoFollow, setAutoFollow] = useState(true);
  const [focusedPane, setFocusedPane] = useState('input');
  const [activeSidebarTab, setActiveSidebarTab] = useState('plan');

  const [composerValue, setComposerValue] = useState('');
  const lastEscPress = useRef(0);
  const exitRequested = useRef(false);
  const fullscreenEnabled = useRef(false);
  const { exit } = useApp();
  const terminalHeight = process.stdout.rows || 24;

  useEffect(() => {
    fullscreenEnabled.current = canUseFullscreenTui();
    if (fullscreenEnabled.current) {
      enterFullscreenTui();
    }

    const handleExitSignal = () => {
      if (exitRequested.current) {
        return;
      }
      exitRequested.current = true;
      exit();
    };

    process.on('SIGINT', handleExitSignal);
    process.on('SIGTERM', handleExitSignal);

    return () => {
      process.off('SIGINT', handleExitSignal);
      process.off('SIGTERM', handleExitSignal);
      if (fullscreenEnabled.current) {
        exitFullscreenTui();
      }
    };
  }, [exit]);


  useEffect(() => {
    return subscribeLanguage((nextLanguage) => {
      setLanguageState(nextLanguage);
    });
  }, []);

  const persistSessionLanguage = useCallback(async (session, nextLanguage) => {
    if (!session || !isSupportedLanguage(nextLanguage)) {
      return;
    }
    if (!session.preferences || typeof session.preferences !== 'object') {
      session.preferences = {};
    }
    session.preferences.language = nextLanguage;
    session.updatedAt = Date.now();
    await saveSession(session);
  }, []);

  useEffect(() => {
    if (!currentSession) {
      return;
    }
    const preferredLanguage = currentSession.preferences?.language;
    if (isSupportedLanguage(preferredLanguage)) {
      setI18nLanguage(preferredLanguage);
      return;
    }
    persistSessionLanguage(currentSession, getLanguage()).catch(() => {});
  }, [currentSession, persistSessionLanguage]);

  const HEADER_HEIGHT = 3;  // compact wordmark bar
  const FOOTER_HEIGHT = 5;  // status bar + composer
  const CHAT_VISIBLE_HEIGHT = Math.max(5, terminalHeight - HEADER_HEIGHT - FOOTER_HEIGHT);

  const visibleMessages = useMemo(() => {
    if (autoFollow) {
      const start = Math.max(0, messages.length - CHAT_VISIBLE_HEIGHT);
      return messages.slice(start);
    }
    return messages.slice(scrollIndex, scrollIndex + CHAT_VISIBLE_HEIGHT);
  }, [messages, scrollIndex, autoFollow, CHAT_VISIBLE_HEIGHT]);

  // helpText removed — /help now handled by commands.mjs

  const tabs = useMemo(() => [
    { 
      id: 'plan', 
      label: t('sidebar.tabs.plan'), 
      component: steps.length > 0 ? (
        React.createElement(
          Box,
          { flexDirection: "column" },
          steps.map((step, i) => (
            React.createElement(
              Box,
              { key: i },
              React.createElement(
                Text,
                { color: step.done ? THEME.text.success : THEME.accent },
                step.done ? ' ✓ ' : ' ○ '
              ),
              React.createElement(Text, { dimColor: step.done }, t(step.labelKey, step.labelParams))
            )
          ))
        )
      ) : (
        React.createElement(
          Box,
          { justifyContent: "center", paddingY: 2 },
          React.createElement(Text, { dimColor: true }, t('sidebar.noActivePlan'))
        )
      )
    },
    { 
      id: 'context', 
      label: t('sidebar.tabs.context'), 
      component: Object.keys(repoMapData).length > 0 ? (
        React.createElement(RepoMap, { data: repoMapData, isSidebar: true })
      ) : (
        React.createElement(
          Box,
          { justifyContent: "center", paddingY: 2 },
          React.createElement(Text, { dimColor: true }, t('sidebar.repoMapEmpty'))
        )
      )
    },
    { 
      id: 'tools', 
      label: t('sidebar.tabs.tools'), 
      component: (
        React.createElement(
          Box,
          { flexDirection: "column" },
          React.createElement(Text, { color: THEME.indigo, bold: true }, t('sidebar.recentObservations')),
          steps.filter((step) => step.type === 'tool').slice(-5).map((step, i) => (
            React.createElement(Text, { key: i, dimColor: true }, ` - ${t(step.labelKey, step.labelParams)}`)
          ))
        )
      )
    }
  ], [steps, repoMapData, language]);

  useEffect(() => {
    if (initialSession && initialSession.history) {
        setMessages(initialSession.history.map(h => ({ role: h.role, content: h.content, diff: h.diff })) || []);
    }
  }, [initialSession]);

  useEffect(() => {
    if (showSessions) {
      listSessions().then(setSessionList);
    }
  }, [showSessions]);

  useEffect(() => {
    if (showRepoMap) {
      registry.execute("repo_map", { maxFiles: 120 }, { cwd: process.cwd(), runtimeCache })
        .then(res => res.ok && setRepoMapData(res.data));
    }
  }, [showRepoMap, registry, runtimeCache]);

  const openExternalEditor = useCallback((initialText) => {
    const editor = process.env.EDITOR || 'vim';
    const tmpFile = path.join(os.tmpdir(), `upstage-cli-${Date.now()}.md`);
    
    fs.writeFileSync(tmpFile, initialText || '');
    
    try {
      spawnSync(editor, [tmpFile], { stdio: 'inherit' });
      const newText = fs.readFileSync(tmpFile, 'utf8');
      setComposerValue(newText.trim());
    } catch (err) {
      console.error('Failed to open external editor:', err);
    } finally {
      if (fs.existsSync(tmpFile)) {
        fs.unlinkSync(tmpFile);
      }
    }
  }, []);

  const rewindSession = useCallback(() => {
    if (messages.length >= 2) {
      setMessages(prev => prev.slice(0, -2));
      if (currentSession && currentSession.history) {
        currentSession.history = currentSession.history.slice(0, -2);
        saveSession(currentSession).catch(() => {});
      }
      setStatusKey('sessionRewound');
    }
  }, [messages, currentSession]);

  useInput((input, key) => {
    if (shouldRoutePrintableToComposer({
      focusedPane,
      input,
      key,
      isProcessing,
      showSessions,
      hasApproval: !!approval
    })) {
      setFocusedPane('input');
      setComposerValue((prev) => `${prev}${input}`);
      return;
    }

    if (input === 'r' && key.ctrl) {
        process.stdout.write("\x1b[2J\x1b[H");
        return;
    }

    if (key.tab) {
      setFocusedPane(prev => {
        if (prev === 'input') return 'chat';
        if (prev === 'chat') return 'sidebar';
        return 'input';
      });
      return;
    }

    if (input === 's' && key.ctrl) {
      setShowSessions(prev => !prev);
      setFocusedPane(showSessions ? 'input' : 'chat');
    }
    if (input === 't' && key.ctrl) {
      setShowRepoMap(prev => !prev);
      setFocusedPane(showRepoMap ? 'input' : 'sidebar');
    }

    if (input === 'x' && key.ctrl) {
      openExternalEditor(composerValue);
      return;
    }
    
    if (focusedPane === 'chat') {
      if (input === 'j') {
        setScrollIndex(prev => Math.min(messages.length - 1, prev + 1));
        setAutoFollow(false);
      }
      if (input === 'k') {
        setScrollIndex(prev => Math.max(0, prev - 1));
        setAutoFollow(false);
      }
      if (input === 'g') { 
        setScrollIndex(0);
        setAutoFollow(false);
      }
      if (input === 'G') { 
        setAutoFollow(true);
      }
      if (input === 'i') setFocusedPane('input');
    }

    if (focusedPane === 'sidebar') {
        if (input === 'p') setActiveSidebarTab('plan');
        if (input === 'c') setActiveSidebarTab('context');
        if (input === 't') setActiveSidebarTab('tools');
    }
    
    if (key.escape) {
      const now = Date.now();
      if (now - lastEscPress.current < 500) {
        rewindSession();
      }
      lastEscPress.current = now;

      setFocusedPane('chat');
      setShowSessions(false);
      setShowRepoMap(false);
    }
  });

  const handleSessionSelect = async (sessionMeta) => {
    const loaded = await loadSession(sessionMeta.id);
    setSessionId(loaded.id);
    setCurrentSession(loaded);
    setMessages(loaded.history.map(h => ({ role: h.role, content: h.content, diff: h.diff })) || []);
    setTokenUsage({ total: 0, cost: 0 });
    setSystemWarning('');
    setStatusKey('idle');
    setShowSessions(false);
    setFocusedPane('input');

    const preferredLanguage = loaded.preferences?.language;
    if (isSupportedLanguage(preferredLanguage)) {
      setI18nLanguage(preferredLanguage);
      return;
    }
    await persistSessionLanguage(loaded, getLanguage());
  };

  const handleSend = useCallback(async (query) => {
    const trimmedQuery = typeof query === 'string' ? query.trim() : '';
    if (!trimmedQuery) {
      return;
    }

    // Slash command dispatch
    if (trimmedQuery.startsWith('/')) {
      setMessages(prev => [...prev, { role: 'user', content: trimmedQuery }]);

      const cmdState = {
        messages,
        turnCount: messages.length / 2,
        tokenUsage,
        model: settings?.model || 'solar-pro2',
        tools: registry?.list?.() || [],
        _contextManager: runtimeCache?.contextManager || null,
        _checkpointManager: runtimeCache?.checkpointManager || null,
        _permissionMode: approvalMode,
        _session: currentSession,
        _settings: settings,
        _registry: registry,
        _agentLoader: runtimeCache?.agentLoader || null,
        _skillsLoader: runtimeCache?.skillsLoader || null,
      };

      const result = await executeCommand(trimmedQuery, cmdState);

      if (result.clearMessages) {
        process.stdout.write("\x1b[2J\x1b[H");
        setMessages([]);
        setStatusKey('idle');
        return;
      }
      if (result.exit) {
        exit();
        return;
      }
      if (result.showSessions) {
        setShowSessions(true);
        setFocusedPane('chat');
        setMessages(prev => prev.slice(0, -1)); // remove the /sessions user message
        return;
      }
      if (result.showTree) {
        setShowRepoMap(true);
        setFocusedPane('sidebar');
        setMessages(prev => prev.slice(0, -1));
        return;
      }
      if (result.newSession) {
        const newSess = createSession(process.cwd());
        const activeLanguage = getLanguage();
        newSess.preferences = { ...(newSess.preferences || {}), language: activeLanguage };
        await saveSession(newSess);
        setSessionId(newSess.id);
        setCurrentSession(newSess);
        setMessages([]);
        setTokenUsage({ total: 0, cost: 0 });
        setSystemWarning('');
        setStatusKey('newSessionStarted');
        return;
      }
      if (result.changeLang) {
        const normalizedLanguage = result.changeLang.toLowerCase();
        if (isSupportedLanguage(normalizedLanguage)) {
          setI18nLanguage(normalizedLanguage);
          if (currentSession) await persistSessionLanguage(currentSession, normalizedLanguage);
          setStatusKey('languageChanged');
        }
      }
      if (result.updatedMessages) {
        setMessages(result.updatedMessages);
      }

      if (result.response && !result.response.startsWith('__')) {
        setMessages(prev => [...prev, { role: 'assistant', content: result.response }]);
      }
      return;
    }

    setIsProcessing(true);
    setStatusKey('thinking');
    setMessages(prev => [...prev, { role: 'user', content: trimmedQuery }]);
    setSteps([]);
    setCurrentThought(null);

    try {
      let assistantResponse = '';
      let lastDiff = null;

    const gen = runAgentLoop({
      input: trimmedQuery,
      registry,
      cwd: process.cwd(),
      adapter,
      stream: true,
      session: currentSession,
      runtimeCache,
      settings,
      systemPromptOverride: args?.systemPrompt || null,
      addDirs: args?.addDirs || [],
      confirm: async (tool, params) => {
        return new Promise((resolve) => {
          setApproval({
            tool,
            params,
            onApprove: () => { setApproval(null); resolve(true); },
            onDeny: () => { setApproval(null); resolve(false); }
          });
        });
      }
    });

      let result;
      while (true) {
        const next = await gen.next();
        if (next.done) {
          result = next.value;
          break;
        }
        const event = next.value;

        if (event.type === 'stream_token') {
          assistantResponse += (event.text || '');
          setMessages(prev => {
            const last = prev[prev.length - 1];
            if (last && last.role === 'assistant') {
              return [...prev.slice(0, -1), { role: 'assistant', content: assistantResponse, diff: lastDiff }];
            }
            return [...prev, { role: 'assistant', content: assistantResponse, diff: lastDiff }];
          });
        } else if (event.type === 'plan') {
          setSteps(prev => [...prev, {
            type: 'plan',
            labelKey: 'steps.plan',
            labelParams: { mode: event.mode },
            done: true
          }]);
        } else if (event.type === 'tool_start') {
          setSteps(prev => [...prev, {
            type: 'tool',
            tool: event.tool,
            labelKey: 'steps.tool',
            labelParams: { tool: event.tool },
            done: false
          }]);
        } else if (event.type === 'tool_result') {
          setSteps(prev => {
            const last = prev[prev.length - 1];
            if (last && last.type === 'tool' && last.tool === event.tool) {
              return [...prev.slice(0, -1), { ...last, done: true }];
            }
            return prev;
          });
        } else if (event.type === 'thinking') {
          setCurrentThought(event.thought?.subject || t('steps.analyzing'));
        } else if (event.type === 'patch_preview') {
          lastDiff = event.patch?.unifiedDiff;
          setMessages(prev => {
            const last = prev[prev.length - 1];
            if (last && last.role === 'assistant') {
              return [...prev.slice(0, -1), { ...last, diff: lastDiff }];
            }
            return prev;
          });
        } else if (event.type === 'token_usage') {
          setTokenUsage(prev => ({
            total: prev.total + (event.usage?.totalTokens || 0),
            cost: prev.cost + (event.usage?.cost || 0)
          }));
        } else if (event.type === 'system_warning') {
          const warningMessage = event.message || t('warning.tokenContextHigh');
          setSystemWarning(warningMessage);
          setStatusKey('warning');
        }
      }

      if (!assistantResponse && result.response) {
        setMessages(prev => [...prev, { role: 'assistant', content: result.response, diff: lastDiff }]);
      }

      if (result.session) {
        setCurrentSession(result.session);
        await saveSession(result.session);
      } else if (currentSession) {
        await saveSession(currentSession);
      }

      setStatusKey('idle');
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      setMessages(prev => [...prev, {
        role: 'assistant',
        content: t('errors.prefix', { message: errorMessage })
      }]);
      setStatusKey('error');
    } finally {
      setIsProcessing(false);
      setCurrentThought(null);
    }
  }, [registry, adapter, currentSession, runtimeCache, persistSessionLanguage]);

  return React.createElement(
    Box,
    { flexDirection: "column", height: terminalHeight, width: "100%", overflow: "hidden" },

    // ── Overlays (session browser, approval) ──────────────────────────────
    showSessions && React.createElement(SessionBrowser, {
      sessions: sessionList,
      onSelect: handleSessionSelect,
      onCancel: () => setShowSessions(false)
    }),
    approval && React.createElement(ApprovalDialog, approval),

    // ── Compact header bar ────────────────────────────────────────────────
    React.createElement(
      Box,
      {
        flexDirection: "row",
        borderStyle: "single",
        borderColor: THEME.dim,
        paddingY: 0,
        justifyContent: "space-between",
      },
      renderWordmark(sessionId, settings?.model, language),
      React.createElement(
        Box,
        { paddingX: 1 },
        React.createElement(Text, { color: THEME.text.dim, dimColor: true },
          'Tab:포커스  /help:명령어  Esc×2:되돌리기'
        )
      )
    ),

    // ── Main body: chat + sidebar ─────────────────────────────────────────
    React.createElement(
      Box,
      { flexGrow: 1, flexDirection: "row" },

      // Chat pane
      React.createElement(
        Box,
        {
          flexGrow: 1,
          flexDirection: "column",
          borderStyle: "round",
          borderColor: focusedPane === 'chat' ? THEME.primary : THEME.dim,
          paddingX: 1,
          height: CHAT_VISIBLE_HEIGHT,
          overflow: "hidden"
        },
        visibleMessages.length === 0
          ? React.createElement(
              Box,
              { justifyContent: "center", paddingY: 2 },
              React.createElement(Text, { dimColor: true }, t('empty.chat'))
            )
          : visibleMessages.map((m, i) =>
              React.createElement(
                Box,
                { key: i, flexDirection: "column", marginBottom: 1 },
                // Role label
                React.createElement(
                  Box,
                  { flexDirection: "row" },
                  React.createElement(
                    Text,
                    { color: m.role === 'user' ? THEME.secondary : THEME.primary, bold: true },
                    m.role === 'user' ? '  you › ' : '  ✦ solar '
                  )
                ),
                // Message content — markdown for assistant, plain for user
                React.createElement(
                  Box,
                  { paddingLeft: 2 },
                  m.role === 'assistant'
                    ? React.createElement(Text, { wrap: "wrap" }, renderMarkdown(m.content || ''))
                    : React.createElement(Text, { color: THEME.text.primary, wrap: "wrap" }, m.content || '')
                ),
                // Diff preview
                m.diff && React.createElement(DiffPreview, { diff: m.diff })
              )
            ),
        isProcessing && React.createElement(Thinking, { status: currentThought, steps: steps })
      ),

      // Sidebar
      React.createElement(Sidebar, {
        activeTab: activeSidebarTab,
        tabs: tabs,
        isFocused: focusedPane === 'sidebar',
        focusColor: THEME.primary,
        height: CHAT_VISIBLE_HEIGHT
      })
    ),

    // ── Footer: warnings + status + composer ──────────────────────────────
    React.createElement(
      Box,
      { flexDirection: "column" },
      systemWarning && React.createElement(
        Box,
        { borderStyle: "single", borderColor: THEME.text.warning, paddingX: 1 },
        React.createElement(Text, { color: THEME.text.warning }, `⚠  ${systemWarning}`)
      ),
      React.createElement(StatusBar, {
        statusKey: statusKey,
        tokenUsage: tokenUsage,
        approvalMode: approvalMode,
        systemWarning: systemWarning,
        language: language
      }),
      React.createElement(Composer, {
        onSend: handleSend,
        isDisabled: isProcessing,
        isFocused: focusedPane === 'input' && !showSessions && !approval,
        value: composerValue,
        onChange: setComposerValue
      })
    )
  );
};

export default App;
