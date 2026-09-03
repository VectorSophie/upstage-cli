# Skills / "K-Skills" deep dive — August 2026

> **Status note (2026-09-03):** the proposal below has since shipped —
> `src/skills/loader.mjs` implements Agent Skills format interop, and a
> bundled first-party pack exists (test suite references 19 adapted k-skill
> imports; the v3.0.0 CHANGELOG entry references 24 first-party skills
> total). This doc's design reasoning is still useful background for why
> the pack looks the way it does; treat "nothing implemented yet" below as
> historical, not current.

Follow-up to `new-concepts-aug2026.md`, going deep on one specific idea: a
built-in skills library, Korean-flavored. Short answer up front: **"K-Skills"
already exists as a real, named, MIT-licensed project** — building our own
lifestyle-automation clone of it would be redundant. The actually valuable,
buildable thing is different and better: **become compatible with the
open Agent Skills format that k-skill (and 2,000+ other community skills)
already ship in, then add a small first-party pack for the one niche
nobody else covers — Korean *developer/backend* workflows.** Full reasoning
below.

## 1. Prior art — this space is not empty

- **[NomaDamas/k-skill](https://github.com/NomaDamas/k-skill)** — the real
  "k-skill." 150+ skills automating Korean *consumer/lifestyle* tasks: SRT/KTX
  booking, KBO scores, lotto results, KakaoTalk archive search, Seoul subway
  arrivals, HWP read/edit/convert, DART filings, business-registration
  verification, LH/SH housing announcements, patent/court-record search, and
  more. MIT-licensed core (AGPL-3.0-only for one proxy-server component).
  Installed via `npx --yes skills add NomaDamas/k-skill --all -g`, invoked in
  Claude Code / Codex / OpenCode as `/k-skill:lotto-results`-style namespaced
  skills. It literally already targets the coding-agent audience, just for
  life-admin tasks, not dev tasks.
- **[DaleSeo/korean-skills](https://github.com/DaleSeo/korean-skills)** —
  narrower: Korean-language humanization/grammar-checking skills for agent
  output, also in the Agent Skills format.
- **[bear2u/my-skills](https://github.com/bear2u/my-skills)** — one Korean
  developer's personal Claude Code skill collection: `nextjs15-init`,
  `flutter-init`, `frontend-design`, `codex-claude-loop` (dual/triple-agent
  review loops), `landing-page-guide`, changelog/prompt-coach tooling. Closer
  to our audience (devs, not consumers) but personal/opinionated, not a
  curated library.
- **[J-nowcow/awesome-korean-agent-skills](https://github.com/J-nowcow/awesome-korean-agent-skills)**
  — an index aggregating 400+ of the above across repos, by function.

None of these are dev-*infrastructure*-focused (payments, cloud, deployment,
compliance) — they're either consumer-lifestyle or one person's grab-bag.
That gap is real and is where a first-party pack of ours would actually add
something nobody else has, rather than re-doing k-skill's job worse.

## 2. The technical standard underneath all of it: Agent Skills / `SKILL.md`

This is the part worth adopting regardless of what we build on top. Per
[Webfuse's cheat sheet](https://www.webfuse.com/agent-skills-cheat-sheet) and
cross-checked against the repos above, a skill is a directory:

```
my-skill/
├── SKILL.md          # required: YAML frontmatter + Markdown instructions
├── scripts/           # optional: Python (PEP 723), Bash, Deno, Bun, Ruby, Go
├── references/        # optional: docs loaded only when the skill needs them
└── assets/             # optional: templates, diagrams
```

Frontmatter: `name` (≤64 chars, lowercase/digits/hyphens, must match the
folder name) and `description` (≤1024 chars, imperative, says what it does
*and when to use it*) are required. Optional: `license`, `compatibility`,
`metadata` (client-specific key/values), `allowed-tools` (experimental —
pre-approved tool list, directly relevant to our policy engine). Unknown
frontmatter fields are a hard validation error, which is what makes the
format actually portable instead of vendor-diverging.

**The invocation model is the important part, and it's not what our
`/recipe run <name>` does today**: a 3-tier load —

1. **Catalog** (agent startup): only `name` + `description` for every
   discovered skill, ~50-100 tokens each, folded into the system prompt.
2. **Instructions** (activation): full `SKILL.md` body loaded only once the
   current task's description plausibly matches — the model decides this,
   not the user typing a slash command.
3. **Resources** (execution): `scripts/`/`references/`/`assets/` loaded only
   if the instructions actually reference them.

This is *autonomous* invocation — the whole point is the model reaches for
`k-skill:srt-booking` on its own when a user says "책 예매 좀 해줘," without
the user knowing the skill name exists. Our `/recipe` is 100% manual
(`/recipe run add-endpoint method=GET`) — useful for a different case
(a user's own saved macros) but not the same feature.

By mid-2026 this format is genuinely load-bearing infrastructure, not a toy:
official `anthropics/skills` repo, 2,000+ skills across community
marketplaces, and Vercel's `skills.sh` API (GA June 5, 2026) indexing
~600,000 open-source skills — see
[Developers Digest](https://www.developersdigest.tech/blog/claude-code-skills-marketplace-launch)
and the skills.sh coverage in the earlier search pass.

## 3. Agent Plugins 1.0 — real, very new, not yet worth building against

Published by a Technical Steering Committee spanning **Amazon, Cursor,
Microsoft, OpenAI, and Vercel** (Google just joined as a Core Maintainer,
per [Google's own announcement](https://developers.googleblog.com/agent-plugins-package-your-skills-tools-and-more/)).
It's a thin wrapper: one `plugin.json` manifest, a fixed `skills/`
subdirectory (each skill still just an Agent-Skills-format folder), plus an
`mcp.json` declaring MCP servers with explicit transport types. The spec
deliberately punts on installation, distribution, permissions, sandboxing,
and trust — "each client handles these independently." Google's own clients
(Agents CLI, Data Agent Kit) are the first adopters; the announcement says
"more soon," which is a tell that broader-client support isn't there yet.

**Recommendation: build against plain `SKILL.md` (§2), not the Plugins 1.0
wrapper.** Every real skill in the wild today (k-skill, bear2u, the 2,000+
community skills) is a bare `SKILL.md` folder; the wrapper is additive
packaging for bundling skills+MCP-config together, which we don't need since
we already load MCP servers through our own config path. Revisit if Plugins
1.0 client adoption broadens past Google's two products.

## 4. What we already have, and the actual gap

`src/core/recipes.mjs` (built last session) is structurally close but
answers a different question:

| | `/recipe` (ours, today) | Agent Skills (`SKILL.md`) |
|---|---|---|
| Storage | one flat JSON file per recipe | a directory (script/reference/asset support) |
| Discovery | user must know the name | model matches `description` against the task |
| Invocation | explicit `/recipe run name k=v` | autonomous, plus explicit is still fine |
| Interop | ours only | works in Claude Code, Codex, Copilot, OpenCode, and vice versa |
| Tool scoping | none | `allowed-tools` frontmatter, maps onto our policy engine |

They're not competing — recipes are still the right shape for a user's own
"save this exact prompt with placeholders" macro. Skills are the right shape
for "teach the agent a capability it should reach for on its own." Keeping
both, rather than collapsing one into the other, matches how the upstream
ecosystem itself keeps recipes/workflows (Goose) and skills (Claude Code)
as separate concepts.

## 5. Proposed direction (two independent, separately-shippable pieces)

**A. `SKILL.md` interop (the actual "built into the agent" ask).** Teach
`src/tools/registry.mjs` (or a new `src/core/skills.mjs` alongside
`recipes.mjs`) to discover `SKILL.md` folders under `.claude/skills/` (read
existing repos' skills for free — huge installed base already sits there)
and a `.upstage/skills/` equivalent, parse frontmatter, inject the
catalog tier into the system prompt (cheap, same place `UPSTAGE.md`
already gets folded in per `system-prompt.mjs`), and load the full body via
a tool call when a skill is selected — mirroring the 3-tier model instead of
inventing our own. `allowed-tools` slots directly into the existing policy
engine as a per-skill tool allowlist. **This one change makes k-skill's
entire 150-skill library usable in our CLI for zero additional work on our
part** — `npx skills add NomaDamas/k-skill --all -g` populates
`.claude/skills/`, and once we read that directory, "책 예매 좀 해줘" or "로또
번호 확인해줘" just works. That's the ponytail-correct move: reuse an
existing, maintained, MIT-licensed 150-skill library instead of writing our
own lifestyle-automation clone.

**B. A small, first-party "coding skills" starter pack** — filling the gap
§1 identified, not overlapping k-skill's lifestyle niche or bear2u's
personal grab-bag. Candidates, each a thin `SKILL.md` (prompted knowledge +
maybe a short script), not new hardcoded tools:
  - Toss Payments / 아임포트(PortOne) SDK integration patterns (the two
    dominant Korean PG providers — webhook verification, test-mode gotchas).
  - Kakao/Naver OAuth login integration (both have quirks — Kakao's REST
    API key vs. JavaScript key confusion is a constant real-world bug source).
  - Korean cloud deploy conventions (NHN Cloud, Naver Cloud Platform) —
    region/AZ naming, IAM differences from AWS that trip up agents trained
    mostly on AWS-shaped docs.
  - **Reframe our own Tier-1 work as skills, not just tools**: the Korean
    PII/PIPA checksum logic (`[[korean-pii-check]]`), Groundedness Check, and
    Document AI/embeddings tools are currently only reachable if the model
    already knows to call them. A skill whose *description* says "use this
    when handling Korean user data / verifying RAG answers / parsing scanned
    documents" is what actually gets the autonomous-invocation win described
    in §2 — right now those tools are invocable but not *discoverable* the
    way the 3-tier catalog model intends.

**Naming**: don't call our pack "k-skill" or "K-Skills" — that name is
already an established, specific, real project (§1) and reusing it would
read as impersonation, not homage. Something like an `upstage-skills`
starter pack, described plainly as "Korean dev-workflow skills," keeps
naming honest.

## 6. Open questions before building

- Does the model reliably self-select skills from a 50-100-token
  catalog-tier description alone, or does this need the same kind of
  relevance-floor logic `context-builder.mjs` already does for file
  snippets? Worth a small spike with 3-4 real skills before committing to
  the full registry integration.
- Where does skill-sourced content sit relative to `UPSTAGE.md`/`AGENTS.md`
  in the system prompt token budget, given compaction already triggers at
  80% usage (`context-builder.mjs`) — a large `.claude/skills/` directory
  (k-skill alone is 150 skills) needs the catalog tier to actually stay
  cheap in practice, not just in spec.
- Do we read `.claude/skills/` by default (maximum interop, zero setup) or
  require opt-in (avoids surprising a user who didn't intend those skills
  for this agent)? Leans toward default-on with an opt-out, since catalog
  entries are inert until the model chooses to activate one — same trust
  model the spec itself assumes.

Nothing implemented yet. This is deep-research-only, per the ask.
