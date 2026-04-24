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
    for (const f of candidates) {
      if (fs.existsSync(f)) {
        try {
          projectFiles.push({ source: dir, content: fs.readFileSync(f, 'utf-8'), path: f });
        } catch { /* skip */ }
      }
    }
    dir = path.dirname(dir);
  }

  projectFiles.reverse();
  files.push(...projectFiles);
  return files;
}

export function buildSystemPrompt({ cwd, tools, override, addDirs } = {}) {
  if (override) {
    return { staticPrefix: override, dynamicSuffix: '', full: override };
  }

  const parts = [
    'You are upstage-cli coding agent. Use tools for repository inspection and safe patch workflows. Always verify after apply_patch.',
    'Korean-first: respond in Korean by default unless the user writes in English.',
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
