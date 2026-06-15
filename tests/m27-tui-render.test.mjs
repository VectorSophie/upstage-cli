import { test } from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { render } from "ink-testing-library";
import { Composer } from "../src/ui/components/Composer.mjs";
import { StatusBar } from "../src/ui/components/StatusBar.mjs";
import { AutocompleteStrip } from "../src/ui/components/AutocompleteStrip.mjs";
import { getAutocomplete } from "../src/ui/composer-autocomplete.mjs";

const e = React.createElement;

test("Composer renders the typed value and focus glyph", () => {
  const { lastFrame } = render(e(Composer, { value: "fix the bug", isFocused: true, isDisabled: false, onChange: () => {}, onSend: () => {} }));
  const frame = lastFrame();
  assert.match(frame, /fix the bug/);
  assert.match(frame, /✦/);
});

test("StatusBar renders token count and cost deterministically", () => {
  const { lastFrame } = render(e(StatusBar, {
    statusKey: "idle",
    tokenUsage: { total: 1234, cost: 0.0123 },
    approvalMode: "plan",
    systemWarning: "",
    language: "en"
  }));
  const frame = lastFrame();
  assert.match(frame, /1,234/);
  assert.match(frame, /0\.0123/);
});

test("AutocompleteStrip renders nothing when inactive", () => {
  const { lastFrame } = render(e(AutocompleteStrip, { autocomplete: null }));
  assert.equal(lastFrame().trim(), "");
});

test("AutocompleteStrip lists slash-command suggestions with the accept hint", () => {
  const commands = { "/compact": { description: "compact context" }, "/cost": { description: "show cost" }, "/clear": { description: "clear" } };
  const autocomplete = getAutocomplete("/c", { commands: Object.keys(commands).map((name) => ({ name })) });
  const { lastFrame } = render(e(AutocompleteStrip, { autocomplete, commands }));
  const frame = lastFrame();
  assert.match(frame, /\/compact/);
  assert.match(frame, /compact context/);
  assert.match(frame, /accept/);
  assert.match(frame, /change mode/);
});
