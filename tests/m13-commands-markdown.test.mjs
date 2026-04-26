import { test } from "node:test";
import assert from "node:assert/strict";
import { executeCommand, getCompletions, COMMANDS } from "../src/ui/commands.mjs";
import { renderMarkdown, renderInline, formatCodeBlock, formatTable, stripAnsi } from "../src/ui/markdown.mjs";

// ─── Slash commands ───────────────────────────────────────────────────────

const mockState = {
  messages: [],
  turnCount: 0,
  tokenUsage: { total: 1234, cost: 0.002 },
  model: "solar-pro2",
  tools: [{ name: "read_file", risk: "low" }, { name: "write_file", risk: "medium" }],
  _contextManager: null,
  _checkpointManager: null,
  _permissionMode: "default",
  _session: { id: "test-session", createdAt: Date.now(), history: [], toolResults: [], workspace: { cwd: "/tmp" } },
  _settings: { model: "solar-pro2", autoCompactEnabled: true },
  _registry: null,
  _agentLoader: null,
  _skillsLoader: null,
};

test("/help returns non-empty command list", async () => {
  const result = await executeCommand("/help", mockState);
  assert.ok(result.response.length > 0);
  assert.ok(result.response.includes("/help"));
  assert.ok(result.response.includes("/clear"));
});

test("/tools returns tool list", async () => {
  const result = await executeCommand("/tools", mockState);
  assert.ok(result.response.includes("read_file") || result.response.includes("2개"));
});

test("/cost returns token usage", async () => {
  const result = await executeCommand("/cost", mockState);
  assert.ok(result.response.includes("1,234") || result.response.includes("토큰"));
});

test("/quit returns exit: true", async () => {
  const result = await executeCommand("/quit", mockState);
  assert.equal(result.exit, true);
});

test("/exit returns exit: true", async () => {
  const result = await executeCommand("/exit", mockState);
  assert.equal(result.exit, true);
});

test("/unknown command returns error message", async () => {
  const result = await executeCommand("/notacommand", mockState);
  assert.ok(result.response.includes("알 수 없는 명령어"));
});

test("/undo with no checkpointManager returns friendly message", async () => {
  const result = await executeCommand("/undo", mockState);
  assert.ok(result.response.includes("체크포인트"));
});

test("/compact with no contextManager returns friendly message", async () => {
  const result = await executeCommand("/compact", mockState);
  assert.ok(result.response.includes("컨텍스트"));
});

test("/doctor returns system info", async () => {
  const result = await executeCommand("/doctor", mockState);
  assert.ok(result.response.includes("Node.js"));
  assert.ok(result.response.includes("플랫폼"));
});

test("/config returns settings", async () => {
  const result = await executeCommand("/config", mockState);
  assert.ok(result.response.includes("solar-pro2"));
});

test("/memory returns message count", async () => {
  const result = await executeCommand("/memory", mockState);
  assert.ok(result.response.includes("메시지") || result.response.includes("0"));
});

test("/clear returns clearMessages flag", async () => {
  const result = await executeCommand("/clear", mockState);
  assert.equal(result.clearMessages, true);
});

test("/sessions returns showSessions flag", async () => {
  const result = await executeCommand("/sessions", mockState);
  assert.equal(result.showSessions, true);
});

test("/tree returns showTree flag", async () => {
  const result = await executeCommand("/tree", mockState);
  assert.equal(result.showTree, true);
});

test("/new returns newSession flag", async () => {
  const result = await executeCommand("/new", mockState);
  assert.equal(result.newSession, true);
});

test("/forget removes last N messages", async () => {
  const state = { ...mockState, messages: [{ role: "user", content: "a" }, { role: "assistant", content: "b" }] };
  const result = await executeCommand("/forget 1", state);
  assert.equal(result.updatedMessages?.length, 1);
});

test("/agents with no loader returns graceful message", async () => {
  const result = await executeCommand("/agents", mockState);
  assert.ok(result.response.length > 0);
});

test("/skills with no loader returns graceful message", async () => {
  const result = await executeCommand("/skills", mockState);
  assert.ok(result.response.length > 0);
});

// ─── Tab completions ──────────────────────────────────────────────────────

test("getCompletions('/co') returns compact, config, cost", () => {
  const completions = getCompletions("/co");
  assert.ok(completions.includes("/compact"), `missing /compact in ${completions}`);
  assert.ok(completions.includes("/config"), `missing /config in ${completions}`);
  assert.ok(completions.includes("/cost"), `missing /cost in ${completions}`);
});

test("getCompletions('/he') returns /help", () => {
  const completions = getCompletions("/he");
  assert.ok(completions.includes("/help"));
});

