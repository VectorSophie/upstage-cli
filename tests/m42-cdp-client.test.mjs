// Tests for src/browser/cdp-client.mjs (3.3.0 Thread C, Task C.1) — the
// minimal native Chrome DevTools Protocol client. No Playwright/Puppeteer
// dependency (design doc §C, per the still-open oven-sh/bun#18749 standalone-
// executable issue) — this speaks CDP directly over the built-in WebSocket.
//
// Gated on a real Chrome being discoverable (findChrome()) — this dev box
// has one, so these exercise a real browser end-to-end rather than mocks.

import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";

import { findChrome } from "../src/browser/discovery.mjs";
import { CDPClient } from "../src/browser/cdp-client.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE_URL = pathToFileURL(join(__dirname, "fixtures", "browser-fixture.html")).href;

let chromePath;

test.before(async () => {
  chromePath = await findChrome();
});

function skip() {
  return !chromePath;
}

test("launch, navigate, snapshot, close — full lifecycle against a real page", async (t) => {
  if (skip()) return t.skip("no Chrome available in this environment");
  const client = new CDPClient({ chromePath });
  try {
    await client.launch();
    await client.navigate(FIXTURE_URL);
    const tree = await client.snapshot();

    const flat = [];
    (function walk(node) {
      flat.push(node);
      for (const child of node.children || []) walk(child);
    })(tree);

    assert.ok(flat.some((n) => n.name?.includes("Click me")), "expected the button's accessible name in the snapshot");
    assert.ok(flat.some((n) => n.name?.includes("Fixture Page") || n.role === "heading"), "expected the heading in the snapshot");
  } finally {
    await client.close();
  }
});

test("click(ref) actually interacts with the page", async (t) => {
  if (skip()) return t.skip("no Chrome available in this environment");
  const client = new CDPClient({ chromePath });
  try {
    await client.launch();
    await client.navigate(FIXTURE_URL);
    const tree = await client.snapshot();

    const flat = [];
    (function walk(node) {
      flat.push(node);
      for (const child of node.children || []) walk(child);
    })(tree);
    const button = flat.find((n) => n.name?.includes("Click me"));
    assert.ok(button, "expected to find the button in the snapshot");

    await client.click(button.ref);

    const after = await client.snapshot();
    const afterFlat = [];
    (function walk(node) {
      afterFlat.push(node);
      for (const child of node.children || []) walk(child);
    })(after);
    assert.ok(afterFlat.some((n) => n.name === "1"), "expected the counter span's text to have updated to 1");
  } finally {
    await client.close();
  }
});

test("type(ref, text) fills an input", async (t) => {
  if (skip()) return t.skip("no Chrome available in this environment");
  const client = new CDPClient({ chromePath });
  try {
    await client.launch();
    await client.navigate(FIXTURE_URL);
    const tree = await client.snapshot();
    const flat = [];
    (function walk(node) {
      flat.push(node);
      for (const child of node.children || []) walk(child);
    })(tree);
    const input = flat.find((n) => n.role === "textbox");
    assert.ok(input, "expected to find the name input in the snapshot");

    await client.type(input.ref, "hello upstage");

    const value = await client.evaluate("document.getElementById('name-input').value");
    assert.equal(value, "hello upstage");
  } finally {
    await client.close();
  }
});

test("consoleLogs() captures page console output", async (t) => {
  if (skip()) return t.skip("no Chrome available in this environment");
  const client = new CDPClient({ chromePath });
  try {
    await client.launch();
    await client.navigate(FIXTURE_URL);
    const logs = await client.consoleLogs();
    assert.ok(logs.some((entry) => entry.text.includes("fixture loaded")));
  } finally {
    await client.close();
  }
});

test("screenshot() returns non-empty PNG bytes", async (t) => {
  if (skip()) return t.skip("no Chrome available in this environment");
  const client = new CDPClient({ chromePath });
  try {
    await client.launch();
    await client.navigate(FIXTURE_URL);
    const png = await client.screenshot();
    assert.ok(Buffer.isBuffer(png));
    assert.ok(png.length > 0);
    // PNG magic bytes
    assert.equal(png[0], 0x89);
    assert.equal(png.toString("ascii", 1, 4), "PNG");
  } finally {
    await client.close();
  }
});
