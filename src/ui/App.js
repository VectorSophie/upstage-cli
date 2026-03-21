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
import { enterFullscreenTui, exitFullscreenTui } from './tui.js';
import { runAgentLoop } from '../agent/loop.js';
import { listSessions, loadSession, createSession } from '../runtime/session.js';

const HELP_TEXT = `
  ✦ UPSTAGE CLI SHORTCUTS & COMMANDS
  
  Shortcuts:
  Tab    : Cycle Focus (Input/Chat/Sidebar)
  Ctrl+S : Toggle Session Browser
  Ctrl+T : Toggle Repository Map
  Ctrl+X : Open External Editor
  Esc    : Enter Navigation Mode (j/k to scroll)
  Esc+Esc: Rewind Session (Undo last turn)
  i      : Focus Input (Insert Mode)
  
  Slash Commands:
  /new      : Start a fresh session
  /sessions : Open session browser
  /tree     : Open repository map
  /help     : Show this help message
  /exit     : Exit the application
`;

const LOGO_ART = `
                         :     -                         
                         ::   --                         
                        :::   ---                        
                        :::   ---                        
                        :::: ----                        
                       ::::::-----                       
                      :::::-=------                      
                    ::::::=====------                    
               :::::::-===========--------               
        -------==================================        
               --------===========********               
                    ------=====******                    
                      ------=*******                     
                       -----=*****                       
                        ---- ****                        
                        ---   ***                        
                        ---   ***                        
                         --   **                         
                         -     *
`;

