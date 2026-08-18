import fs from 'fs';
import path from 'path';
import os from 'os';

export function loadUpstageMdFiles(cwd = process.cwd()) {
  const files = [];

  const globalPath = path.join(os.homedir(), '.upstage', 'UPSTAGE.md');
  if (fs.existsSync(globalPath)) {
    try {
      files.push({ source: 'global', content: fs.readFileSync(globalPath, 'utf-8') });
    } catch { /* skip */ }
  }

  const projectFiles = [];
  let dir = path.resolve(cwd);
  const root = path.parse(dir).root;
  while (dir !== root) {
    const candidates = [
      path.join(dir, 'UPSTAGE.md'),
      path.join(dir, '.upstage', 'UPSTAGE.md'),
    ];
    let foundUpstageMd = false;
    for (const f of candidates) {
      if (fs.existsSync(f)) {
        foundUpstageMd = true;
        try {
          projectFiles.push({ source: dir, content: fs.readFileSync(f, 'utf-8'), path: f });
        } catch { /* skip */ }
      }
    }
    // AGENTS.md interop (docs/feature-landscape-2026.md §3.1): a fallback,
    // not a merge — it's the Linux-Foundation-stewarded convention 30+
    // agents (Codex, Claude Code, Cursor, Aider, Devin...) already read, so
    // upstage-cli works in any repo that already has one. UPSTAGE.md stays
    // primary; only checked when this directory level has no UPSTAGE.md.
    if (!foundUpstageMd) {
      const agentsPath = path.join(dir, 'AGENTS.md');
      if (fs.existsSync(agentsPath)) {
        try {
          projectFiles.push({ source: dir, content: fs.readFileSync(agentsPath, 'utf-8'), path: agentsPath });
        } catch { /* skip */ }
      }
    }
    dir = path.dirname(dir);
  }

  projectFiles.reverse();
  files.push(...projectFiles);
  return files;
}

export function buildSystemPrompt({ cwd, tools, override, addDirs, language, skills } = {}) {
  if (override) {
    return { staticPrefix: override, dynamicSuffix: '', full: override };
  }

  // Beyond "respond in Korean," the two things a Korean-first coding
  // assistant actually needs and previously had no guidance for at all:
  // which words stay in English (so it doesn't flip-flop turn to turn)
  // and which register to hold (so it doesn't read as inconsistent between
  // casual and formal). Pulled from Solar Pro2's own prompting handbook's
  // instruction-specificity guidance (docs/feature-landscape-2026.md §5) —
  // "good Korean" is not a self-evident requirement, it needs the same
  // concrete criteria the handbook asks for everywhere else.
  const langInstruction = language === 'en'
    ? 'Always respond in English.'
    : [
        'Korean-first: respond in Korean by default unless the user writes in English.',
        'Keep standard technical/dev terms in English as used in the industry (commit, merge, branch, pull request, ' +
          'deploy, refactor, etc.) rather than translating them — do not switch a term between English and Korean ' +
          'across turns.',
        'Hold a consistent professional register throughout a session: 합쇼체/하십시오체 (e.g. "확인했습니다", ' +
          '"수정하겠습니다"), not a mix of that and casual 해요체 within the same conversation.'
      ].join(' ');

  const parts = [
    `You are upstage-cli, an agentic coding assistant. ${langInstruction}`,
    'You have tools available. Use them immediately to perform actions — do not describe what you would do, just do it.',
    'Read files with read_file before discussing them. Write files with write_file. Run tests with run_tests.',
    // MUST/NEVER-style emphasis for the two constraints most worth never
    // silently dropping — the handbook's own §5 finding is that Solar Pro2
    // responds measurably to this vocabulary for non-negotiable rules,
    // not just plain declarative sentences.
    'CRITICAL — MUST verify, NEVER fabricate: always call read_file before discussing a file\'s contents, and NEVER ' +
      'invent file contents or claim to have written something without actually calling write_file/edit_file. If a ' +
      'claim about code or a document is uncertain, say so explicitly (or use check_groundedness) rather than assert it.',
  ];

  const mdFiles = loadUpstageMdFiles(cwd);

  if (addDirs) {
    for (const dir of addDirs) {
      const p = path.join(dir, 'UPSTAGE.md');
      if (fs.existsSync(p)) {
        try {
          mdFiles.push({ source: dir, content: fs.readFileSync(p, 'utf-8') });
        } catch { /* skip */ }
      }
    }
  }

  for (const f of mdFiles) {
    parts.push(f.content);
  }

  // Agent Skills catalog tier (docs/skills-research-aug2026.md §2/§5): cheap
  // name+description list only, from the caller's already-loaded
  // SkillsLoader (src/skills/loader.mjs) — full instructions load lazily
  // via the load_skill tool once a task actually matches one, not injected
  // here. Built inline rather than re-scanning the filesystem per turn.
  if (Array.isArray(skills) && skills.length > 0) {
    const lines = skills.map((s) => `- ${s.name}: ${s.description}`);
    parts.push(`Skills available (call load_skill with the exact name when a task matches one, for full instructions):\n${lines.join('\n')}`);
  }

  // Repeat the language/register constraint at the end too, not just the
  // start — UPSTAGE.md/AGENTS.md content injected above can be long, and
  // the handbook's §5.2 finding is that important instructions get lost in
  // the middle of a long system prompt unless reinforced at both ends.
  if (mdFiles.length > 0) {
    parts.push(`(Reminder: ${langInstruction})`);
  }

  const staticPrefix = parts.join('\n\n');

  let dynamicSuffix = '';
  if (tools && tools.length > 0) {
    const toolSummary = tools
      .map((t) => `- ${t.function?.name || t.name}: ${(t.function?.description || t.description || '').slice(0, 100)}`)
      .join('\n');
    dynamicSuffix = `\n\nAvailable tools:\n${toolSummary}`;
  }

  return { staticPrefix, dynamicSuffix, full: staticPrefix + dynamicSuffix };
}
