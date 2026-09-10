// CLI command router for namespaced commands added in 3.2.0 (see §6 of
// docs/superpowers/plans/2026-09-04-3.2.0-release-plan.md, Task 12.1).
//
// This is a small internal router, not a parsing dependency (no yargs/commander/
// etc.) — per the plan's architectural review (§W) and this codebase's existing
// zero-CLI-dependency, zero-build-step convention. It must keep working inside a
// `bun build --compile` standalone binary, so it does no dynamic filesystem
// discovery of commands; the table below is the single source of truth.
//
// `chat`/`ask`/`tui` are NOT registered here — they remain handled by
// `src/config/cli-args.mjs`'s `parseCliArgs()` exactly as before. This router
// only owns the *new* top-level command names from §6 of the plan.
//
// Contract: a nested `{ [name]: { handler } | { subcommands: { ... } } }` table.
// `dispatch(argv)` walks the table by consuming leading tokens that match a
// subcommand name, then calls the resulting leaf's handler with the remaining
// argv and returns its exit code. `-h`/`--help` at any depth short-circuits with
// that level's usage text (exit 0). An unmatched namespace (no handler, no
// matching next token) prints usage to stderr and returns exit code 2 (usage
// error, per the plan's §6 exit-code table).
//
// Every leaf below is currently a stub — the real logic for each ships in its
// own later plan task (see the per-command comments). This task's job is only
// to make every command name in §6's tree resolve to *a* registered handler.
//
// Known tradeoff (documented per the task's failure-modes section, not solved
// here): a top-level token is treated as a command purely by exact string
// match against this table, with no natural-language heuristic — so a literal
// prompt that happens to start with a registered word (e.g. "doctor, what is
// this bug?" as a single argv token would not collide, but `upstage doctor "..."`
// as separate tokens would be routed as the `doctor` command). `chat`/`ask`/`tui`
// already have this exact property today via `parseCliArgs`, and it has not been
// a reported problem, so the same tradeoff is accepted here rather than solved.

import { runDoctorCommand } from "./commands/doctor.mjs";
import { runInitCommand } from "./commands/init.mjs";
import { runParseCommand } from "./commands/parse.mjs";
import { runOcrCommand } from "./commands/ocr.mjs";
import { runExtractCommand } from "./commands/extract.mjs";
import { runSchemaCommand } from "./commands/schema.mjs";
import { runClassifyCommand } from "./commands/classify.mjs";
import { runEmbedCommand } from "./commands/embed.mjs";
import { runGroundednessCommand } from "./commands/groundedness.mjs";
import { runSkillsInstallCommand } from "./commands/skills-install.mjs";
import { runSkillsListCommand, runSkillsShowCommand } from "./commands/skills.mjs";
import { runToolsListCommand, runToolsShowCommand } from "./commands/tools.mjs";
import { runAgentsListCommand, runAgentsShowCommand } from "./commands/agents.mjs";
import { runPluginsListCommand, runPluginsShowCommand } from "./commands/plugins.mjs";
import {
  runMcpListCommand,
  runMcpStatusCommand,
  runMcpTestCommand,
  runMcpToolsCommand,
  runMcpShowCommand
} from "./commands/mcp.mjs";
import {
  runSessionsListCommand,
  runSessionsShowCommand,
  runSessionsResumeCommand,
  runSessionsExportCommand
} from "./commands/sessions.mjs";
import {
  runConfigListCommand,
  runConfigGetCommand,
  runConfigSetCommand,
  runConfigPathCommand,
  runConfigEditCommand
} from "./commands/config.mjs";
import { runAuthStatusCommand, runAuthTestCommand } from "./commands/auth.mjs";
import { runModelsListCommand, runModelsInfoCommand } from "./commands/models.mjs";
import { runVersionCommand } from "./commands/version.mjs";
import { runUpdateCommand } from "./commands/update.mjs";
import { runUninstallCommand } from "./commands/uninstall.mjs";

function stubHandler(path) {
  const name = `upstage ${path.join(" ")}`;
  return async function handler(rest) {
    if (rest.includes("-h") || rest.includes("--help")) {
      process.stdout.write(`${formatUsage(path, lookupNode(path))}\n`);
      return 0;
    }
    process.stderr.write(`${name}: not yet implemented\n`);
    return 1;
  };
}

// Build a leaf command node (no subcommands).
function leaf(path) {
  return { handler: stubHandler(path) };
}

