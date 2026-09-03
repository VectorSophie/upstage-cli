# Third-party notices

Everything in this `skills/` directory is upstage-cli's own MIT-licensed
code **except** the 19 skills listed below, which are adapted from
[NomaDamas/k-skill](https://github.com/NomaDamas/k-skill) — reused rather
than re-invented, per `docs/archive/skills-research-aug2026.md` §5 ("reuse an
existing, maintained, MIT-licensed library instead of writing our own
clone"). Each adapted `SKILL.md` also carries an inline attribution note
pointing at its exact source file.

## License (reproduced in full, as required by the MIT License)

```
MIT License

Copyright (c) 2026

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

Source: <https://github.com/NomaDamas/k-skill/blob/main/LICENSE>

## What was changed

Each adapted skill's *content* (`instruction.md` from the upstream repo)
was carried over close to verbatim — the real value is in that
instructional text. What changed to fit this project's `SkillsLoader`
(`src/skills/loader.mjs`):

- Upstream ships `SKILL.md` as an auto-generated stub that shells out to
  `npx @nomadamas/k-skill instruct <name>` at runtime for the actual
  instructions. That's a fine design for their own CLI-first product, but
  it adds a live network + npm-registry dependency every time a skill
  loads. We inlined the real `instruction.md` content directly into
  `SKILL.md` instead, so a loaded skill is self-contained and works
  offline once cloned.
- Frontmatter trimmed to the fields `SkillsLoader` actually models
  (`name`, `description`, `license`) — upstream's `metadata`/`profiles`
  fields aren't used here.
- Some skills (`korea-weather`, `nts-business-registration`, others)
  route through k-skill's own hosted proxy
  (`https://k-skill-proxy.nomadamas.org`) for convenience — that's
  upstream's infrastructure, not ours; the instructions are left honest
  about that dependency rather than hidden.

## Adapted skills (19)

| Skill | What it does |
|---|---|
| `ktx-booking` | KTX train ticket search/booking |
| `seoul-subway-arrival` | Seoul subway real-time arrival info |
| `korean-transit-route` | Korean public transit route planning |
| `nts-business-registration` | Business registration status/authenticity check (국세청) |
| `nts-tax-delinquency` | Tax delinquency status check (국세청) |
| `zipcode-search` | Korean postal code lookup |
| `korean-holiday-calendar` | Korean public holiday calendar |
| `k-dart` | DART corporate disclosure lookup (금감원) |
| `korean-stock-search` | Korean stock price/quote lookup |
| `lotto-results` | Lotto draw results and number matching |
| `k-schoollunch-menu` | School lunch menu lookup |
| `household-waste-info` | Household waste disposal rules/schedule by area |
| `fine-dust-location` | Fine dust (미세먼지) levels by location |
| `korea-weather` | Korea Meteorological Administration short-term forecast |
| `kbo-results` | KBO baseball results |
| `kleague-results` | K League soccer results |
| `korean-spell-check` | Korean spell/grammar checking |
| `korean-humanizer` | Detects and rewrites AI-sounding Korean prose |
| `housing-official-price` | Official/appraised housing price lookup |

Not all 150+ upstream skills were adapted — this is a curated subset
picked for broad usefulness and no heavy paid-API dependency, not a full
mirror. The remaining skills — plus updates to these 19 — are available
directly by installing the real thing:

```bash
npx --yes skills add NomaDamas/k-skill --all -g
```

which populates `.claude/skills/`, discovered by `SkillsLoader` ahead of
this bundled pack (project-local skills override same-named bundled
ones), so the real upstream version automatically takes precedence once
installed.
