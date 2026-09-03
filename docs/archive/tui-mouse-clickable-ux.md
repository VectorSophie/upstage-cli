# TUI mouse UX: drag-to-copy + clickable interface

Research + proposal for adding mouse-driven QoL to the OpenTUI app
(`src/ui/`). Two sources of truth were used: **reading OpenTUI's own type
definitions** (`node_modules/@opentui/core`, this exact pinned version, not
docs that may drift) and **reading opencode's actual source**
(`packages/tui/src/` in the cloned reference — same engine, a working
implementation we can compare against line by line). A handful of web
searches round out how the wider TUI ecosystem handles the same problem,
including two real historical bugs worth designing around.

## 0. Implementation status

Phases 1–2 below are implemented (`src/ui/App.mjs`, `Sidebar.mjs`,
`StatusBar.mjs`, locale files). One core piece is blocked by a confirmed
upstream engine bug, root-caused via isolated pty repro rather than assumed:

- ✅ **Ctrl+C / Escape / root `onMouseUp` copy infrastructure** — wired and
  correct (mirrors opencode's `Selection.copy`), reporting via the status
  line (`status.copiedToClipboard` / `status.copyUnsupported`).
- ✅ **Clickable Sidebar tabs** — click switches `activeSidebarTab`, same
  handler `p`/`c`/`t` call. Verified live via pty: clicking "컨텍스트"
  switches the bracket and swaps in the RepoMap panel.
- ✅ **Clickable StatusBar mode chip** — click cycles permission mode, same
  handler Shift+Tab calls. Verified live: click flipped `default` →
  `accept edits`.
- ❌ **Drag-to-select chat message text — blocked.** Text is `selectable`
  by default and the copy infrastructure above is ready for it, but
  selection can never *start* on text inside the chat `scrollbox` in this
  app. Root cause confirmed below — it's not a bug in anything we wrote.

### Confirmed engine limitation: `scrollbox` + a function-component tree

In `@opentui/core@0.5.1` (also currently `latest` — nothing newer to
upgrade to), a `scrollbox`'s descendant renderables stop being hit-testable
the moment the render tree is mounted through a React **function
component** — which every real app, including this one, is. A plain `box`
does not have this problem; it's specific to `scrollbox`.

This was isolated with an escalating series of throwaway pty repros (mouse
sequences fed via a raw `pty` + a debug-logging OpenTUI script, the same
technique used earlier in this project to root-cause the divider-border and
Tab-key issues), not assumed from reading source:

1. A `scrollbox` → `box` → `text` tree passed **directly** to
   `root.render(React.createElement(...))` (no component boundary): mouse
   drag correctly starts a selection, `getSelectedText()` returns the
   dragged substring, copy fires. Confirmed with growing sibling arrays,
   `position:"relative"` + absolutely-positioned siblings (our sidebar
   overlay pattern), a `ref` on the scrollbox, `React.cloneElement` (what
   `ansiLines()`'s output goes through) — every variant worked.
2. The **exact same tree**, wrapped in nothing more than
   `function App() { return <that tree> }; root.render(<App/>)` — zero
   hooks, zero state — and the click never reaches anything below the
   `scrollbox`; only the scrollbox's own `onMouseDown` fires, `getSelection()`
   is always `null`. Ternary empty-state/message-list swapping, `key`-forced
   remounts, and seeding a permanent non-empty child were all tried as
   mitigations from our side; none changed the outcome.
3. The same function-component wrapper around a **plain `box`** (no
   `scrollbox`) instead: works fine. Scopes the bug precisely to `scrollbox`.

Practical consequence: this is not fixable by restructuring our component
tree (three different mitigation strategies were tried and ruled out) — it
needs an upstream fix. The copy/Ctrl+C/Escape wiring stays in place because
it's correct and inert until then, and it already works for any selectable
content outside the chat scrollbox. In the meantime, the modifier-key
bypass (§3 below — Option on iTerm2, Shift elsewhere) is the actual way to
copy chat text, which is why it's surfaced in `/help` rather than treated
as a fallback nobody needs. Revisit when bumping the `@opentui/core` pin is
ever a deliberate, tested step (project policy — see the OpenTUI-rewrite
plan's addendum on pinning) rather than before then.

## 1. What our engine already gives us for free

OpenTUI (`@opentui/core@0.5.1`, our pinned version) ships a full mouse and
selection stack — we are not building this from scratch, we're wiring it up:

- **Mouse events**, on every `Renderable` via props: `onMouse`, `onMouseDown`,
  `onMouseUp`, `onMouseMove`, `onMouseDrag`, `onMouseDragEnd`, `onMouseDrop`,
  `onMouseOver`, `onMouseOut`, `onMouseScroll` (`Renderable.d.ts`). Same
  family as our existing `onKeyboard`-style props — no new mental model.
- **Mouse capture is on by default.** `createCliRenderer`'s `useMouse` option
  defaults to `true` (confirmed in the compiled source, `_useMouse = true`).
  We never set it, so it's already active — we just aren't listening to
  anything yet (`grep -rn "onMouse" src/ui/` returns nothing today).
- **A real Selection system**, not per-component reinvention: `Selection`
  class tracks anchor/focus/dragging state and *which renderables are
  touched*, `renderer.getSelection()` / `.clearSelection()` /
  `.startSelection()` / `.updateSelection()` at the top level, and
  `getSelectedText()` returns the flattened selected text across every
  renderable the drag touched (`lib/selection.d.ts`, `renderer.d.ts`).
  `selectable` is a renderable-level opt-in/out flag.
- **A `Clipboard` class with OSC 52 built in**: `copyToClipboardOSC52(text)`,
  `clearClipboardOSC52()`, `isOsc52Supported()` — and terminal capability
  detection (`TerminalCapabilities.osc52_support: "unsupported" | ...`) so we
  can know *in advance* whether copy will work, not just fire-and-hope
  (`lib/clipboard.d.ts`, `types.d.ts`). This means **we don't need to
  hand-roll OSC 52 the way opencode did** (see §2) — it's a native binding
  call, zero new dependencies.
- **Cursor shapes**: `MousePointerStyle = "default" | "pointer" | "text" |
  "crosshair" | "move" | "not-allowed"`, settable per-renderable or globally
  (`types.d.ts`). Lets clickable things actually *look* clickable when the
  terminal supports shape changes.

Open question, not answered by the `.d.ts` files (they're thin wrappers over
native Zig calls): **does `copyToClipboardOSC52` handle the tmux/screen
passthrough wrapping** (`\x1bPtmux;\x1b<seq>\x1b\\`) that raw OSC 52 needs
when running inside a multiplexer? opencode's hand-rolled version does this
explicitly (§2) because it predates/bypasses this API. Needs a live check
inside `tmux` before we depend on it — flagged in §5.

## 2. Prior art: opencode's actual implementation

opencode runs on the same engine, one version ahead, and has shipped this
already. Reading `packages/tui/src/` directly (not their docs, which don't
cover this) gives us a concrete, working pattern instead of a guess:

**Drag-to-copy is real and it's automatic** — not Ctrl+C-only. From
`app.tsx`:
```tsx
onMouseUp={() => Selection.copy(renderer, toast, clipboard)}
onMouseDown={(evt) => {
  if (evt.button !== MouseButton.RIGHT) return
  Selection.copy(renderer, toast, clipboard)
}}
```
Release the mouse after dragging a selection → it copies immediately, no
keyboard step required, plus a toast ("Copied to clipboard"). Right-click
also copies the current selection (a secondary gesture, not a context menu).
Ctrl+C is wired too, but as a **redundant fallback** — `handleSelectionKey`
only acts on Ctrl+C, Escape (clears selection), or defers to the focused
input's own selection if that's what's active. The whole thing sits behind
a flag (`OPENCODE_EXPERIMENTAL_DISABLE_COPY_ON_SELECT`, default *off*,
i.e. copy-on-release is the default behavior) — worth noting since it tells
us they consider it correct-by-default but still want an escape hatch.

**Clipboard writing is belt-and-suspenders** (`clipboard.ts`): every write
does **both** OSC 52 *and* a shelled-out native command (`osascript` on
macOS, `wl-copy`/`xclip`/`xsel` on Linux depending on Wayland vs X11,
PowerShell's `Set-Clipboard` on Windows/WSL), falling back to the
`clipboardy` npm package if none of those binaries exist. OSC 52 alone isn't
trusted — some terminals disable it by default (iTerm2, until a setting is
flipped — see §4) or don't support it. Their OSC 52 write also explicitly
detects `$TMUX`/`$STY` and wraps the sequence for passthrough:
```ts
process.env.TMUX || process.env.STY ? `\x1bPtmux;\x1b${sequence}\x1b\\` : sequence
```

**Clickable list items** (`ui/dialog-select.tsx`) follow one consistent
pattern we should copy: `onMouseOver` moves the keyboard-style highlight
cursor to the hovered row, `onMouseUp` triggers selection, `onMouseDown`
also nudges the cursor (covers click-without-hover), and a piece of state
(`store.input = "mouse"`) tracks whether the user's last input was mouse or
keyboard so the two don't fight over which row looks "active."

**Clickable links** (`ui/link.tsx`) are a two-line pattern: a `<text>` with
`onMouseUp={() => open(props.href).catch(() => {})}` using the `open` npm
package to launch the URL in the system browser.

**Collapsible sections** (`feature-plugins/sidebar/files.tsx`): a `<box
onMouseDown={() => setOpen(x => !x)}>` around a header — the same
click-to-toggle affordance our own Sidebar tabs are a natural fit for.

## 3. The wider ecosystem

- **lazygit does *not* support mouse text selection**, and its own
  maintainers point users at the terminal's own bypass instead of building
  it in-app ([discussion #5034](https://github.com/jesseduffield/lazygit/discussions/5034)).
  This surfaces the one convention every terminal-mouse-capturing app has to
  reckon with: **holding a modifier key restores the terminal emulator's own
  native selection**, bypassing the app's mouse capture entirely — Option on
  iTerm2, Shift on Ghostty/Windows Terminal/GNOME Terminal/kitty/most
  others. Worth surfacing this ourselves (in `/help` and status hints) as a
  safety net regardless of what we build — a user who doesn't know it exists
  has no way to select text if our own selection has a gap or bug.
- **Claude Code's "fullscreen rendering" mode does effectively the same
  thing we're proposing**: alternate-screen rendering, mouse wheel scroll,
  and "selected text copies to the clipboard automatically on mouse
  release" via OSC 52 ([docs](https://code.claude.com/docs/en/fullscreen)).
  Validates the overall shape of the plan — this isn't a novel UX, it's
  catching up to what the same class of tool already does.
- **Two real bugs worth designing around from day one**, both filed against
  Claude Code's implementation of this exact feature:
  - [#41954](https://github.com/anthropics/claude-code/issues/41954) — "TUI
    selection spams clipboard on every render during streaming." Directly
    relevant to us: our event-consumption loop re-renders on every
    `stream_token` (batched, but still frequently) while the agent is
    talking. **Copy must fire only on an actual new mouse-up/selection-end
    event, never as a side effect of a re-render** — the copy handler has to
    be wired to the mouse event, not to a `useEffect` watching selection
    state, or a re-render mid-drag could re-fire it.
  - [#63054](https://github.com/anthropics/claude-code/issues/63054) /
    [#63061](https://github.com/anthropics/claude-code/issues/63061) — OSC
    52 emission silently breaking inside tmux across a couple of point
    releases. Confirms the tmux-wrapping detail in §2 isn't a nice-to-have,
    it's the difference between "works" and "silently does nothing" for
    every tmux user.
  - iTerm2 blocks OSC 52 by default (`Settings → General → Selection →
    "Applications in terminal may access clipboard"` must be enabled) —
    another reason not to rely on OSC 52 alone, and a reason to use
    `isOsc52Supported()` to show a hint rather than fail silently when it's
    off.
- **Standard mouse reporting (SGR 1006 / xterm mouse mode) is broadly
  supported** across the terminals we'd expect our users on — WezTerm,
  iTerm2, kitty, Windows Terminal, GNOME Terminal, tmux passthrough. Not a
  blocker; OpenTUI's mouse parser already speaks both SGR and the legacy
  basic mouse protocol (`lib/parse.mouse.d.ts` — `parseSgrSequence` /
  `parseBasicSequence`).
- **Click-to-position-cursor in a text input is a known hard/low-ROI item**
  — there's an [open feature request against Claude Code itself](https://github.com/anthropics/claude-code/issues/27561)
  asking for exactly this in its composer, still unresolved. Good signal
  that it's not a quick win; scoped as a stretch goal below, not core.

## 4. What to build, mapped to our actual files

Phased by cost/value, cross-referenced to the files that changed. Status
per phase reflects what's actually landed (§0), not just proposed.

### Phase 0 — verify what we already get, build nothing (done)
1. `SessionBrowser.mjs`'s/`RepoMap.mjs`'s `select` intrinsic — not
   re-verified separately; out of scope once §0's scrollbox finding
   surfaced (they don't use `scrollbox`, so unaffected by that bug, and
   `select` is a distinct core primitive with its own click handling).
2. `renderer.isOsc52Supported()` / tmux passthrough — not yet checked live
   inside `tmux`; still an open item, tracked in §5.
3. Mouse mode itself: confirmed live via pty — `useMouse`'s default `true`
   actually enables `?1000h`/`?1002h`/`?1003h`/`?1006h` on startup (SGR
   mouse + button/any-event tracking), not just declared in the type defs.

### Phase 1 — chat-pane text selection + copy (done, but blocked — see §0)
- Chat message text is `selectable` by default (confirmed:
  `TextBufferRenderable`'s own `_defaultOptions`) — no explicit prop needed.
- `onMouseUp` wired on the root app box (`App.mjs`) mirroring opencode's
  `Selection.copy`: reads `renderer.getSelection()`, writes via
  `renderer.copyToClipboardOSC52()`, reports success/failure through
  `statusKey` (`status.copiedToClipboard` / `status.copyUnsupported` — no
  toast system here, so the existing status line is the equivalent), then
  `clearSelection()`.
- Ctrl+C wired as the redundant explicit-copy path.
- Escape checks for an active selection **first** (clears it and returns)
  before falling through to the existing double-Escape-rewind logic — same
  ordering-bug class as the pane-shortcuts-vs-composer-autofocus issue
  fixed earlier in this codebase; not reintroduced here.
- Streaming-spams-clipboard guard (§3) satisfied structurally: copy only
  ever fires from the mouse-up/Ctrl+C handlers, never from a `useEffect`
  reacting to selection state.
- **What doesn't work**: the actual drag-to-select never starts, because of
  the `scrollbox` + function-component engine bug in §0. All of the above
  is correct and ready — it activates automatically once that's fixed
  upstream, no changes needed on our side.

### Phase 2 — clickable Sidebar + StatusBar (done, verified live)
- `Sidebar.mjs`: `onMouseUp` on each tab label calls the same
  `setActiveSidebarTab` the `p`/`c`/`t` shortcuts call, plus
  `renderer.setMousePointer("pointer"/"default")` on hover in/out. Verified
  via pty: clicking "컨텍스트" moves the `[...]` bracket and swaps in the
  RepoMap panel.
- `StatusBar.mjs`: click the mode chip (`▶ default` etc.) calls the same
  `nextMode()` Shift+Tab calls, same hover-cursor treatment. Verified via
  pty: click flipped `default` → `accept edits`.
- `RepoMap.mjs` tree rows: **not applicable** — our `RepoMap` renders a flat
  filtered list via OpenTUI's native `select` intrinsic, not a grouped tree
  with expand/collapse the way opencode's `files.tsx` does; there's no
  "collapsible section" concept in our actual implementation to wire.

### Phase 3 (stretch, lower priority) — nice-to-haves, not started
- Composer click-to-position-cursor — per §3, a known hard problem even for
  Claude Code itself. Time-box it; land Phase 1/2 first.
- Clickable links in tool output/diffs (URLs, file paths) opening in
  `$EDITOR`/browser, mirroring opencode's `Link` component. Needs an `open`
  equivalent — check if a zero-dependency `spawnSync` of the platform opener
  (`xdg-open`/`open`/`start`) covers it before adding a package (we already
  do exactly this pattern for `$EDITOR` in `App.mjs`'s
  `openExternalEditor`).

### Explicitly not doing (for now)
- The native-OS-clipboard-command fallback opencode carries (`osascript`/
  `wl-copy`/`xclip`/`xsel`/PowerShell + `clipboardy`). Start with OSC 52
  only — it's a zero-dependency native call our engine already provides, vs.
  opencode's version which had to build all of that *because* Ink never gave
  them an OSC 52 primitive. Revisit only if real usage shows OSC 52 alone
  isn't enough (a specific terminal's default-off setting, tmux edge case
  found in Phase 0, etc.) — don't pre-build the belt-and-suspenders version
  for a gap we haven't confirmed we have.
- A context-menu-style right-click. opencode uses right-click as a second
  *copy* trigger, not a menu — same scope here if we add it at all.

## 5. Remaining open questions

1. **The `scrollbox` engine bug (§0)** — the actual blocker. Options once
   it's worth spending more time on: (a) wait for an upstream `@opentui/core`
   fix and bump the pin deliberately when one lands; (b) file it upstream
   with the repro steps from §0 (not yet done); (c) as a last resort,
   investigate whether a hand-rolled scroll container (plain `box` +
   manual `scrollTop`/viewport math, giving up `scrollbox`'s built-in
   virtualization/sticky-scroll) would sidestep it — not attempted, a much
   bigger change than this feature warrants on its own.
2. **tmux OSC 52 passthrough** — does `renderer.copyToClipboardOSC52`
   already wrap for `$TMUX`/`$STY`, or do we need a thin shim like
   opencode's? Native/Zig-side, not visible from the `.d.ts` files or
   grepping the JS bundle, and moot until §0's blocker is resolved (nothing
   to copy from the chat pane yet) — still worth a live check once that's
   fixed, or sooner if selectable content lands elsewhere (e.g. inside a
   dialog) that isn't blocked by the scrollbox bug.
3. **"Copied to clipboard" confirmation** — resolved: reused the existing
   `statusKey`/`StatusBar` slot (`status.copiedToClipboard`/
   `status.copyUnsupported`) rather than building a toast system, same
   pattern as `sessionRewound`/`languageChanged` etc.

## References

- [OpenTUI core, pinned `@opentui/core@0.5.1`] — `node_modules/@opentui/core/{Renderable,renderer,types}.d.ts`, `lib/{selection,clipboard,parse.mouse}.d.ts` (this repo).
- [opencode source, cloned reference] — `packages/tui/src/{app.tsx,clipboard.ts,util/selection.ts,context/clipboard.tsx,ui/{dialog-select,link}.tsx,feature-plugins/sidebar/files.tsx}`.
- [lazygit mouse text selection discussion #5034](https://github.com/jesseduffield/lazygit/discussions/5034)
- [Claude Code fullscreen rendering docs](https://code.claude.com/docs/en/fullscreen)
- [Claude Code #41954 — selection spams clipboard during streaming](https://github.com/anthropics/claude-code/issues/41954)
- [Claude Code #63054 / #63061 — OSC 52 broken in tmux (regression)](https://github.com/anthropics/claude-code/issues/63054)
- [Claude Code #27561 — composer click-to-position feature request, open](https://github.com/anthropics/claude-code/issues/27561)
