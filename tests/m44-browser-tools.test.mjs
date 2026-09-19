// Tests for src/tools/builtin/browser-tools.mjs (3.3.0 Thread C, Task C.3)
// — the browser_open/snapshot/click/type/console/screenshot/close tools,
// exercised through the real tool interface (not cdp-client.mjs directly)
// against a real Chrome + the same fixture page m42 uses, proving the
// tool-layer plumbing (session registry, evidence-store writes, error
// shapes) on top of the already-verified CDP client.

import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";

import { findChrome } from "../src/browser/discovery.mjs";
import {
  browserOpenTool, browserSnapshotTool, browserClickTool, browserTypeTool,
  browserConsoleTool, browserScreenshotTool, browserCloseTool
} from "../src/tools/builtin/browser-tools.mjs";
import { readArtifact } from "../src/runtime/artifacts.mjs";
import { resetSession } from "../src/runtime/session.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE_URL = pathToFileURL(join(__dirname, "fixtures", "browser-fixture.html")).href;

let chromeAvailable;
test.before(async () => { chromeAvailable = Boolean(await findChrome()); });

function flatten(node, out = []) {
  out.push(node);
  for (const child of node.children || []) flatten(child, out);
  return out;
}

test("browser_open without Chrome available reports a clear CHROME_NOT_FOUND error", async (t) => {
  if (chromeAvailable) return t.skip("Chrome is available in this environment");
  await assert.rejects(
    () => browserOpenTool.execute({ url: FIXTURE_URL }, { session: { id: crypto.randomUUID() } }),
    (err) => err.code === "CHROME_NOT_FOUND"
  );
});

test("browser_snapshot/click/type/console/screenshot/close — full tool-level flow", async (t) => {
  if (!chromeAvailable) return t.skip("no Chrome available in this environment");
  const sessionId = crypto.randomUUID();
  const context = { session: { id: sessionId } };
  try {
    const opened = await browserOpenTool.execute({ url: FIXTURE_URL }, context);
    assert.equal(opened.ok, true);

    const tree = await browserSnapshotTool.execute({}, context);
    const flat = flatten(tree);
    const button = flat.find((n) => n.name?.includes("Click me"));
    const input = flat.find((n) => n.role === "textbox");
    assert.ok(button && input);

    await browserClickTool.execute({ ref: button.ref }, context);
    const after = flatten(await browserSnapshotTool.execute({}, context));
    assert.ok(after.some((n) => n.name === "1"));

    await browserTypeTool.execute({ ref: input.ref, text: "hi" }, context);

    const consoleResult = await browserConsoleTool.execute({}, context);
    assert.ok(consoleResult.logs.some((l) => l.text.includes("fixture loaded")));
    assert.ok(consoleResult.artifact, "console output should be written to the evidence store");
    const consoleBytes = await readArtifact(consoleResult.artifact.path);
    assert.ok(JSON.parse(consoleBytes.toString("utf8")).length > 0);

    const screenshotResult = await browserScreenshotTool.execute({}, context);
    assert.ok(screenshotResult.artifact, "screenshot should be written to the evidence store, not inlined");
    assert.equal(screenshotResult.artifact.kind, "screenshot");
    const pngBytes = await readArtifact(screenshotResult.artifact.path);
    assert.equal(pngBytes[0], 0x89);

    const closed = await browserCloseTool.execute({}, context);
    assert.equal(closed.ok, true);
  } finally {
    await resetSession(sessionId);
  }
});

test("browser_snapshot before browser_open reports a clear BROWSER_NOT_OPEN error", async (t) => {
  if (!chromeAvailable) return t.skip("no Chrome available in this environment");
  await assert.rejects(
    () => browserSnapshotTool.execute({}, { session: { id: crypto.randomUUID() } }),
    (err) => err.code === "BROWSER_NOT_OPEN"
  );
});