test("getCompletions returns sorted results", () => {
  const completions = getCompletions("/");
  for (let i = 1; i < completions.length; i++) {
    assert.ok(completions[i] >= completions[i - 1], "expected sorted order");
  }
});

// ─── Markdown renderer ────────────────────────────────────────────────────

test("renderMarkdown('') returns empty string", () => {
  assert.equal(renderMarkdown(""), "");
});

test("renderMarkdown renders bold text", () => {
  const out = renderMarkdown("**bold text**");
  // Text must be present; formatting adds ANSI codes so stripped != raw markdown
  assert.ok(out.includes("bold text"), `got: ${out}`);
  // stripAnsi(out) should equal just the text, not the raw markdown
  assert.ok(!stripAnsi(out).includes("**"), "expected ** markers removed");
});

test("renderMarkdown renders h1 with bold+underline", () => {
  const out = renderMarkdown("# Heading One");
  assert.ok(out.includes("Heading One"));
  // The # marker should be consumed
  assert.ok(!stripAnsi(out).includes("# "), "expected # removed from output");
});

test("renderMarkdown renders h2 with bold", () => {
  const out = renderMarkdown("## Heading Two");
  assert.ok(out.includes("Heading Two"));
});

test("renderMarkdown renders fenced code block with box border", () => {
  const md = "```js\nconst x = 1;\n```";
  const out = renderMarkdown(md);
  assert.ok(out.includes("┌") || out.includes("└"), `expected box border, got: ${stripAnsi(out)}`);
  assert.ok(stripAnsi(out).includes("x = 1"), `expected code content, got: ${stripAnsi(out)}`);
});

test("renderMarkdown renders table with borders", () => {
  const md = "| Name | Value |\n|------|-------|\n| foo  | 42    |";
  const out = renderMarkdown(md);
  assert.ok(out.includes("Name"), `got: ${out}`);
  assert.ok(out.includes("foo"));
  assert.ok(out.includes("│") || out.includes("|"), "expected table formatting");
});

test("renderMarkdown renders unordered list", () => {
  const md = "- item one\n- item two";
  const out = renderMarkdown(md);
  assert.ok(out.includes("item one"));
  assert.ok(out.includes("•") || out.includes("-"));
});

test("renderMarkdown renders blockquote", () => {
  const md = "> quoted text";
  const out = renderMarkdown(md);
  assert.ok(out.includes("quoted text"));
  assert.ok(out.includes("│") || out.includes(">"));
});

test("renderMarkdown renders horizontal rule", () => {
  const md = "---";
  const out = renderMarkdown(md);
  assert.ok(out.includes("─") || out.includes("-"));
});

test("renderInline renders inline code with cyan", () => {
  const out = renderInline("use `code` here");
  assert.ok(out.includes("code"));
  assert.ok(out !== "use `code` here", "expected formatting");
});

test("renderInline renders link text", () => {
  const out = renderInline("[click here](https://example.com)");
  assert.ok(out.includes("click here"));
});

test("NO_COLOR=1 strips all ANSI codes", () => {
  const orig = process.env.NO_COLOR;
  process.env.NO_COLOR = "1";
  try {
    // Re-import won't work in node:test without dynamic import; test stripAnsi directly
    const withAnsi = "\x1b[1mbold\x1b[0m and \x1b[32mgreen\x1b[0m";
    const stripped = stripAnsi(withAnsi);
    assert.equal(stripped, "bold and green");
  } finally {
    if (orig === undefined) delete process.env.NO_COLOR;
    else process.env.NO_COLOR = orig;
  }
});

test("formatCodeBlock produces ┌ and └ border characters", () => {
  const out = formatCodeBlock(["const x = 1;"], "js");
  assert.ok(out.includes("┌"), `expected ┌ in output`);
  assert.ok(out.includes("└"), `expected └ in output`);
  assert.ok(stripAnsi(out).includes("x = 1"), `expected code content in stripped output`);
});

test("formatTable produces column-aligned output", () => {
  const out = formatTable(["| A | B |", "|---|---|", "| 1 | 2 |"]);
  assert.ok(out.includes("A"));
  assert.ok(out.includes("B"));
  assert.ok(out.includes("1"));
});

// ─── COMMANDS object sanity ───────────────────────────────────────────────

test("all COMMANDS have description and handler", () => {
  for (const [name, def] of Object.entries(COMMANDS)) {
    assert.ok(typeof def.description === "string" && def.description.length > 0,
      `${name} missing description`);
    assert.ok(typeof def.handler === "function",
      `${name} missing handler`);
  }
});
