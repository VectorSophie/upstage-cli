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
  doctor: leaf(["doctor"]),
  init: leaf(["init"]),
  version: leaf(["version"]),
  update: leaf(["update"]),
  uninstall: leaf(["uninstall"]),
  migrate: leaf(["migrate"]),
  completion: namespace("completion", ["bash", "zsh", "fish", "powershell"]),

  config: namespace("config", ["list", "get", "set", "path", "edit"]),
  auth: namespace("auth", ["status", "test"]),
  models: namespace("models", ["list", "info"]),
  context: leaf(["context"]),

  mcp: namespace("mcp", ["list", "status", "test", "tools", "show", "add", "remove"]),
  tools: namespace("tools", ["list", "show"]),
  skills: namespace("skills", ["list", "show", "install"]),
  agents: namespace("agents", ["list", "show"]),
  plugins: namespace("plugins", ["list", "show", "install"]),
  sessions: namespace("sessions", ["list", "show", "resume", "export"]),

  parse: leaf(["parse"]),
  ocr: leaf(["ocr"]),
  extract: leaf(["extract"]),
  schema: leaf(["schema"]),
  classify: leaf(["classify"]),
  embed: leaf(["embed"]),
  groundedness: leaf(["groundedness"]),

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
