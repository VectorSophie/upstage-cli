// Minimal native Chrome DevTools Protocol client (3.3.0 Thread C, Task C.1).
// Deliberately NOT a general automation library — covers exactly what the
// browser_* tools (Task C.3) need: navigate, an accessibility-tree
// snapshot (never raw HTML — design doc §C), click/type, console capture,
// and a screenshot. No Playwright/Puppeteer dependency: `oven-sh/bun#18749`
// (playwright-core not bundled by `bun build --compile`) is still open, so
// this speaks CDP directly over the platform's built-in WebSocket instead.
//
// Domains used: Target, Page, DOM, Accessibility, Input, Runtime, Log.
// One browser-level WebSocket connection, multiplexed across a single page
// target via CDP's "flatten" session addressing (each command/event carries
// a `sessionId` once attached) — simpler than one WS connection per target,
// and this client only ever drives one page at a time.

import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const LAUNCH_TIMEOUT_MS = 15000;
const COMMAND_TIMEOUT_MS = 15000;

async function waitForHttpJson(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.ok) return res.json();
    } catch (err) {
      lastError = err;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`timed out waiting for ${url}: ${lastError?.message || "no response"}`);
}

export class CDPClient {
  constructor({ chromePath, port = 0, headless = true } = {}) {
    if (!chromePath) throw new Error("CDPClient requires a chromePath (see src/browser/discovery.mjs)");
    this.chromePath = chromePath;
    this.headless = headless;
    this._port = port;
    this._process = null;
    this._userDataDir = null;
    this._ws = null;
    this._nextId = 1;
    this._pending = new Map();
    this._sessionId = null;
    this._targetId = null;
    this._consoleBuffer = [];
  }

