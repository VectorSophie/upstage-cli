# New concepts & ideas — August 2026, part 2

Follow-up to `new-concepts-aug2026.md` (Solar Pro 4, standing subagents,
async orchestrator TUIs, cross-session memory, guardrails, Korean market
context — none of that repeated here). This pass specifically checked our
own dependencies and protocol implementations against what's shipped since,
rather than scanning for net-new product ideas. Sourced via live web search;
version/date claims are as reported by the cited sources, not re-verified
against upstream changelogs directly.

## 0. Urgent: our hand-rolled MCP client speaks a protocol version from launch day

**MCP shipped a major spec rewrite on 2026-07-28**
([spec blog](https://blog.modelcontextprotocol.io/posts/2026-07-28/),
[migration writeup](https://www.developersdigest.tech/blog/mcp-2026-07-28-breaking-changes))
that removes the `initialize`/`initialized` handshake and the
`Mcp-Session-Id` header entirely — MCP moves from a stateful,
session-pinned protocol to a stateless one where every request carries its
own protocol version and client identity. Old-style clients and new-style
servers are explicitly called out as **not interoperating cleanly** in
either direction.

Checked our own implementation: `src/tools/mcp/http-client.mjs` and
`stdio-client.mjs` hardcode

```js
const PROTOCOL_VERSION = "2024-11-05";
```

— the *first* MCP spec version, from before even the 2025-03-26 and
2025-06-18 revisions, let alone this one. Both clients do exactly the
handshake this rewrite removes (`initialize` → capture `Mcp-Session-Id` →
echo it on every request via the `Mcp-Session-Id` header,
`http-client.mjs:51-103`).

Impact today is limited — we're not built on the official
`@modelcontextprotocol/sdk` (there's no such dependency in `package.json`;
both clients are hand-rolled), and most servers still run older spec
versions with backward-compat windows. But this is the same shape of gap as
"we're one full model behind our own vendor" from the last pass: any MCP
server a user points us at that's been upgraded to speak only 2026-07-28
will fail to connect, silently or with a confusing handshake error, and
nothing in our error handling anticipates that failure mode specifically.

Recommend, in order of effort:
1. Bump `PROTOCOL_VERSION` to the current spec date and confirm our existing
   `initialize` handshake still round-trips against a 2026-07-28 server in
   backward-compat mode (the rewrite's deprecation policy gives old features
   a 12-month minimum window, so this alone likely buys real time without a
   rewrite).
2. Only if that compat window turns out shorter in practice than advertised:
   the stateless model is a real architecture change for `http-client.mjs`
   (no more session pinning, protocol version + client identity move into
   per-request `_meta`, `Mcp-Method`/`Mcp-Name` headers for routing) — not a
   drop-in, budget it as its own task rather than folding it into a
   version-bump PR.

## 1. Bun's Zig→Rust rewrite (1.4.0, July 2026) — dependency-stability flag, not an action item

[Multiple reports](https://grigio.org/bun-1-4-the-controversial-ai-driven-rewrite-from-zig-to-rust/)
describe Bun 1.4 as a full runtime rewrite from Zig to Rust, done via ~64
parallel Claude agents over about 11 days (~1M LOC), landing July 2026 with
~10% faster Linux startup. Notable given the TUI rewrite
(`docs/roadmap-tui-and-features.md` / the OpenTUI migration already merged)
made Bun a hard runtime requirement, not an option — `engines.bun >=1.3.0`.

Not recommending any action: the CHANGELOG entry for the OpenTUI migration
already pinned `@opentui/*` to an exact version specifically because that
ecosystem moves fast, and the same caution applies here. Just flagging that
our now-mandatory runtime had a same-quarter full-rewrite of its execution
core — worth a deliberate compatibility check (not a blind `bun upgrade`)
before bumping the `engines` floor past 1.3.x, and worth knowing about if a
user ever reports a Bun-specific crash that doesn't reproduce on an older
Bun.

## 2. Claude Code's plugin marketplace matured past the "don't build against it yet" call

`docs/skills-research-aug2026.md` explicitly recommended not building
against Agent Plugins 1.0 yet. Checking back: as of August 2026 the official
marketplace (`claude-plugins-official`) has
[55+ plugins](https://www.agensi.io/learn/claude-code-plugin-marketplace-guide),
a community marketplace with automated safety screening now exists
(`anthropics/claude-plugins-community`), and `/plugin install` picked up
reliability fixes (stale-catalog refresh + retry, immediate activation on
install). This project already has a `PluginLoader` reading
`.claude/plugins/*/skills/` — that groundwork is already compatible with
the marketplace convention, nothing to change. Just a note that the "wait
and see" call from the last research pass has less runway left than it did;
worth a shorter recheck interval than "next major pass" if plugin-format
compatibility ever becomes a support question.

## 3. Competitive CLI-agent scan (lighter signal, for context only)

- **GitHub Copilot CLI** added shared cloud sessions (host health/source
  switching, Codespaces + Mission Control support) and MCP/sandboxing/
  autocomplete/performance improvements this month.
- **Claude Sonnet 5** intro pricing ($2/$10 per 1M tokens) runs through
  August 31, 2026 — not directly relevant since this CLI is Solar-native,
  but worth knowing if anyone asks why we don't also route to Claude as a
  model option.

Nothing here rises to "worth building" on its own; logged for completeness
since the ask was a broad pass, not because any of it changes our roadmap.

## Suggested priority if any of this gets acted on

1. **§0 MCP protocol-version bump** — small, concrete, prevents a real
   future interop failure; same "overdue maintenance" shape as the Solar
   Pro 4 gap from the last pass and arguably higher urgency since it's a
   silent-failure risk rather than a missed-capability one.
2. **§1 Bun 1.4 compatibility check** — no code change, just verify before
   next `engines` bump.
3. **§2 plugin marketplace recheck** — no action now; shortens the "revisit
   later" timer already set by the last pass.
