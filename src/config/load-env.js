import { access, readFile } from "node:fs/promises";
import { constants } from "node:fs";
import { join } from "node:path";

function unquote(value) {
  if (value.length >= 2) {
    const first = value[0];
    const last = value[value.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return value.slice(1, -1);
    }
  }
  return value;
}

export async function loadProjectEnv(cwd) {
  const envPath = join(cwd, ".env");
  try {
    await access(envPath, constants.F_OK);
  } catch {
    return { loaded: false, path: envPath, keys: [] };
  }

  const content = await readFile(envPath, "utf8");
  const keys = [];
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) {
      continue;
    }
    const eqIndex = line.indexOf("=");
    if (eqIndex <= 0) {
      continue;
    }
    const key = line.slice(0, eqIndex).trim();
    const value = unquote(line.slice(eqIndex + 1).trim());
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
      continue;
    }
    if (typeof process.env[key] === "undefined") {
      process.env[key] = value;
    }
    keys.push(key);
  }

  return { loaded: true, path: envPath, keys };
}
