import React, { useState, useCallback, useEffect, useMemo, useRef } from 'react';
import { Box, Text, useInput, useApp } from 'ink';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { spawnSync } from 'child_process';
import { Composer } from './components/Composer.js';
import { Thinking } from './components/Thinking.js';
import { DiffPreview } from './components/DiffPreview.js';
import { SessionBrowser } from './components/SessionBrowser.js';
import { RepoMap } from './components/RepoMap.js';
import { ApprovalDialog } from './components/ApprovalDialog.js';
import { Sidebar } from './components/Sidebar.js';
import { StatusBar } from './components/StatusBar.js';
import { THEME } from './colors.js';
import { canUseFullscreenTui, enterFullscreenTui, exitFullscreenTui } from './tui.js';
import { shouldRoutePrintableToComposer } from './input-routing.js';
import { runAgentLoop } from '../agent/loop.js';
import { createSession, listSessions, loadSession, saveSession } from '../runtime/session.js';
import {
  getLanguage,
  initializeLanguage,
  isSupportedLanguage,
  setLanguage as setI18nLanguage,
  subscribeLanguage,
  t
} from '../i18n/index.js';

const LOGO_LINES = [
  '                        :    -                        ',
  '                        :    -                        ',
  '                       :::  ---                       ',
  '                       :::  ---                       ',
  '                       :::  ---                       ',
  '                      :::::-----                      ',
  '                     :::::-------                     ',
  '                   :::::-====------                   ',
  '                ::::::==========------                ',
  '       :::::::=================================       ',
  '                ------==========******                ',
  '                   ------====******                   ',
  '                     -----=******                     ',
  '                      -----*****                      ',
  '                       ---  ***                       ',
  '                       ---  ***                       ',
  '                       ---  ***                       ',
  '                        -    *                        ',
  '                        -    *                        '
];


const renderLogo = () => {
  return LOGO_LINES.map((line, rowIndex) => {
    const chars = line.split('');
    return React.createElement(
      Box,
      { key: rowIndex },
      chars.map((char, charIndex) => {
        let color = '#FFFFFF';
        if (char === ':') color = '#D8DCEC';
        else if (char === '=') color = '#7E9CFF';
        else if (char === '*') color = '#3D6AF2';
        else if (char === '-') {
          color = rowIndex < 10 ? '#ACC0F4' : '#E8A0F2';
        }
        return React.createElement(Text, { key: charIndex, color }, char);
      })
    );
  });
};

