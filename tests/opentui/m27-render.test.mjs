// OpenTUI's native renderer only works under Bun — lives under tests/opentui/
// so node's --test glob ("tests/*.test.mjs", non-recursive) skips it. Run via
// `npm run test:ui` (bun test).
import { test, expect } from "bun:test";
import React from "react";
import { testRender } from "@opentui/react/test-utils";
import { Composer } from "../../src/ui/components/Composer.mjs";
import { StatusBar } from "../../src/ui/components/StatusBar.mjs";
import { AutocompleteStrip } from "../../src/ui/components/AutocompleteStrip.mjs";
import { getAutocomplete } from "../../src/ui/composer-autocomplete.mjs";

const e = React.createElement;

async function renderFrame(node, opts = {}) {
  const { renderOnce, captureCharFrame, renderer } = await testRender(node, { width: 80, height: 10, ...opts });
  await renderOnce();
  const frame = captureCharFrame();
  renderer.destroy();
  return frame;
}

test("Composer renders the typed value and focus glyph", async () => {
  const frame = await renderFrame(e(Composer, { value: "fix the bug", isFocused: true, isDisabled: false, onChange: () => {}, onSend: () => {} }));
  expect(frame).toContain("fix the bug");
  expect(frame).toContain("✦");
});

test("StatusBar renders token count and cost deterministically", async () => {
  const frame = await renderFrame(e(StatusBar, {
    statusKey: "idle",
    tokenUsage: { total: 1234, cost: 0.0123 },
    approvalMode: "plan",
    systemWarning: "",
    language: "en"
  }));
  expect(frame).toContain("1,234");
  expect(frame).toContain("0.0123");
});

test("AutocompleteStrip renders nothing when inactive", async () => {
  const frame = await renderFrame(e(AutocompleteStrip, { autocomplete: null }));
  expect(frame.trim()).toBe("");
});

test("AutocompleteStrip lists slash-command suggestions with the accept hint", async () => {
  const commands = { "/compact": { description: "compact context" }, "/cost": { description: "show cost" }, "/clear": { description: "clear" } };
  const autocomplete = getAutocomplete("/c", { commands: Object.keys(commands).map((name) => ({ name })) });
  const frame = await renderFrame(e(AutocompleteStrip, { autocomplete, commands }));
  expect(frame).toContain("/compact");
  expect(frame).toContain("compact context");
  expect(frame).toContain("accept");
  expect(frame).toContain("change mode");
});
