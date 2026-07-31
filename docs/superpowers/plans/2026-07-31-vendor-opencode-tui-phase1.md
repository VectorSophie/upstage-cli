# Vendor opencode TUI — Phase 1 (Runtime + Shell Spike) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Get opencode's actual TUI (forked from `anomalyco/opencode`, MIT) rendering
standalone under Bun in this repo, talking to a real (but unmodified, externally
run) opencode server — with zero changes to our existing Node/Ink TUI or agent
core.

**Architecture:** Vendor `packages/tui/src/**` from opencode's `dev` branch into
`vendor/opencode-tui/src/`, plus the narrow slice of their private `@opencode-ai/core`
package that the TUI's entrypoint actually needs (`global.ts`, `effect/app-node-builder.ts`,
`flag/flag.ts`, `installation/version.ts`, and whatever those transitively pull in —
discovered via TypeScript compiler errors, not guessed). Published deps
(`@opentui/*`, `@opencode-ai/sdk|ui|plugin`, `solid-js`, etc.) are installed
normally via Bun. A small launch script we write (`bin/launch.ts`, modeled 1:1 on
opencode's own `packages/cli/src/tui.ts`) calls the vendored `run()` and points it
at a locally running `opencode serve` instance (started from the **published**
`opencode-ai` npm package, used only as an external test fixture — never
vendored) so we can visually confirm the fork renders correctly.

**Tech Stack:** Bun 1.x (already installed: `1.3.6`), TypeScript, Solid.js,
`@opentui/core` + `@opentui/solid` (native Zig-backed renderer), `effect`
(Effect-TS). None of this touches `src/` (Node/React/Ink) — it lives entirely
under `vendor/opencode-tui/`.

---

## Reference facts (from spec, verified before this plan was written)

- Upstream repo: `anomalyco/opencode`, default branch `dev`, HEAD at time of
  writing: `ceb4890ca3651899dd3e2b1564168ab098ac540d`.
- `packages/tui` → private/unpublished (`@opencode-ai/tui`), must be vendored.
- `packages/core` → private/unpublished (`@opencode-ai/core`), only a narrow
  slice is needed (confirmed via `packages/cli/src/tui.ts`'s `runTui()`, which
  is the exact pattern our `bin/launch.ts` copies).
- `@opentui/core`, `@opentui/solid`, `@opentui/keymap`, `@opencode-ai/sdk`,
  `@opencode-ai/ui`, `@opencode-ai/plugin` → published on npm, install directly.
- `opencode-ai` (the full published CLI, includes `opencode serve`) → published
  on npm, binary name `opencode` (`opencode.exe` on Windows). Used here as a
  **devDependency test fixture only** — we run its `serve` command unmodified
  to have something real for our forked TUI to talk to. We do not vendor or
  modify it.
- `opencode serve` binds to port `4096` by default and prints the listening
  address + a generated password to stdout on startup (see
  `packages/cli/src/commands/handlers/serve.ts` — auth is a password-protected
  local HTTP server, not open).

---

## Task 1: Confirm preconditions

**Files:** none (verification only)

- [ ] **Step 1: Confirm Bun is available**

Run: `bun --version`
Expected: a version string (already confirmed `1.3.6` on this machine). If this
fails on a different machine, install per https://bun.sh (`irm bun.sh/install.ps1 | iex`
on Windows PowerShell) before continuing — do not proceed without it, the
native renderer has no Node fallback (see spec's "Key facts established").

- [ ] **Step 2: Confirm git is available and can reach GitHub**

Run: `git ls-remote --heads https://github.com/anomalyco/opencode dev`
Expected: one line of output like `ceb4890ca3651899dd3e2b1564168ab098ac540d refs/heads/dev`
(the exact SHA may have advanced since this plan was written — that's fine,
note whatever SHA you get in Task 2's `UPSTREAM.md`).

---

## Task 2: Scaffold the vendor directory + attribution

**Files:**
- Create: `vendor/opencode-tui/UPSTREAM.md`
- Create: `vendor/opencode-tui/LICENSE`
- Create: `.gitattributes` entry (modify existing repo root `.gitattributes` if
  present, else skip — this repo doesn't currently have one, confirmed by
  `ls`, so this step is a no-op; do not create one speculatively)

- [ ] **Step 1: Create the vendor directory and record the exact commit being vendored**

Run:
```bash
mkdir -p vendor/opencode-tui
git ls-remote --heads https://github.com/anomalyco/opencode dev > /tmp/opencode-sha.txt
cat /tmp/opencode-sha.txt
```
Copy the SHA from the output for the next step.

- [ ] **Step 2: Write `vendor/opencode-tui/UPSTREAM.md`**

```markdown
# Vendored from anomalyco/opencode

- Source: https://github.com/anomalyco/opencode
- Branch: dev
- Commit: <PASTE THE SHA FROM TASK 2 STEP 1 HERE>
- Vendored paths:
  - `packages/tui/src/**` → `vendor/opencode-tui/src/`
  - Narrow slice of `packages/core/src/` → `vendor/opencode-tui/core-shim/`
    (see that directory's own note for the exact file list — determined by
    the compile-error-driven process in Task 4, not fixed in advance)
- License: MIT (see `LICENSE` in this directory, copied from upstream)
- Why vendored instead of installed: both `@opencode-ai/tui` and
  `@opencode-ai/core` are `"private": true` workspace packages, not published
  to npm. See `docs/superpowers/specs/2026-07-31-vendor-opencode-tui-phase1-design.md`
  for the full rationale.
- This is a Phase 1 spike (unwired, standalone shell). It is not part of the
  default `upstage` CLI entrypoint. See that spec for the full phase plan.

## Updating the vendor

There is no automated sync yet (that's a later-phase concern, not built here).
To pick up upstream changes: re-run the `git archive` commands in this repo's
plan history (`docs/superpowers/plans/2026-07-31-vendor-opencode-tui-phase1.md`,
Task 3 and Task 4), diff against the current `src/` and `core-shim/`, and
reconcile by hand.
```

- [ ] **Step 3: Fetch and write the upstream LICENSE file**

Run:
```bash
curl -fsSL https://raw.githubusercontent.com/anomalyco/opencode/dev/LICENSE -o vendor/opencode-tui/LICENSE
cat vendor/opencode-tui/LICENSE | head -5
```
Expected: MIT license text starting with `MIT License`.

- [ ] **Step 4: Commit the scaffold**

```bash
git add vendor/opencode-tui/UPSTREAM.md vendor/opencode-tui/LICENSE
git commit -m "chore: scaffold vendor/opencode-tui with upstream attribution"
```

---

## Task 3: Vendor the TUI source (`packages/tui/src`)

**Files:**
- Create: `vendor/opencode-tui/src/**` (entire subtree, copied from upstream)
- Create: `vendor/opencode-tui/package.json`
- Create: `vendor/opencode-tui/bunfig.toml`
- Create: `vendor/opencode-tui/tsconfig.json`

- [ ] **Step 1: Sparse-clone just the `packages/tui` subtree**

Run (from the repo root):
```bash
git clone --filter=blob:none --no-checkout --depth 1 --branch dev \
  https://github.com/anomalyco/opencode /tmp/opencode-src
cd /tmp/opencode-src
git sparse-checkout set --cone packages/tui
git checkout dev
cd -
```
Expected: `/tmp/opencode-src/packages/tui/src/` exists with the `component/`,
`context/`, `config/`, `ui/`, `feature-plugins/`, `prompt/`, `routes/`,
`plugin/`, `theme/`, `util/` subdirectories and top-level files
(`app.tsx`, `index.tsx`, `logo.ts`, `keymap.tsx`, `runtime.tsx`, etc.).

- [ ] **Step 2: Copy the source tree in**

Run:
```bash
cp -r /tmp/opencode-src/packages/tui/src vendor/opencode-tui/src
cp /tmp/opencode-src/packages/tui/tsconfig.json vendor/opencode-tui/tsconfig.json
cp /tmp/opencode-src/packages/tui/bunfig.toml vendor/opencode-tui/bunfig.toml
ls vendor/opencode-tui/src
```
Expected: the same directory listing as Step 1's `packages/tui/src`.

- [ ] **Step 3: Write `vendor/opencode-tui/package.json`**

Base this on the upstream `packages/tui/package.json` (fetched during spec
research), but drop the `"private": true` workspace-only exports we don't
need yet and point `dependencies` at real published versions:

```json
{
  "name": "opencode-tui-vendor",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "scripts": {
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "@opencode-ai/sdk": "1.18.10",
    "@opencode-ai/ui": "1.18.10",
    "@opencode-ai/plugin": "1.18.10",
    "@opentui/core": "0.4.5",
    "@opentui/solid": "^0.4.5",
    "@opentui/keymap": "^0.4.5",
    "clipboardy": "4.0.0",
    "diff": "9.0.0",
    "effect": "^3.10.0",
    "fuzzysort": "^3.0.0",
    "marked": "17.0.1",
    "remeda": "^2.0.0",
    "solid-js": "^1.9.0",
    "strip-ansi": "7.1.2",
    "open": "10.1.2"
  },
  "devDependencies": {
    "@types/bun": "latest",
    "typescript": "^5.7.0"
  }
}
```

Note: `effect`, `remeda`, `solid-js` version ranges here are best-known-good
starting points (the upstream monorepo pins them via a Bun catalog we don't
have access to as outside consumers) — if `bun install` in Task 5 fails to
resolve or `bun run typecheck` shows type errors traceable to a version
mismatch, check `npm view <package> versions` and adjust to the newest
compatible major version. This is expected iteration, not a sign of a wrong
approach.

- [ ] **Step 4: Clean up the temp clone**

Run: `rm -rf /tmp/opencode-src`

- [ ] **Step 5: Commit**

```bash
git add vendor/opencode-tui/src vendor/opencode-tui/package.json \
  vendor/opencode-tui/bunfig.toml vendor/opencode-tui/tsconfig.json
git commit -m "chore: vendor opencode TUI source from packages/tui/src"
```

---

## Task 4: Vendor the minimal `@opencode-ai/core` slice

**Files:**
- Create: `vendor/opencode-tui/core-shim/**` (grown iteratively this task)

The TUI's entrypoint (`src/app.tsx`) and our launch script (Task 6, modeled on
upstream's `packages/cli/src/tui.ts`) import exactly these top-level core
modules: `@opencode-ai/core/global`, `@opencode-ai/core/effect/app-node-builder`,
`@opencode-ai/core/flag/flag`, `@opencode-ai/core/installation/version`. Each of
those files likely imports further internal core modules — the actual
transitive closure isn't knowable without vendoring and compiling. This task
vendors the four known entry files, then follows compiler errors outward
until `bun run typecheck` (added in Task 5) succeeds against them.

- [ ] **Step 1: Sparse-clone `packages/core`**

Run:
```bash
git clone --filter=blob:none --no-checkout --depth 1 --branch dev \
  https://github.com/anomalyco/opencode /tmp/opencode-core
cd /tmp/opencode-core
git sparse-checkout set --cone packages/core
git checkout dev
cd -
mkdir -p vendor/opencode-tui/core-shim
```

- [ ] **Step 2: Copy the four known entry files, preserving their relative paths**

Run:
```bash
mkdir -p vendor/opencode-tui/core-shim/global \
  vendor/opencode-tui/core-shim/effect \
  vendor/opencode-tui/core-shim/flag \
  vendor/opencode-tui/core-shim/installation
cp /tmp/opencode-core/packages/core/src/global.ts vendor/opencode-tui/core-shim/global.ts
cp /tmp/opencode-core/packages/core/src/effect/app-node-builder.ts vendor/opencode-tui/core-shim/effect/app-node-builder.ts
cp /tmp/opencode-core/packages/core/src/flag/flag.ts vendor/opencode-tui/core-shim/flag/flag.ts
cp /tmp/opencode-core/packages/core/src/installation/version.ts vendor/opencode-tui/core-shim/installation/version.ts
```

- [ ] **Step 3: Add a path alias so vendored TUI code resolves `@opencode-ai/core/*` to the shim**

Edit `vendor/opencode-tui/tsconfig.json`, add (or merge into an existing)
`compilerOptions.paths`:

```json
{
  "compilerOptions": {
    "paths": {
      "@opencode-ai/core/*": ["./core-shim/*"]
    }
  }
}
```

- [ ] **Step 4: Run typecheck, vendor whatever it points at, repeat**

Run: `cd vendor/opencode-tui && bun install && bun run typecheck; cd -`

Expected on the first run: errors like `Cannot find module
'@opencode-ai/core/config' or its corresponding type declarations` (the exact
module names depend on what `global.ts` actually imports — read the error,
`cp` that specific file from `/tmp/opencode-core/packages/core/src/<path>`
into the matching `vendor/opencode-tui/core-shim/<path>`, and re-run).

Repeat until one of two outcomes:
- **(a)** `bun run typecheck` passes — record the final file list vendored
  under `core-shim/` in `UPSTREAM.md` (Task 2's file, append a list).
- **(b)** the transitive closure clearly balloons past ~15-20 files or pulls
  in something structurally heavy (a database layer, a full config schema
  system, etc.) — **stop vendoring and flag it**: this is the Phase 1 risk
  the spec called out (whether the TUI is really cheap to decouple from
  opencode's core). Report this back rather than continuing to vendor
  indiscriminately; it changes the Phase 2 plan (adapter shape) materially.

- [ ] **Step 5: Clean up and commit**

```bash
rm -rf /tmp/opencode-core
git add vendor/opencode-tui/core-shim vendor/opencode-tui/tsconfig.json vendor/opencode-tui/UPSTREAM.md
git commit -m "chore: vendor minimal @opencode-ai/core slice for TUI entrypoint"
```

---

## Task 5: Install dependencies

**Files:** none (generates `vendor/opencode-tui/bun.lock`)

- [ ] **Step 1: Install**

Run: `cd vendor/opencode-tui && bun install && cd -`
Expected: exits 0, creates `vendor/opencode-tui/bun.lock` and
`vendor/opencode-tui/node_modules/`.

- [ ] **Step 2: Add the lockfile and a `.gitignore` for `node_modules`**

Create `vendor/opencode-tui/.gitignore`:
```
node_modules/
```

Run:
```bash
git add vendor/opencode-tui/.gitignore vendor/opencode-tui/bun.lock
git commit -m "chore: lock opencode TUI vendor dependencies"
```

---

## Task 6: Write the launch script

**Files:**
- Create: `vendor/opencode-tui/bin/launch.ts`

This mirrors upstream's `packages/cli/src/tui.ts` `runTui()` function exactly
(fetched during spec research) — same shape, reading connection info from
environment variables instead of opencode's own CLI arg parser (which we
haven't vendored).

- [ ] **Step 1: Write `vendor/opencode-tui/bin/launch.ts`**

```typescript
import { run } from "../src/app"
import { TuiConfig } from "../src/config"
import { Effect } from "effect"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { Global } from "@opencode-ai/core/global"

const url = process.env.OPENCODE_TUI_URL
if (!url) {
  console.error("OPENCODE_TUI_URL is not set. Start `opencode serve` first, then:")
  console.error('  OPENCODE_TUI_URL="http://127.0.0.1:4096" OPENCODE_TUI_PASSWORD="..." bun run bin/launch.ts')
  process.exit(1)
}

const password = process.env.OPENCODE_TUI_PASSWORD

const config = TuiConfig.resolve({}, { terminalSuspend: false })

const program = run({
  url,
  headers: password ? { authorization: `Bearer ${password}` } : undefined,
  args: {},
  config,
  pluginHost: {
    async start() {},
    async dispose() {},
  },
}).pipe(Effect.provide(AppNodeBuilder.build(Global.node)))

Effect.runPromise(program).catch((error) => {
  console.error("TUI exited with error:", error)
  process.exit(1)
})
```

Note: the exact auth header shape (`authorization: Bearer ...` vs a custom
header) is a guess based on `serve.ts` generating a "password" — if the
vendored TUI's SDK client rejects it in Task 7's smoke test, check
`vendor/opencode-tui/src/context/sdk.tsx`'s `headers` usage and
`node_modules/@opencode-ai/sdk`'s client code for the real expected header
name, and fix this file accordingly. This is exactly the kind of integration
detail the spike exists to surface.

- [ ] **Step 2: Add a launch script to the vendor's own `package.json`**

Edit `vendor/opencode-tui/package.json`, add to `"scripts"`:
```json
"start": "bun run bin/launch.ts"
```

- [ ] **Step 3: Commit**

```bash
git add vendor/opencode-tui/bin vendor/opencode-tui/package.json
git commit -m "chore: add opencode TUI vendor launch script"
```

---

## Task 7: Root-level launch convenience + local test backend

**Files:**
- Modify: `package.json:46-54` (the `"scripts"` block)

- [ ] **Step 1: Add a root script**

In this repo's root `package.json`, add to `"scripts"`:
```json
"tui:opencode": "cd vendor/opencode-tui && bun run start"
```

- [ ] **Step 2: Install the published opencode CLI as a devDependency (test fixture only)**

Run: `npm install --save-dev opencode-ai@1.18.10`

This is used **only** to run `opencode serve` locally as something real for
our forked TUI to talk to — it is never imported by our code or vendored.

- [ ] **Step 3: Commit**

```bash
git add package.json package-lock.json
git commit -m "chore: add tui:opencode launch script + opencode-ai test fixture"
```

---

## Task 8: Manual smoke test (the actual go/no-go gate)

**Files:** none — this is verification, not code.

- [ ] **Step 1: Start the local opencode server**

Run (in one terminal, leave it running): `npx opencode serve`
Expected: prints something like `server listening on http://127.0.0.1:4096`
and a password/token. Copy both.

- [ ] **Step 2: Launch the vendored TUI against it, in PowerShell**

Run (in a second terminal):
```powershell
$env:OPENCODE_TUI_URL = "http://127.0.0.1:4096"
$env:OPENCODE_TUI_PASSWORD = "<paste the password from Step 1>"
npm run tui:opencode
```
Expected: the opencode TUI shell renders in the terminal (logo, empty
session/prompt view) without crashing. Take a screenshot or copy the
rendered frame into your task notes either way (pass or fail).

- [ ] **Step 3: Repeat in git-bash**

Run:
```bash
export OPENCODE_TUI_URL="http://127.0.0.1:4096"
export OPENCODE_TUI_PASSWORD="<paste the password from Step 1>"
npm run tui:opencode
```
Expected: same as Step 2. This is this project's other primary dev shell
(per the environment) — both must be checked, not just one.

- [ ] **Step 4: Record the outcome in `UPSTREAM.md`**

Append a `## Phase 1 smoke test result` section to
`vendor/opencode-tui/UPSTREAM.md` stating pass/fail for both shells, the date,
and — if it failed — the exact error output. This is the evidence the go/no-go
call on the rest of the vendoring project (Phases 2-4) gets made from; don't
skip recording a failure just because it's disappointing.

- [ ] **Step 5: Stop the `opencode serve` process** (Ctrl+C in its terminal)

- [ ] **Step 6: Commit the smoke test record**

```bash
git add vendor/opencode-tui/UPSTREAM.md
git commit -m "docs: record phase 1 smoke test result"
```

---

## Self-review notes (from writing this plan)

- **Spec coverage**: every "in scope" bullet from the phase-1 spec has a task
  — Bun toolchain (Task 1), forked TUI source (Task 3), forked minimal core
  (Task 4), published deps via Bun (Task 3/5), running against a real backend
  (Task 8), launch script not wired into default `upstage` bin (Task 7 adds
  it as a separate `tui:opencode` script, `src/cli/index.mjs` untouched).
  The spec's Windows-rendering risk is explicitly the subject of Task 8.
- **Known soft spots flagged inline, not hidden**: Task 4's core-shim
  transitive closure and Task 6's auth header shape are genuine unknowns this
  spike exists to resolve — each has a concrete "if X, do Y" fallback rather
  than a placeholder, and Task 4 has an explicit stop-and-report condition if
  the closure balloons.