  async launch() {
    this._userDataDir = mkdtempSync(join(tmpdir(), "upstage-browser-"));
    // Chrome doesn't report an OS-assigned (port:0) debugging port back over
    // stdio in a way worth parsing, so pick a concrete high port ourselves —
    // collision odds across parallel runs are low enough not to warrant a
    // free-port-probe dependency for this.
    if (this._port === 0) this._port = 9222 + Math.floor(Math.random() * 2000);

    const args = [
      `--remote-debugging-port=${this._port}`,
      `--user-data-dir=${this._userDataDir}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-gpu",
      "--disable-extensions",
      "about:blank"
    ];
    if (this.headless) args.unshift("--headless=new");

    this._process = spawn(this.chromePath, args, { stdio: "ignore" });

    const versionInfo = await waitForHttpJson(`http://127.0.0.1:${this._port}/json/version`, LAUNCH_TIMEOUT_MS);
    await this._connectBrowserSocket(versionInfo.webSocketDebuggerUrl);
    await this._openPage();
  }

  async _connectBrowserSocket(wsUrl) {
    this._ws = new WebSocket(wsUrl);
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("timed out connecting to Chrome DevTools websocket")), LAUNCH_TIMEOUT_MS);
      this._ws.addEventListener("open", () => { clearTimeout(timer); resolve(); }, { once: true });
      this._ws.addEventListener("error", (err) => { clearTimeout(timer); reject(err); }, { once: true });
    });
    this._ws.addEventListener("message", (event) => this._onMessage(event));
  }

  _onMessage(event) {
    const msg = JSON.parse(event.data);
    if (typeof msg.id === "number" && this._pending.has(msg.id)) {
      const { resolve, reject } = this._pending.get(msg.id);
      this._pending.delete(msg.id);
      if (msg.error) reject(new Error(msg.error.message || "CDP error"));
      else resolve(msg.result);
      return;
    }
    if (msg.method === "Runtime.consoleAPICalled") {
      const text = (msg.params.args || []).map((a) => (a.value !== undefined ? String(a.value) : a.description || "")).join(" ");
      this._consoleBuffer.push({ type: msg.params.type, text });
    }
    if (msg.method === "Log.entryAdded") {
      this._consoleBuffer.push({ type: msg.params.entry.level, text: msg.params.entry.text });
    }
  }

  /** Sends a CDP command. Once attached to a page (`this._sessionId` set),
   *  commands are routed to it via flat-session addressing unless
   *  `browserLevel` is passed (used only during target setup). */
  send(method, params = {}, { browserLevel = false } = {}) {
    return new Promise((resolve, reject) => {
      const id = this._nextId++;
      const payload = { id, method, params };
      if (this._sessionId && !browserLevel) payload.sessionId = this._sessionId;

      const timer = setTimeout(() => {
        this._pending.delete(id);
        reject(new Error(`CDP command timed out: ${method}`));
      }, COMMAND_TIMEOUT_MS);

      this._pending.set(id, {
        resolve: (result) => { clearTimeout(timer); resolve(result); },
        reject: (err) => { clearTimeout(timer); reject(err); }
      });
      this._ws.send(JSON.stringify(payload));
    });
  }

  async _openPage() {
    const { targetId } = await this.send("Target.createTarget", { url: "about:blank" }, { browserLevel: true });
    this._targetId = targetId;
    const { sessionId } = await this.send("Target.attachToTarget", { targetId, flatten: true }, { browserLevel: true });
    this._sessionId = sessionId;

    await this.send("Page.enable");
    await this.send("Runtime.enable");
    await this.send("Log.enable");
    await this.send("DOM.enable");
  }

  async navigate(url) {
    this._consoleBuffer = [];
    const navigated = new Promise((resolve) => {
      const handler = (event) => {
        const msg = JSON.parse(event.data);
        if (msg.method === "Page.loadEventFired" && msg.sessionId === this._sessionId) {
          this._ws.removeEventListener("message", handler);
          resolve();
        }
      };
      this._ws.addEventListener("message", handler);
    });
    await this.send("Page.navigate", { url });
    await navigated;
  }

  async evaluate(expression) {
    const { result } = await this.send("Runtime.evaluate", { expression, returnByValue: true });
    return result?.value;
  }

  /** Returns a simplified accessibility tree — {role, name, ref, children}
   *  — never raw HTML/DOM (design doc §C: this is the only observation
   *  format). `ref` is the backendDOMNodeId, the target for click()/type(). */
  async snapshot() {
    const { nodes } = await this.send("Accessibility.getFullAXTree");
    const byId = new Map(nodes.map((n) => [n.nodeId, n]));

    function toSimple(axNode) {
      if (!axNode) return null;
      const role = axNode.role?.value;
      const name = axNode.name?.value;
      if (axNode.ignored) {
        // Ignored nodes (presentational, hidden) are skipped but their
        // children are still walked — otherwise a wrapper <div> would hide
        // everything meaningful beneath it.
        const children = (axNode.childIds || [])
          .map((id) => toSimple(byId.get(id)))
          .filter(Boolean);
        return children.length === 1 ? children[0] : { role: "group", name: "", ref: null, children };
      }
      const children = (axNode.childIds || [])
        .map((id) => toSimple(byId.get(id)))
        .filter(Boolean);
      return { role, name, ref: axNode.backendDOMNodeId ?? null, children };
    }

    const root = nodes.find((n) => !n.parentId) || nodes[0];
    return toSimple(root) || { role: "root", name: "", ref: null, children: [] };
  }

  async click(ref) {
    await this._focus(ref);
    const { model } = await this.send("DOM.getBoxModel", { backendNodeId: ref });
    const [x1, y1, , , x3, y3] = model.content;
    const x = (x1 + x3) / 2;
    const y = (y1 + y3) / 2;
    await this.send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 });
    await this.send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 });
  }

  async type(ref, text) {
    await this._focus(ref);
    await this.send("Input.insertText", { text });
  }

  async _focus(ref) {
    const { object } = await this.send("DOM.resolveNode", { backendNodeId: ref });
    await this.send("Runtime.callFunctionOn", {
      objectId: object.objectId,
      functionDeclaration: "function() { this.focus(); }"
    });
  }

  /** Drains and clears the buffered console/log entries collected since
   *  the last call (or since navigate()). */
  async consoleLogs() {
    const entries = this._consoleBuffer;
    this._consoleBuffer = [];
    return entries;
  }

  async screenshot() {
    const { data } = await this.send("Page.captureScreenshot", { format: "png" });
    return Buffer.from(data, "base64");
  }

  async close() {
    try {
      if (this._ws && this._ws.readyState === WebSocket.OPEN) {
        this._ws.close();
      }
    } catch {
      // best-effort
    }
    if (this._process) {
      this._process.kill();
    }
    if (this._userDataDir) {
      try { rmSync(this._userDataDir, { recursive: true, force: true }); } catch { /* best-effort */ }
    }
  }
}
