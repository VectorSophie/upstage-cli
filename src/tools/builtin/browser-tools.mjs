// browser_open/snapshot/click/type/console/screenshot/close (3.3.0 Thread
// C, Task C.3) — minimal native browser verification. Accessibility-tree
// snapshot is the only observation format (design doc §C — no raw-HTML
// escape hatch), browser state is ephemeral per session (no persistent
// profile), and console/screenshot evidence goes to the Session 1 evidence
// store rather than being inlined into tool results.

import { findChrome } from "../../browser/discovery.mjs";
import { CDPClient } from "../../browser/cdp-client.mjs";
import { getBrowser, setBrowser, closeBrowser } from "../../browser/session-registry.mjs";
import { writeArtifact } from "../../runtime/artifacts.mjs";

function sessionKey(context) {
  return context?.session?.id || "default";
}

function requireBrowser(context) {
  const client = getBrowser(sessionKey(context));
  if (!client) {
    throw Object.assign(
      new Error("no browser is open for this session — call browser_open first"),
      { code: "BROWSER_NOT_OPEN" }
    );
  }
  return client;
}

export const browserOpenTool = {
  name: "browser_open",
  description: "Launch (or reuse) a browser and navigate to a URL",
  risk: "medium",
  inputSchema: {
    type: "object",
    properties: { url: { type: "string" } },
    required: ["url"],
    additionalProperties: false
  },
  async execute(args, context) {
    const key = sessionKey(context);
    let client = getBrowser(key);
    if (!client) {
      const chromePath = await findChrome();
      if (!chromePath) {
        throw Object.assign(
          new Error("no Chrome/Chromium install found — run `upstage browser install`, or install Chrome and try again"),
          { code: "CHROME_NOT_FOUND" }
        );
      }
      client = new CDPClient({ chromePath });
      await client.launch();
      setBrowser(key, client);
    }
    await client.navigate(args.url);
    return { ok: true, url: args.url };
  }
};

export const browserSnapshotTool = {
  name: "browser_snapshot",
  description: "Return the current page's accessibility tree (the only observation format — never raw HTML)",
  risk: "low",
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
  async execute(_args, context) {
    return requireBrowser(context).snapshot();
  }
};

export const browserClickTool = {
  name: "browser_click",
  description: "Click an element by its browser_snapshot ref",
  risk: "medium",
  inputSchema: {
    type: "object",
    properties: { ref: { type: "number" } },
    required: ["ref"],
    additionalProperties: false
  },
  async execute(args, context) {
    await requireBrowser(context).click(args.ref);
    return { ok: true };
  }
};

export const browserTypeTool = {
  name: "browser_type",
  description: "Type text into an element by its browser_snapshot ref",
  risk: "medium",
  inputSchema: {
    type: "object",
    properties: { ref: { type: "number" }, text: { type: "string" } },
    required: ["ref", "text"],
    additionalProperties: false
  },
  async execute(args, context) {
    await requireBrowser(context).type(args.ref, args.text);
    return { ok: true };
  }
};

export const browserConsoleTool = {
  name: "browser_console",
  description: "Drain console/log output captured since the last call, written to the evidence store",
  risk: "low",
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
  async execute(_args, context) {
    const logs = await requireBrowser(context).consoleLogs();
    const sessionId = context?.session?.id;
    if (!sessionId) return { logs };
    const artifact = await writeArtifact(sessionId, {
      kind: "console-log",
      ext: "json",
      data: JSON.stringify(logs)
    });
    return { logs, artifact };
  }
};

export const browserScreenshotTool = {
  name: "browser_screenshot",
  description: "Capture a screenshot of the current page, written to the evidence store",
  risk: "low",
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
  async execute(_args, context) {
    const png = await requireBrowser(context).screenshot();
    const sessionId = context?.session?.id;
    if (!sessionId) return { dataBase64: png.toString("base64") };
    const artifact = await writeArtifact(sessionId, { kind: "screenshot", ext: "png", data: png });
    return { artifact };
  }
};

export const browserCloseTool = {
  name: "browser_close",
  description: "Close the browser opened for this session",
  risk: "low",
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
  async execute(_args, context) {
    await closeBrowser(sessionKey(context));
    return { ok: true };
  }
};
