import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import { join } from "node:path";
import crypto from "node:crypto";

const MAX_HISTORY_ITEMS = 200;

const MAX_EVENT_STRING = 500;
const MAX_EVENT_ARRAY = 20;
const MAX_EVENT_KEYS = 30;
const MAX_EVENT_DEPTH = 4;

function sanitizeValue(value, depth = 0, seen = new WeakSet(), keyName = "") {
  if (value === null || typeof value === "undefined") {
    return value;
  }

  if (typeof value === "string") {
    if (value.length <= MAX_EVENT_STRING) {
      return value;
    }
    return `${value.slice(0, MAX_EVENT_STRING)}...[truncated:${value.length}]`;
  }

  if (typeof value === "number" || typeof value === "boolean") {
    return value;
  }

  if (typeof value === "function") {
    return "[function]";
  }

  if (depth >= MAX_EVENT_DEPTH) {
    return "[truncated-depth]";
  }

  if (typeof value === "object") {
    if (seen.has(value)) {
      return "[circular]";
    }
    seen.add(value);

    if (Array.isArray(value)) {
      return value
        .slice(0, MAX_EVENT_ARRAY)
        .map((item) => sanitizeValue(item, depth + 1, seen, keyName));
    }

    if (keyName === "session") {
      return {
        id: value.id || null,
        updatedAt: value.updatedAt || null,
        historyCount: Array.isArray(value.history) ? value.history.length : 0
      };
    }

    const out = {};
    const entries = Object.entries(value).slice(0, MAX_EVENT_KEYS);
    for (const [key, nested] of entries) {
      if (key === "runtimeEvents") {
        out.runtimeEvents = `[omitted:${Array.isArray(nested) ? nested.length : 0}]`;
        continue;
      }
      out[key] = sanitizeValue(nested, depth + 1, seen, key);
    }
    return out;
  }

  return String(value);
}

function toSerializable(value) {
  return sanitizeValue(value);
}

function sessionRoot() {
  return join(os.homedir(), ".upstage-cli", "sessions");
}

function sessionPath(id) {
  return join(sessionRoot(), `${id}.json`);
}

export function createSession(cwd) {
  const id = crypto.randomUUID();
  return {
    id,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    workspace: { cwd },
    history: [],
    toolResults: [],
    appliedPatches: [],
    runtimeEvents: []
  };
}

export function appendHistory(session, item) {
  session.history.push({ at: Date.now(), ...item });
  if (session.history.length > MAX_HISTORY_ITEMS) {
    session.history = session.history.slice(-MAX_HISTORY_ITEMS);
  }
  session.updatedAt = Date.now();
}

export function appendToolResult(session, result) {
  session.toolResults.push({ at: Date.now(), ...result });
  if (session.toolResults.length > MAX_HISTORY_ITEMS) {
    session.toolResults = session.toolResults.slice(-MAX_HISTORY_ITEMS);
  }
  session.updatedAt = Date.now();
}

export function appendAppliedPatch(session, patchSummary) {
  session.appliedPatches.push({ at: Date.now(), ...patchSummary });
  if (session.appliedPatches.length > MAX_HISTORY_ITEMS) {
    session.appliedPatches = session.appliedPatches.slice(-MAX_HISTORY_ITEMS);
  }
  session.updatedAt = Date.now();
}

export function appendRuntimeEvent(session, event) {
  if (!Array.isArray(session.runtimeEvents)) {
    session.runtimeEvents = [];
  }
  session.runtimeEvents.push({ at: Date.now(), ...toSerializable(event) });
  if (session.runtimeEvents.length > MAX_HISTORY_ITEMS * 2) {
    session.runtimeEvents = session.runtimeEvents.slice(-MAX_HISTORY_ITEMS * 2);
  }
  session.updatedAt = Date.now();
}

export async function saveSession(session) {
  await mkdir(sessionRoot(), { recursive: true });
  await writeFile(sessionPath(session.id), JSON.stringify(session, null, 2), "utf8");
}

export async function loadSession(id) {
  const content = await readFile(sessionPath(id), "utf8");
  return JSON.parse(content);
}

export async function listSessions() {
  await mkdir(sessionRoot(), { recursive: true });
  const entries = await readdir(sessionRoot(), { withFileTypes: true });
  const sessions = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) {
      continue;
    }
    const id = entry.name.replace(/\.json$/, "");
    try {
      const session = await loadSession(id);
      sessions.push({ id: session.id, updatedAt: session.updatedAt, workspace: session.workspace });
    } catch {
    }
  }
  sessions.sort((a, b) => b.updatedAt - a.updatedAt);
  return sessions;
}

export async function loadLatestSession(cwd) {
  const sessions = await listSessions();
  const sameWorkspace = sessions.find((session) => session.workspace?.cwd === cwd);
  if (sameWorkspace) {
    return loadSession(sameWorkspace.id);
  }
  if (sessions[0]) {
    return loadSession(sessions[0].id);
  }
  return null;
}

export async function resetSession(id) {
  await rm(sessionPath(id), { force: true });
}