const App = ({ sessionId: initialSessionId, registry, adapter, args, session: initialSession, runtimeCache }) => {
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

  const HEADER_HEIGHT = LOGO_LINES.length + 3; 
  const FOOTER_HEIGHT = 4; 
  const CHAT_VISIBLE_HEIGHT = Math.max(5, terminalHeight - HEADER_HEIGHT - FOOTER_HEIGHT);

  const visibleMessages = useMemo(() => {
    if (autoFollow) {
      const start = Math.max(0, messages.length - CHAT_VISIBLE_HEIGHT);
      return messages.slice(start);
    }
    return messages.slice(scrollIndex, scrollIndex + CHAT_VISIBLE_HEIGHT);
  }, [messages, scrollIndex, autoFollow, CHAT_VISIBLE_HEIGHT]);

  const helpText = useMemo(() => t('help.text'), [language]);

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

    if (trimmedQuery === '/clear') {
        process.stdout.write("\x1b[2J\x1b[H");
        setMessages([]);
        setStatusKey('idle');
        return;
    }
    if (trimmedQuery === '/exit') {
        process.exit(0);
        return;
    }
    if (trimmedQuery === '/new') {
        const newSess = createSession(process.cwd());
        const activeLanguage = getLanguage();
        newSess.preferences = {
          ...(newSess.preferences || {}),
          language: activeLanguage
        };
        await saveSession(newSess);

        setSessionId(newSess.id);
        setCurrentSession(newSess);
        setMessages([]);
        setTokenUsage({ total: 0, cost: 0 });
        setSystemWarning('');
        setStatusKey('newSessionStarted');
        return;
    }
    if (trimmedQuery === '/help') {
        setMessages(prev => [...prev, { role: 'user', content: '/help' }, { role: 'assistant', content: helpText }]);
        return;
    }
    const [commandName, requestedLanguage] = trimmedQuery.split(/\s+/);
    if (commandName === '/lang') {
        setMessages(prev => [...prev, { role: 'user', content: trimmedQuery }]);

        if (!requestedLanguage) {
          setMessages(prev => [...prev, { role: 'assistant', content: t('commands.langUsage') }]);
          return;
        }
        const normalizedLanguage = requestedLanguage.toLowerCase();
        if (!isSupportedLanguage(normalizedLanguage)) {
          setMessages(prev => [...prev, {
            role: 'assistant',
            content: t('commands.langUnsupported', { language: requestedLanguage })
          }]);
          return;
        }
        if (normalizedLanguage === getLanguage()) {
          setMessages(prev => [...prev, {
            role: 'assistant',
            content: t('commands.langAlreadySet', { language: t(`languages.${normalizedLanguage}`) })
          }]);
          return;
        }

        setI18nLanguage(normalizedLanguage);
        if (currentSession) {
          await persistSessionLanguage(currentSession, normalizedLanguage);
        }
        setStatusKey('languageChanged');
        setMessages(prev => [...prev, {
          role: 'assistant',
          content: t('commands.langChanged', { language: t(`languages.${normalizedLanguage}`) })
        }]);
        return;
    }
    if (trimmedQuery === '/sessions') {
        setShowSessions(true);
        setFocusedPane('chat');
        return;
    }
    if (trimmedQuery === '/tree') {
        setShowRepoMap(true);
        setFocusedPane('sidebar');
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
      
      const result = await runAgentLoop({
        input: trimmedQuery,
        registry,
        cwd: process.cwd(),
        adapter,
        stream: true,
        session: currentSession,
        runtimeCache,
        onToken: (token) => {
          assistantResponse += token;
          setMessages(prev => {
            const last = prev[prev.length - 1];
            if (last && last.role === 'assistant') {
              return [...prev.slice(0, -1), { role: 'assistant', content: assistantResponse, diff: lastDiff }];
            }
            return [...prev, { role: 'assistant', content: assistantResponse, diff: lastDiff }];
          });
        },
        onEvent: (event) => {
          if (event.type === 'PLAN') {
            setSteps(prev => [...prev, {
              type: 'plan',
              labelKey: 'steps.plan',
              labelParams: { mode: event.mode },
              done: true
            }]);
          } else if (event.type === 'TOOL') {
            setSteps(prev => [...prev, {
              type: 'tool',
              tool: event.tool,
              labelKey: 'steps.tool',
              labelParams: { tool: event.tool },
              done: false
            }]);
          } else if (event.type === 'OBSERVATION') {
            setSteps(prev => {
              const last = prev[prev.length - 1];
              if (last && last.type === 'tool' && last.tool === event.tool) {
                return [...prev.slice(0, -1), { ...last, done: true }];
              }
              return prev;
            });
          } else if (event.type === 'THINKING') {
            setCurrentThought(event.thought?.subject || t('steps.analyzing'));
          } else if (event.type === 'PATCH_PREVIEW') {
            lastDiff = event.patch?.unifiedDiff;
            setMessages(prev => {
                const last = prev[prev.length - 1];
                if (last && last.role === 'assistant') {
                    return [...prev.slice(0, -1), { ...last, diff: lastDiff }];
                }
                return prev;
            });
          } else if (event.type === 'TOKEN_USAGE') {
              setTokenUsage(prev => ({
                  total: prev.total + (event.usage?.totalTokens || 0),
                  cost: prev.cost + (event.usage?.cost || 0)
              }));
          } else if (event.type === 'SYSTEM_WARNING') {
              const warningMessage = event.message || t('warning.tokenContextHigh');
              setSystemWarning(warningMessage);
              setStatusKey('warning');
          }
        },
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
  }, [registry, adapter, currentSession, runtimeCache, helpText, persistSessionLanguage]);

  return React.createElement(
    Box,
    { flexDirection: "column", height: terminalHeight, width: "100%", overflow: "hidden" },
    showSessions && React.createElement(SessionBrowser, { 
        sessions: sessionList, 
        onSelect: handleSessionSelect, 
        onCancel: () => setShowSessions(false) 
    }),
    approval && React.createElement(ApprovalDialog, approval),
    
    React.createElement(
      Box,
      { 
        flexDirection: "column", 
        alignItems: "center", 
        borderStyle: "single", 
        borderColor: THEME.dim, 
        paddingY: 0,
        overflow: "hidden"
      },
      React.createElement(Box, { flexDirection: "column", marginBottom: 0 }, renderLogo()),
      React.createElement(
        Box,
        { paddingX: 1 },
        React.createElement(Text, { color: THEME.primary, bold: true }, t('header.product')),
        React.createElement(Text, { color: THEME.dim }, t('header.sessionVersion', { session: sessionId.slice(0, 8) }))
      )
    ),

    React.createElement(
      Box,
      { flexGrow: 1, flexDirection: "row" },
      
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
                  React.createElement(
                    Text,
                    { color: m.role === 'user' ? THEME.secondary : THEME.primary },
                    `${m.role === 'user' ? '> ' : '✦ '}${m.content}`
                  ),
                  m.diff && React.createElement(DiffPreview, { diff: m.diff })
                )
              ),
          isProcessing && React.createElement(Thinking, { status: currentThought, steps: steps })
        ),


      React.createElement(Sidebar, {
        activeTab: activeSidebarTab,
        tabs: tabs,
        isFocused: focusedPane === 'sidebar',
        focusColor: THEME.primary,
        height: CHAT_VISIBLE_HEIGHT
      })
    ),

    React.createElement(
      Box,
      { flexDirection: "column" },
      systemWarning && React.createElement(
        Box,
        { borderStyle: "single", borderColor: THEME.text.warning, paddingX: 1 },
        React.createElement(Text, { color: THEME.text.warning }, `[${t('warning.badge')}] ${systemWarning}`)
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
