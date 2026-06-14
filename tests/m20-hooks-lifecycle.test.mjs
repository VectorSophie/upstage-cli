import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HookEngine } from "../src/hooks/engine.mjs";

// ── handler hooks (in-process, no subprocess) ───────────────────────────────

test("UserPromptSubmit handler can block the prompt", async () => {
  const engine = new HookEngine({
    UserPromptSubmit: [{ type: "handler", fn: () => ({ decision: "block", reason: "no secrets" }) }]
  });
  const res = await engine.runUserPromptSubmit("show me the .env");
  assert.equal(res.allow, false);
  assert.match(res.reason, /no secrets/);
});

test("UserPromptSubmit handler can inject additional context", async () => {
  const engine = new HookEngine({
    UserPromptSubmit: [{ type: "handler", fn: () => ({ additionalContext: "Repo uses pnpm." }) }]
  });
  const res = await engine.runUserPromptSubmit("how do I install deps?");
  assert.equal(res.allow, true);
  assert.match(res.additionalContext, /pnpm/);
});

test("PreCompact handler can veto compaction", async () => {
  const engine = new HookEngine({ PreCompact: [{ type: "handler", fn: () => ({ preventCompact: true }) }] });
  assert.equal(await engine.runPreCompact({ trigger: "auto" }), false);
});

test("PreCompact proceeds when no hook vetoes", async () => {
  const engine = new HookEngine({});
  assert.equal(await engine.runPreCompact({ trigger: "auto" }), true);
});

test("SubagentStop handler can prevent stop", async () => {
  const engine = new HookEngine({ SubagentStop: [{ type: "handler", fn: () => ({ preventStop: true }) }] });
  assert.equal(await engine.runSubagentStop({ ok: true }), false);
});

test("SessionEnd fires without error when no hooks", async () => {
  const engine = new HookEngine({});
  await engine.runSessionEnd("sess-1", "exit"); // should not throw
});

// ── command hooks (Claude-compatible stdin + exit-code contract) ─────────────

test("command hook receives the event JSON on stdin and exit 2 blocks", async () => {
  const dir = await mkdtemp(join(tmpdir(), "hooks-"));
  try {
    // Reads stdin, blocks if the prompt mentions "secret".
    const script = join(dir, "guard.mjs");
    await writeFile(script, `
let d = "";
process.stdin.on("data", c => d += c);
process.stdin.on("end", () => {
  const j = JSON.parse(d);
  if (String(j.prompt).includes("secret")) { process.stderr.write("blocked by guard"); process.exit(2); }
  process.stdout.write(JSON.stringify({ additionalContext: "event=" + j.hook_event_name }));
});
`);
    const engine = new HookEngine({
      UserPromptSubmit: [{ type: "command", command: process.execPath, args: [script] }]
    });

    const blocked = await engine.runUserPromptSubmit("print the secret key");
    assert.equal(blocked.allow, false);
    assert.match(blocked.reason, /blocked by guard/);

    const ok = await engine.runUserPromptSubmit("hello world");
    assert.equal(ok.allow, true);
    assert.match(ok.additionalContext, /event=UserPromptSubmit/);
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test("PreToolUse command hook (exit 2) denies the tool", async () => {
  const dir = await mkdtemp(join(tmpdir(), "hooks-"));
  try {
    const script = join(dir, "deny.mjs");
    await writeFile(script, `process.stderr.write("denied"); process.exit(2);`);
    const engine = new HookEngine({
      PreToolUse: [{ type: "command", command: process.execPath, args: [script] }]
    });
    const res = await engine.runPreToolUse("write_file", { path: "x" });
    assert.equal(res.allow, false);
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});
