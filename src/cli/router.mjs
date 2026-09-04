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
import {
  runMcpListCommand,
  runMcpStatusCommand,
  runMcpTestCommand,
  runMcpToolsCommand,
  runMcpShowCommand
} from "./commands/mcp.mjs";

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
  version: leaf(["version"]),
  update: leaf(["update"]),
  uninstall: leaf(["uninstall"]),
  migrate: leaf(["migrate"]),
  completion: namespace("completion", ["bash", "zsh", "fish", "powershell"]),

  config: namespace("config", ["list", "get", "set", "path", "edit"]),
  auth: namespace("auth", ["status", "test"]),
  models: namespace("models", ["list", "info"]),
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
  tools: namespace("tools", ["list", "show"]),
  // `list`/`show` remain stubs; `install` is Task 7.9's real implementation
  // (src/cli/commands/skills-install.mjs), wired directly the same way
  // `parse`/`ocr`/etc. above are (its own -h/--help handling, own usage
  // string), rather than through the generic `namespace()`/`leaf()` helpers.
  skills: {
    subcommands: {
      list: leaf(["skills", "list"]),
      show: leaf(["skills", "show"]),
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
  agents: namespace("agents", ["list", "show"]),
  plugins: namespace("plugins", ["list", "show", "install"]),
  sessions: namespace("sessions", ["list", "show", "resume", "export"]),

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
