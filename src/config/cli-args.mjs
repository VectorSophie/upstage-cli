export function parseCliArgs(argv) {
  const result = {
    command: 'chat',
    help: false,
    prompt: null,
    stream: true,
    model: null,
    sessionId: null,
    newSession: false,
    resetSession: false,
    confirmPatches: false,
    bridgeJson: false,
    permissionMode: null,
    systemPrompt: null,
    cwd: null,
    addDirs: [],
    maxTurns: null,
    maxTimeSec: null,
    allowedTools: null,
    disallowedTools: null,
    verbose: false,
    debug: false,
    language: null,
  };

  let i = 0;
  if (argv[0] === 'chat' || argv[0] === 'ask' || argv[0] === 'tui') {
    result.command = argv[0];
    i = 1;
  }

  for (; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === '-h' || token === '--help') {
      result.help = true;
      continue;
    }
    if (token === '-p' || token === '--prompt') {
      result.prompt = argv[i + 1] || '';
      i += 1;
      continue;
    }
    if (token === '--no-stream') {
      result.stream = false;
      continue;
    }
    if (token === '--model' || token === '-m') {
      result.model = argv[i + 1] || null;
      i += 1;
      continue;
    }
    if (token === '--session') {
      result.sessionId = argv[i + 1] || null;
      i += 1;
      continue;
    }
    if (token === '--new-session') {
      result.newSession = true;
      continue;
    }
    if (token === '--reset-session') {
      result.resetSession = true;
      continue;
    }
    if (token === '--confirm-patches') {
      result.confirmPatches = true;
      continue;
    }
    if (token === '--bridge-json') {
      result.bridgeJson = true;
      continue;
    }
    if (token === '--permission-mode') {
      result.permissionMode = argv[i + 1] || null;
      i += 1;
      continue;
    }
    if (token === '--system-prompt') {
      result.systemPrompt = argv[i + 1] || null;
      i += 1;
      continue;
    }
    if (token === '--cwd') {
      result.cwd = argv[i + 1] || null;
      i += 1;
      continue;
    }
    if (token === '--add-dir') {
      result.addDirs.push(argv[i + 1] || '');
      i += 1;
      continue;
    }
    if (token === '--max-turns') {
      result.maxTurns = parseInt(argv[i + 1], 10);
      i += 1;
      continue;
    }
    if (token === '--max-time') {
      result.maxTimeSec = parseInt(argv[i + 1], 10);
      i += 1;
      continue;
    }
    if (token === '--allowedTools') {
      result.allowedTools = (argv[i + 1] || '').split(',').map((s) => s.trim());
      i += 1;
      continue;
    }
    if (token === '--disallowedTools') {
      result.disallowedTools = (argv[i + 1] || '').split(',').map((s) => s.trim());
      i += 1;
      continue;
    }
    if (token === '--verbose' || token === '-v') {
      result.verbose = true;
      continue;
    }
    if (token === '--debug' || token === '-d') {
      result.debug = true;
      continue;
    }
    if (token === '--lang' || token === '--language') {
      result.language = argv[i + 1] || null;
      i += 1;
      continue;
    }
    if (!result.prompt && !token.startsWith('-')) {
      result.prompt = token;
    }
  }
  return result;
}

export function getUsageText() {
  return `
Usage: upstage [command] [options] [prompt]

Commands:
  chat              Launch the fullscreen TUI (default — same as running
                    upstage with no command, and same as "tui")
  tui               Launch the fullscreen TUI (same as "chat" / no command)
  ask               One-shot prompt mode — run headlessly and exit, no TUI

  "chat", "tui", and running upstage with no command are three names for the
  same fullscreen-TUI entry point, not separate modes. "ask" (or passing a
  prompt/-p) is the only genuinely different, non-interactive mode.

Options:
  -h, --help                Show this help
  -p, --prompt <text>       Run prompt and exit
  -m, --model <model>       Model to use (default: solar-pro4)
  --no-stream               Disable streaming
  --session <id>            Resume session by ID
  --new-session             Start a new session
  --reset-session           Reset and create new session
  --confirm-patches         Require confirmation for patches
  --bridge-json             Output JSON bridge format
  --permission-mode <mode>  Permission mode
  --system-prompt <text>    Override system prompt
  --cwd <dir>               Run as if launched from this directory (changes
                            process cwd before anything else loads)
  --add-dir <dir>           Additional directory for UPSTAGE.md
  --max-turns <n>           Maximum conversation turns
  --max-time <sec>          Wall-time budget in seconds (default: 180)
  --allowedTools <tools>    Comma-separated allowed tools
  --disallowedTools <tools> Comma-separated denied tools
  --lang <code>             Language (ko/en)
  -v, --verbose             Verbose output
  -d, --debug               Debug mode

Examples:
  upstage                        Launch the fullscreen TUI
  upstage chat                   Same as above ("chat" = "tui" = no command)
  upstage tui                    Same as above
  upstage -p "Fix bug in app"    Run prompt and exit (no TUI)
  upstage ask "Read package.json"
  upstage --lang en -p "hello"   English mode
`.trim();
}