// Build a namespace node from a list of subcommand names, each a leaf.
function namespace(name, subNames) {
  const subcommands = {};
  for (const sub of subNames) {
    subcommands[sub] = leaf([name, sub]);
  }
  return { subcommands };
}

export const COMMANDS = {
  // Task 12.3 — real implementation (src/cli/commands/doctor.mjs), not a
  // stub. `runDoctorCommand` itself handles -h/--help, so it's wired
  // directly as the leaf's handler rather than going through `leaf()`.
  doctor: {
    handler: runDoctorCommand,
    usage: [
      "Usage: upstage doctor [options]",
      "",
      "  Runs a read-only diagnostic sweep (Core/Upstage/Project/Extensions/Security/Verification).",
      "  Individual checks may report warn/fail — this never affects the command's own exit code.",
      "",
      "Options:",
      "  --json    Output as JSON"
    ].join("\n")
  },
  // Task 7.10 — real implementation (src/cli/commands/init.mjs), not a
  // stub. `runInitCommand` handles -h/--help itself, so it's wired directly
  // as the leaf's handler, same pattern as `doctor` above (Task 12.3).
  init: {
    handler: runInitCommand,
    usage: [
      "Usage: upstage init [--refresh] [--dry-run]",
      "",
      "  Generates/updates a marked block in UPSTAGE.md from static analysis of the",
      "  current project (Architecture/Entry Points/Important Directories/",
      "  Build/Test/Lint/Typecheck/Runtime & Frameworks). Content outside the",
      "  generated-block markers is always preserved.",
      "",
      "Options:",
      "  --refresh    Force regeneration (no-op alias of the default)",
      "  --dry-run    Print the would-be content without writing to disk"
    ].join("\n")
  },
  // Task 12.9 — real implementation (src/cli/commands/version.mjs). Handles
  // its own -h/--help, wired directly like `doctor`/`init` above.
  version: {
    handler: runVersionCommand,
    usage: [
      "Usage: upstage version [--verbose] [--json]",
      "",
      "  Prints `upstage-cli <version>` (from package.json) by default.",
      "  --verbose adds commit hash, build date, install type, runtime, and platform.",
      "",
      "Options:",
      "  --verbose   Include commit/build/install-type/runtime/platform detail",
      "  --json      Output as JSON"
    ].join("\n")
  },
  // Task 12.9 — real implementation (src/cli/commands/update.mjs).
  update: {
    handler: runUpdateCommand,
    usage: [
      "Usage: upstage update [--check]",
      "",
      "  --check reports whether a newer GitHub release exists (one network call),",
      "  without installing anything. Without --check, behavior depends on install",
      "  type: a standalone binary self-updates in place; an npm install or",
      "  development checkout instead prints guidance and does nothing."
    ].join("\n")
  },
  // Task 7.20 — real implementation (src/cli/commands/uninstall.mjs).
  uninstall: {
    handler: runUninstallCommand,
    usage: [
      "Usage: upstage uninstall [--purge] [-y|--yes]",
      "",
      "  Removes upstage-cli. Default scope depends on how it was installed and",
      "  NEVER touches ~/.upstage/ (settings) or ~/.upstage-cli/sessions/.",
      "",
      "Options:",
      "  --purge      Additionally remove ~/.upstage/ and ~/.upstage-cli/sessions/",
      "  -y, --yes    Skip the interactive confirmation prompt"
    ].join("\n")
  },
  migrate: leaf(["migrate"]),
  completion: namespace("completion", ["bash", "zsh", "fish", "powershell"]),

  // Task 12.7 — real implementations (src/cli/commands/config.mjs). Each
  // handler manages its own -h/--help, wired directly like `doctor`/`mcp`
  // above rather than through `namespace()`.
  config: {
    subcommands: {
      list: {
        handler: runConfigListCommand,
        usage: [
          "Usage: upstage config list [--effective] [--json]",
          "",
          "  Lists every top-level settings key and its effective value. With",
          "  --effective, adds a SOURCE column naming which cascade layer last set",
          "  it: 'default' | 'global settings' | 'project settings' |",
          "  'project local settings' | 'env'.",
          "",
          "Options:",
          "  --effective   Show the SOURCE column",
          "  --json        Output as JSON: [{key, value}] or [{key, value, source}]"
        ].join("\n")
      },
      get: {
        handler: runConfigGetCommand,
        usage: [
          "Usage: upstage config get <key> [--json]",
          "",
          "  Prints one settings value by dot-path key (e.g.",
          "  `permissions.defaultMode`), read from the project settings file",
          "  (<cwd>/.upstage/settings.json) only — the same file `config set`",
          "  writes to. NEVER reads the global or project-local settings files,",
          "  or env overrides. If the key is not set in project settings, exits 1",
          "  with a message pointing at `config list` for the merged/resolved",
          "  view with provenance.",
          "",
          "Options:",
          "  --json   Output as JSON: {key, value, path}"
        ].join("\n")
      },
      set: {
        handler: runConfigSetCommand,
        usage: [
          "Usage: upstage config set <key> <value> [--json]",
          "",
          "  Sets one dot-path key in <cwd>/.upstage/settings.json (the project",
          "  settings file). NEVER writes to the global or project-local settings",
          "  files.",
          "",
          "Options:",
          "  --json   Output as JSON: {key, value, path}"
        ].join("\n")
      },
      path: {
        handler: runConfigPathCommand,
        usage: [
          "Usage: upstage config path",
          "",
          "  Prints the resolved path to the active project's settings file."
        ].join("\n")
      },
      edit: {
        handler: runConfigEditCommand,
        usage: [
          "Usage: upstage config edit",
          "",
          "  Opens $EDITOR on <cwd>/.upstage/settings.json (creating it with `{}`",
          "  first if it doesn't exist yet)."
        ].join("\n")
      }
    }
  },
  // Task 12.8 — real implementations (src/cli/commands/auth.mjs). Each
  // handler manages its own -h/--help, wired directly like `config` above.
  auth: {
    subcommands: {
      status: {
        handler: runAuthStatusCommand,
        usage: [
          "Usage: upstage auth status [--json]",
          "",
          "  Prints, per provider: Source (which env var is set), Key",
          "  (configured/not configured — never the value), and which provider is",
          "  active. For the active provider only, performs one lightweight live",
          "  reachability call (Upstage only — other providers report",
          "  'not checked').",
          "",
          "Options:",
          "  --json   Output as JSON"
        ].join("\n")
      },
      test: {
        handler: runAuthTestCommand,
        usage: [
          "Usage: upstage auth test <provider> [--json]",
          "",
          "  Forces the live reachability check for one named provider, regardless",
          "  of which is currently active. Only 'upstage' has a real live check in",
          "  this build.",
          "",
          "Options:",
          "  --json   Output as JSON"
        ].join("\n")
      }
    }
  },
  // Task 7.16 — real implementations (src/cli/commands/models.mjs). Each
  // handler manages its own -h/--help, wired directly like `doctor`/`mcp`
  // above rather than through `namespace()`.
  models: {
    subcommands: {
      list: {
        handler: runModelsListCommand,
        usage: [
          "Usage: upstage models list [--json]",
          "",
          "  Lists every model this build has real capability data for, with context",
          "  limit and support flags for reasoning-effort/parallel-tool-calls/",
          "  response-format.",
          "",
          "Options:",
          "  --json   Output as JSON: [{id, provider, contextLimit,",
          "           supportsReasoningEffort, supportsParallelToolCalls,",
          "           supportsResponseFormat, isDefault}]"
        ].join("\n")
      },
      info: {
        handler: runModelsInfoCommand,
        usage: [
          "Usage: upstage models info <model> [--json]",
          "",
          "  Prints one model's capability row (same data/format `/model` shows in",
          "  the TUI for the active model).",
          "",
          "Options:",
          "  --json   Output as JSON"
        ].join("\n")
      }
    }
  },
  context: leaf(["context"]),

  // Task 12.4 — real implementations (src/cli/commands/mcp.mjs) for
  // list/status/test/tools/show, not stubs. Each handler manages its own
  // -h/--help, so it's wired directly (same pattern as `doctor`/`init`
  // above) rather than through `leaf()`. `add`/`remove` remain stubs —
  // out of this task's scope.
  mcp: {
    subcommands: {
      list: {
        handler: runMcpListCommand,
        usage: [
          "Usage: upstage mcp list [--json]",
          "",
          "  Lists every configured MCP server with its transport, connection status,",
          "  and tool count. A server that fails to connect is shown with",
          "  STATUS=failed, TOOLS=- and does NOT abort the listing.",
          "",
          "Options:",
          "  --json   Output as JSON: [{name, transport, status, toolCount}]"
        ].join("\n")
      },
      status: {
        handler: runMcpStatusCommand,
        usage: [
          "Usage: upstage mcp status [--json]",
          "",
          "  A narrower, single-line-per-server summary of MCP server connectivity",
          "  (name + connected/failed only).",
          "",
          "Options:",
          "  --json   Output as JSON: [{name, status}]"
        ].join("\n")
      },
      test: {
        handler: runMcpTestCommand,
        usage: [
          "Usage: upstage mcp test [<name>] [--json]",
          "",
          "  Re-attempts connection for one named MCP server, or all configured",
          "  servers if <name> is omitted. Reports pass/fail with the actual",
          "  connection error for any failure.",
          "",
          "Options:",
          "  --json   Output as JSON: [{name, transport, status, error}]"
        ].join("\n")
      },
      tools: {
        handler: runMcpToolsCommand,
        usage: [
          "Usage: upstage mcp tools <name> [--json]",
          "",
          "  Connects to one named MCP server and lists its tools (name +",
          "  description + count).",
          "",
          "Options:",
          "  --json   Output as JSON: {server, toolCount, tools: [{name, description}]}"
        ].join("\n")
      },
      show: {
        handler: runMcpShowCommand,
        usage: [
          "Usage: upstage mcp show <name> [--json]",
          "",
          "  Prints one server's configuration with env/header VALUES redacted to",
          "  key-presence only. The actual secret value is never printed.",
          "",
          "Options:",
          "  --json   Output as JSON (same redaction applies)"
        ].join("\n")
      },
      add: leaf(["mcp", "add"]),
      remove: leaf(["mcp", "remove"])
    }
  },
  // Task 12.5 — real implementations (src/cli/commands/tools.mjs). Each
  // handler manages its own -h/--help, wired directly like `doctor`/`mcp`
  // above rather than through `namespace()`.
  tools: {
    subcommands: {
      list: {
        handler: runToolsListCommand,
        usage: [
          "Usage: upstage tools list [--json]",
          "",
          "  Lists every registered tool (builtin + connected MCP servers + discovered",
          "  tools), grouped and sorted by source.",
          "",
          "Options:",
          "  --json   Output as JSON: [{name, source, risk, description}]"
        ].join("\n")
      },
      show: {
        handler: runToolsShowCommand,
        usage: [
          "Usage: upstage tools show <name> [--json]",
          "",
          "  Prints one tool's full schema/description/source.",
          "",
          "Options:",
          "  --json   Output as JSON"
        ].join("\n")
      }
    }
  },
  // `list`/`show` are Task 12.5's real implementations (src/cli/commands/
  // skills.mjs — a NEW file alongside skills-install.mjs rather than a
  // rename; see skills.mjs's header for why); `install` is Task 7.9's real
  // implementation (src/cli/commands/skills-install.mjs), wired directly the
  // same way `parse`/`ocr`/etc. above are.
  skills: {
    subcommands: {
      list: {
        handler: runSkillsListCommand,
        usage: [
          "Usage: upstage skills list [--json]",
          "",
          "  Lists every skill found (.upstage/skills/, .claude/skills/, the",
          "  package-bundled pack, and the home directory).",
          "",
          "Options:",
          "  --json   Output as JSON: [{name, description, aliases, license}]"
        ].join("\n")
      },
      show: {
        handler: runSkillsShowCommand,
        usage: [
          "Usage: upstage skills show <name> [--json]",
          "",
          "  Prints one skill's full detail (description/aliases/license/prompt).",
          "",
          "Options:",
          "  --json   Output as JSON"
        ].join("\n")
      },
      install: {
        handler: runSkillsInstallCommand,
        usage: [
          "Usage: upstage skills install [--target claude|upstage] [--json]",
          "",
          "  Installs the first-party `upstage-utilities` skill into on-disk skill",
          "  director(y/ies) — by default both .upstage/skills/ and .claude/skills/.",
          "",
          "Options:",
          "  --target <name>   Install to only this target (claude|upstage) instead",
          "                    of the default pair",
          "  --json            Output a machine-readable summary as JSON"
        ].join("\n")
      }
    }
  },
  // Task 12.5 — real implementations (src/cli/commands/agents.mjs).
  agents: {
    subcommands: {
      list: {
        handler: runAgentsListCommand,
        usage: [
          "Usage: upstage agents list [--json]",
          "",
          "  Lists every agent definition found under .upstage/agents/ (project and",
          "  home directory).",
          "",
          "Options:",
          "  --json   Output as JSON: [{name, description, model, tools}]"
        ].join("\n")
      },
      show: {
        handler: runAgentsShowCommand,
        usage: [
          "Usage: upstage agents show <name> [--json]",
          "",
          "  Prints one agent definition's full detail (description/model/tools/prompt).",
          "",
          "Options:",
          "  --json   Output as JSON"
        ].join("\n")
      }
    }
  },
  // `list`/`show` are Task 12.5's real implementations
  // (src/cli/commands/plugins.mjs); `install` remains a stub — out of scope
  // (no CRUD for plugins per the plan).
  plugins: {
    subcommands: {
      list: {
        handler: runPluginsListCommand,
        usage: [
          "Usage: upstage plugins list [--json]",
          "",
          "  Lists every discovered plugin (.claude/plugins/, .upstage/plugins/,",
          "  project and home directory).",
          "",
          "Options:",
          "  --json   Output as JSON: [{name, version}]"
        ].join("\n")
      },
      show: {
        handler: runPluginsShowCommand,
        usage: [
          "Usage: upstage plugins show <name> [--json]",
          "",
          "  Prints one plugin's version, install directory, and the slash commands",
          "  it contributes.",
          "",
          "Options:",
          "  --json   Output as JSON"
        ].join("\n")
      },
      install: leaf(["plugins", "install"])
    }
  },
  // Task 12.6 — real implementations (src/cli/commands/sessions.mjs), folded
  // together with Task 7.13's export-formatting logic per the plan's own
  // "or folded into Task 12.6's sessions.mjs" note. Each handler manages its
  // own -h/--help, wired directly like `doctor`/`mcp` above.
  sessions: {
    subcommands: {
      list: {
        handler: runSessionsListCommand,
        usage: [
          "Usage: upstage sessions list [--json]",
          "",
          "  Lists every stored session (~/.upstage-cli/sessions/), newest first.",
          "",
          "Options:",
          "  --json   Output as JSON: [{id, updatedAt, workspace, parentSessionId}]"
        ].join("\n")
      },
      show: {
        handler: runSessionsShowCommand,
        usage: [
          "Usage: upstage sessions show <id> [--json]",
          "",
          "  Prints one session's summary (timestamps, workspace, entry counts) —",
          "  not a full dump. Use `upstage sessions export <id>` for that.",
          "",
          "Options:",
          "  --json   Output as JSON"
        ].join("\n")
      },
      resume: {
        handler: runSessionsResumeCommand,
        usage: [
          "Usage: upstage sessions resume <id>",
          "",
          "  Resumes a stored session — the SAME code path as running",
          "  `upstage --session <id>` directly, not a reimplementation of it.",
          "  Launches the interactive TUI (or a one-shot prompt, if -p/--prompt",
          "  is also forwarded) exactly as that flow would.",
          "",
          "  Any extra flags after <id> are forwarded verbatim."
        ].join("\n")
      },
      export: {
        handler: runSessionsExportCommand,
        usage: [
          "Usage: upstage sessions export <id> [--format md|json|jsonl] [--include-tool-io]",
          "",
          "  Formats a stored session as a transcript. `json` is the (redacted)",
          "  session object as-is; `jsonl` is one line per history/runtimeEvents",
          "  entry; `md` (the default) is a human-readable transcript.",
          "",
          "  By default, raw write_file/edit_file file bodies are elided to a",
          "  diff-stat-only summary. Pass --include-tool-io to include them.",
          "",
          "Options:",
          "  --format <fmt>      md (default) | json | jsonl",
          "  --include-tool-io   Include raw write_file/edit_file bodies unredacted"
        ].join("\n")
      }
    }
  },

  // Task 7.8 — real implementations (src/cli/commands/*.mjs), not stubs.
  // Each handler manages its own -h/--help, so it's wired directly (same
  // pattern as `doctor`/`init` above) rather than through `leaf()`.
  parse: {
    handler: runParseCommand,
    usage: [
      "Usage: upstage parse <file> [--format md|html|text] [--mode standard|enhanced|auto] [--ocr auto|force] [--json]",
      "",
      "  Parses a document (PDF/image) into structured layout elements via Upstage's Document Parse model.",
      "",
      "Options:",
      "  --format   Output content format (default: md)",
      "  --mode     Parse mode (default: standard)",
      "  --ocr      OCR behavior (default: auto)",
      "  --json     Output the raw result as JSON"
    ].join("\n")
  },
  ocr: {
    handler: runOcrCommand,
    usage: [
      "Usage: upstage ocr <file> [--json]",
      "",
      "  Runs OCR-only digitization on a document (PDF/image) via Upstage's dedicated OCR model.",
      "",
      "Options:",
      "  --json     Output the raw result as JSON"
    ].join("\n")
  },
  extract: {
    handler: runExtractCommand,
    usage: [
      "Usage: upstage extract <file> --schema <json|@file> [--json]",
      "",
      "  Extracts structured data from a document matching a JSON Schema, via Upstage's",
      "  Universal Extraction model.",
      "",
      "Options:",
      "  --schema   Required. Inline JSON Schema text, or @path/to/schema.json.",
      "  --json     Output the raw result as JSON"
    ].join("\n")
  },
  schema: {
    handler: runSchemaCommand,
    usage: [
      "Usage: upstage schema <files...> [--json]",
      "",
      "  Generates a JSON Schema from 1 to 3 sample documents, via Upstage's schema-generation model.",
      "",
      "Options:",
      "  --json     Output the raw result as JSON"
    ].join("\n")
  },
  classify: {
    handler: runClassifyCommand,
    usage: [
      "Usage: upstage classify <file> --categories <a,b,c> [--json]",
      "",
      "  Classifies a document into one of a caller-supplied set of categories, via",
      "  Upstage's Document Classification model.",
      "",
      "Options:",
      "  --categories   Required. Comma-separated candidate labels (2 to 1000).",
      "  --json         Output the raw result as JSON"
    ].join("\n")
  },
  embed: {
    handler: runEmbedCommand,
    usage: [
      "Usage: upstage embed <text> [--type query|passage] [--json]",
      "",
      "  Embeds a single text via Upstage's Solar embeddings.",
      "",
      "Options:",
      "  --type   query|passage (default: query)",
      "  --json   Output the raw result as JSON"
    ].join("\n")
  },
  groundedness: {
    handler: runGroundednessCommand,
    usage: [
      "Usage: upstage groundedness --context <text|@file> --answer <text|@file> [--json]",
      "",
      "  Verifies that an answer/claim is supported by its source context, via Upstage's",
      "  Groundedness Check.",
      "",
      "Options:",
      "  --context   Required. Inline text, or @path/to/context.txt.",
      "  --answer    Required. Inline text, or @path/to/answer.txt.",
      "  --json      Output the raw result as JSON"
    ].join("\n")
  },

  acp: leaf(["acp"])
};

