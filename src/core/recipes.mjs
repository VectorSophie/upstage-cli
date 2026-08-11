import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";

/**
 * Recipes (docs/feature-landscape-2026.md §3.4, Goose's YAML multi-step
 * workflows): named, parameterized, shareable prompt templates — a
 * natural next step for /spec's spec-driven-memory direction, not a
 * separate system. JSON, not YAML — this is a Bun/Node zero-dependency
 * project with no YAML parser already in package.json, and a
 * `{{param}}`-substitution template is exactly as expressible in JSON as
 * YAML; adding a parser dependency for syntax preference alone isn't
 * worth it (ponytail: stdlib before dependency).
 */

const SAFE_NAME = /^[a-zA-Z0-9_-]+$/;

function recipesDir(cwd = process.cwd()) {
  return join(cwd, ".upstage", "recipes");
}

function recipePath(cwd, name) {
  return join(recipesDir(cwd), `${name}.json`);
}

function assertSafeName(name) {
  if (typeof name !== "string" || !SAFE_NAME.test(name)) {
    throw new Error(`Invalid recipe name (letters/digits/_/- only): ${name}`);
  }
}

export async function saveRecipe(cwd, name, { description = "", template } = {}) {
  assertSafeName(name);
  if (typeof template !== "string" || !template.trim()) {
    throw new Error("template is required");
  }
  await mkdir(recipesDir(cwd), { recursive: true });
  const recipe = { name, description, template, createdAt: Date.now() };
  await writeFile(recipePath(cwd, name), JSON.stringify(recipe, null, 2), "utf8");
  return recipe;
}

export async function loadRecipe(cwd, name) {
  assertSafeName(name);
  const p = recipePath(cwd, name);
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(await readFile(p, "utf8"));
  } catch {
    return null;
  }
}

export async function listRecipes(cwd = process.cwd()) {
  const dir = recipesDir(cwd);
  if (!existsSync(dir)) return [];
  const files = await readdir(dir);
  const recipes = [];
  for (const f of files) {
    if (!f.endsWith(".json")) continue;
    try {
      recipes.push(JSON.parse(await readFile(join(dir, f), "utf8")));
    } catch { /* skip unreadable */ }
  }
  return recipes.sort((a, b) => a.name.localeCompare(b.name));
}

/** Substitute {{key}} placeholders in a recipe's template with `params`. Unfilled placeholders are left as-is (visible, not silently dropped). */
export function renderRecipe(recipe, params = {}) {
  return recipe.template.replace(/\{\{(\w+)\}\}/g, (match, key) =>
    Object.prototype.hasOwnProperty.call(params, key) ? String(params[key]) : match
  );
}

/** Parse `/recipe run name key=value key2=value2` style args into { name, params }. */
export function parseRecipeRunArgs(args = []) {
  const [name, ...rest] = args;
  const params = {};
  for (const token of rest) {
    const eq = token.indexOf("=");
    if (eq === -1) continue;
    params[token.slice(0, eq)] = token.slice(eq + 1);
  }
  return { name, params };
}