const renderLogo = () => {
  const lines = LOGO_ART.split('\n');
  return lines.map((line, rowIndex) => {
    const chars = line.split('');
    return React.createElement(
      Box,
      { key: rowIndex },
      chars.map((char, charIndex) => {
        let color = '#FFFFFF';
        if (char === ':') color = '#CCCFDB';
        else if (char === '=') color = '#8596F2';
        else if (char === '*') color = '#3D6AF2';
        else if (char === '-') {
          color = rowIndex < 10 ? '#ACBEF2' : '#E899F2';
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
  const [status, setStatus] = useState('Idle');
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

  const [scrollIndex, setScrollIndex] = useState(0);
  const [autoFollow, setAutoFollow] = useState(true);
  const [focusedPane, setFocusedPane] = useState('input');
  const [activeSidebarTab, setActiveSidebarTab] = useState('plan');

  const [composerValue, setComposerValue] = useState('');
  const lastEscPress = useRef(0);
  const { exit } = useApp();
  const terminalHeight = process.stdout.rows || 24;

  useEffect(() => {
    enterFullscreenTui();
    return () => {
      exitFullscreenTui();
    };
  }, []);

  const HEADER_HEIGHT = 28; 
  const FOOTER_HEIGHT = 4; 
  const CHAT_VISIBLE_HEIGHT = Math.max(5, terminalHeight - HEADER_HEIGHT - FOOTER_HEIGHT);

  const visibleMessages = useMemo(() => {
    if (autoFollow) {
      const start = Math.max(0, messages.length - CHAT_VISIBLE_HEIGHT);
      return messages.slice(start);
    }
    return messages.slice(scrollIndex, scrollIndex + CHAT_VISIBLE_HEIGHT);
  }, [messages, scrollIndex, autoFollow, CHAT_VISIBLE_HEIGHT]);

  const tabs = useMemo(() => [
    { 
      id: 'plan', 
      label: 'PLAN', 
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
              React.createElement(Text, { dimColor: step.done }, step.label)
            )
          ))
        )
      ) : (
        React.createElement(
          Box,
          { justifyContent: "center", paddingY: 2 },
          React.createElement(Text, { dimColor: true }, "No active plan")
        )
      )
    },
    { 
      id: 'context', 
      label: 'CONTEXT', 
      component: Object.keys(repoMapData).length > 0 ? (
        React.createElement(RepoMap, { data: repoMapData, isSidebar: true })
      ) : (
        React.createElement(
          Box,
          { justifyContent: "center", paddingY: 2 },
          React.createElement(Text, { dimColor: true }, "Repository map empty")
        )
      )
    },
    { 
      id: 'tools', 
      label: 'TOOLS', 
      component: (
        React.createElement(
          Box,
          { flexDirection: "column" },
          React.createElement(Text, { color: THEME.indigo, bold: true }, "Recent Observations:"),
          steps.filter(s => s.label.includes('tool')).slice(-5).map((s, i) => (
            React.createElement(Text, { key: i, dimColor: true }, ` - ${s.label}`)
          ))
        )
      )
    }
  ], [steps, repoMapData]);

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
      }
      setStatus('Session Rewound');
    }
  }, [messages, currentSession]);

  useInput((input, key) => {
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
    setShowSessions(false);
    setFocusedPane('input');
  };

  const handleSend = useCallback(async (query) => {
    if (query === '/exit') {
        process.exit(0);
        return;
    }
    if (query === '/new') {
        const newSess = createSession(process.cwd());
        setSessionId(newSess.id);
        setCurrentSession(newSess);
        setMessages([]);
        setTokenUsage({ total: 0, cost: 0 });
        setSystemWarning('');
        setStatus('New Session Started');
        return;
    }
    if (query === '/help') {
        setMessages(prev => [...prev, { role: 'user', content: '/help' }, { role: 'assistant', content: HELP_TEXT }]);
        return;
    }
    if (query === '/sessions') {
        setShowSessions(true);
        setFocusedPane('chat');
        return;
    }
    if (query === '/tree') {
        setShowRepoMap(true);
        setFocusedPane('sidebar');
        return;
    }

    setIsProcessing(true);
    setStatus('Thinking...');
    setMessages(prev => [...prev, { role: 'user', content: query }]);
    setSteps([]);
    setCurrentThought(null);

    try {
      let assistantResponse = '';
      let lastDiff = null;
      
      const result = await runAgentLoop({
        input: query,
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
            setSteps(prev => [...prev, { label: `Planning: ${event.mode}`, done: true }]);
          } else if (event.type === 'TOOL') {
            setSteps(prev => [...prev, { label: `Using tool: ${event.tool}`, done: false }]);
          } else if (event.type === 'OBSERVATION') {
            setSteps(prev => {
              const last = prev[prev.length - 1];
              if (last && last.label.includes(event.tool)) {
                return [...prev.slice(0, -1), { ...last, done: true }];
              }
              return prev;
            });
          } else if (event.type === 'THINKING') {
            setCurrentThought(event.thought?.subject || 'Analyzing...');
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
              const warningMessage = event.message || 'Session context usage exceeded 80% of Solar Pro2 token limit.';
              setSystemWarning(warningMessage);
              setStatus('Warning');
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
      
      setStatus('Idle');
    } catch (err) {
      setMessages(prev => [...prev, { role: 'assistant', content: `Error: ${err.message}` }]);
      setStatus('Error');
    } finally {
      setIsProcessing(false);
      setCurrentThought(null);
    }
  }, [registry, adapter, currentSession, runtimeCache]);

  return React.createElement(
    Box,
    { flexDirection: "column", height: "100%", width: "100%" },
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
      React.createElement(Box, { flexDirection: "column", marginBottom: 1 }, renderLogo()),
      React.createElement(
        Box,
        { paddingX: 1 },
        React.createElement(Text, { color: THEME.primary, bold: true }, " ✦ UPSTAGE SOLAR-PRO "),
        React.createElement(Text, { color: THEME.dim }, `  v1.0.0  ·  ${sessionId.slice(0, 8)} `)
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
                React.createElement(Text, { dimColor: true }, "How can I help you today?")
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
        React.createElement(Text, { color: THEME.text.warning }, `[WARN] ${systemWarning}`)
      ),
      React.createElement(StatusBar, {
        status: status,
        tokenUsage: tokenUsage,
        approvalMode: approvalMode,
        warningMessage: systemWarning,
        isFocused: focusedPane === 'input'
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