function lookupNode(path) {
  let node = { subcommands: COMMANDS };
  for (const segment of path) {
    node = node.subcommands?.[segment];
    if (!node) return null;
  }
  return node;
}

function formatUsage(path, node) {
  const prefix = path.length > 0 ? `upstage ${path.join(" ")}` : "upstage";
  if (node?.subcommands) {
    const names = Object.keys(node.subcommands).sort();
    return [
      `Usage: ${prefix} <subcommand>`,
      "",
      "Subcommands:",
      ...names.map((n) => `  ${n}`)
    ].join("\n");
  }
  // A leaf that has a real implementation (not `stubHandler`) can carry its
  // own `usage` string so router-level `-h`/`--help` interception (which
  // fires before the handler itself ever runs, see `dispatch()` below)
  // doesn't print the generic "(not yet implemented)" placeholder for a
  // command that's actually implemented.
  if (typeof node?.usage === "string") {
    return node.usage;
  }
  return `Usage: ${prefix} [options]\n\n  (not yet implemented)`;
}

/** True if `name` (argv[0]) is a top-level command name owned by this router. */
export function isRouterCommand(name) {
  return typeof name === "string" && Object.prototype.hasOwnProperty.call(COMMANDS, name);
}

/**
 * Dispatch argv to the matching handler in the command table, descending
 * through subcommand tokens as far as they match. Returns an exit code.
 */
export async function dispatch(argv) {
  let node = { subcommands: COMMANDS };
  const path = [];
  let i = 0;

  while (i < argv.length) {
    const token = argv[i];
    if (token === "-h" || token === "--help") {
      process.stdout.write(`${formatUsage(path, node)}\n`);
      return 0;
    }
    if (node.subcommands && Object.prototype.hasOwnProperty.call(node.subcommands, token)) {
      node = node.subcommands[token];
      path.push(token);
      i += 1;
      continue;
    }
    break;
  }

  if (typeof node.handler === "function") {
    return await node.handler(argv.slice(i), { path });
  }

  process.stderr.write(`${formatUsage(path, node)}\n`);
  return 2;
}
