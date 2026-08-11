import { test } from "node:test";
import assert from "node:assert/strict";
import chalk from "chalk";
import { renderMarkdown } from "../src/ui/markdown.mjs";

chalk.level = 3;

// OpenTUI's own text-wrap splits on raw byte offsets and can slice an SGR
// escape sequence in half (found via live testing — see plan addendum).
// renderMarkdown must hand back lines that already fit `width`, each with
// balanced/complete ANSI codes, so nothing downstream ever has to wrap them.
test("renderMarkdown wraps long lines to the given width without truncating text", () => {
  const long = "a".repeat(200);
  const lines = renderMarkdown(long, 40);
  assert.ok(lines.length > 1, "expected the long line to wrap into multiple lines");
  for (const line of lines) {
    assert.ok(line.length <= 40, `line exceeds width: "${line}"`);
  }
  assert.equal(lines.join("").length, 200, "no characters should be lost by wrapping");
});

test("renderMarkdown never emits a line with an unbalanced ANSI escape sequence", () => {
  const md = `**${"bold ".repeat(30)}** and some \`inline code\` plus *italic ${"text ".repeat(20)}*`;
  const lines = renderMarkdown(md, 30);
  for (const line of lines) {
    // eslint-disable-next-line no-control-regex
    const opens = (line.match(/\x1b\[[0-9;]*m/g) || []).length;
    assert.ok(opens >= 0, "sanity: regex ran");
    // A corrupted split leaves a bare, incomplete CSI parameter list with no
    // terminating 'm' before the line ends — assert none of the escape
    // introducers are left dangling.
    // eslint-disable-next-line no-control-regex
    const dangling = line.match(/\x1b\[[0-9;]*$/);
    assert.equal(dangling, null, `line ends with an incomplete escape sequence: ${JSON.stringify(line)}`);
  }
});

test("renderMarkdown('') returns an empty array (no bogus single blank line)", () => {
  assert.deepEqual(renderMarkdown(""), []);
});
