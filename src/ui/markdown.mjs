import chalk from "chalk";

const NO_COLOR = !!process.env.NO_COLOR;

// Force full color support regardless of TTY detection (chalk v4 instance)
if (!NO_COLOR) chalk.level = 3;

// ANSI helpers — all pass through chalk so hex colors work
const A = {
  reset:     (s) => NO_COLOR ? s : chalk.reset(s),
  bold:      (s) => NO_COLOR ? s : chalk.bold(s),
  dim:       (s) => NO_COLOR ? s : chalk.dim(s),
  italic:    (s) => NO_COLOR ? s : chalk.italic(s),
  underline: (s) => NO_COLOR ? s : chalk.underline(s),
  cyan:      (s) => NO_COLOR ? s : chalk.cyan(s),
  green:     (s) => NO_COLOR ? s : chalk.green(s),
  magenta:   (s) => NO_COLOR ? s : chalk.magenta(s),
  yellow:    (s) => NO_COLOR ? s : chalk.yellow(s),
  blue:      (s) => NO_COLOR ? s : chalk.blue(s),
  gray:      (s) => NO_COLOR ? s : chalk.gray(s),
  red:       (s) => NO_COLOR ? s : chalk.red(s),
  hex:       (hex) => (s) => NO_COLOR ? s : chalk.hex(hex)(s),
};

// ─── Inline renderer ──────────────────────────────────────────────────────

export function renderInline(line) {
  if (!line) return "";
  let out = line;

  // Bold **text** or __text__
  out = out.replace(/\*\*(.+?)\*\*/g, (_, t) => A.bold(t));
  out = out.replace(/__(.+?)__/g, (_, t) => A.bold(t));

  // Italic *text* or _text_  (not inside bold markers)
  out = out.replace(/(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)/g, (_, t) => A.italic(t));
  out = out.replace(/(?<!_)_(?!_)(.+?)(?<!_)_(?!_)/g, (_, t) => A.italic(t));

  // Inline code `code`
  out = out.replace(/`([^`]+)`/g, (_, t) => A.cyan(t));

  // Link [text](url) — show text only with dim URL
  out = out.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, text, url) =>
    `${A.underline(text)} ${A.dim(`(${url})`)}`
  );

  return out;
}

// ─── Syntax highlighter ───────────────────────────────────────────────────

const JS_KEYWORDS = /\b(export|import|from|const|let|var|function|return|class|if|else|for|while|do|switch|case|break|continue|await|async|new|typeof|instanceof|null|undefined|true|false|try|catch|finally|throw|delete|in|of|yield)\b/g;
const PY_KEYWORDS = /\b(def|class|import|from|return|if|elif|else|for|while|in|not|and|or|is|True|False|None|try|except|finally|raise|with|as|pass|break|continue|lambda|yield|async|await)\b/g;
const GO_KEYWORDS = /\b(func|package|import|return|if|else|for|range|switch|case|break|continue|var|const|type|struct|interface|map|chan|go|defer|select|fallthrough|nil|true|false)\b/g;

export function highlightSyntax(line, lang) {
  if (!lang || NO_COLOR) return line;
  let out = line;
  const l = lang.toLowerCase();

  // Comments
  if (l === "python" || l === "py") {
    out = out.replace(/(#.*)$/, (m) => A.gray(m));
  } else {
    out = out.replace(/(\/\/.*)$/, (m) => A.gray(m));
  }

  // Strings
  out = out.replace(/(["'`])(?:(?!\1)[^\\]|\\.)*\1/g, (m) => A.green(m));

  // Numbers
  out = out.replace(/\b(\d+\.?\d*)\b/g, (m) => A.yellow(m));

  // Keywords
  if (l === "js" || l === "javascript" || l === "ts" || l === "typescript" || l === "jsx" || l === "tsx" || l === "mjs") {
    out = out.replace(JS_KEYWORDS, (m) => A.magenta(m));
  } else if (l === "py" || l === "python") {
    out = out.replace(PY_KEYWORDS, (m) => A.magenta(m));
  } else if (l === "go") {
    out = out.replace(GO_KEYWORDS, (m) => A.magenta(m));
  }

  return out;
}

// ─── Code block formatter ─────────────────────────────────────────────────

export function formatCodeBlock(lines, lang) {
  const termWidth = process.stdout.columns || 80;
  const innerWidth = Math.max(20, termWidth - 4);

  const langLabel = lang ? ` ${lang} ` : "";
  const dashFill = "─".repeat(Math.max(0, innerWidth - langLabel.length - 1));
  const top    = `┌${A.dim(langLabel)}${A.dim(dashFill)}┐`;
  const bottom = `└${A.dim("─".repeat(innerWidth))}┘`;

  const body = lines.map((l) => {
    const highlighted = highlightSyntax(l, lang);
    return `│ ${highlighted}`;
  });

  return [top, ...body, bottom].join("\n");
}

// ─── Table formatter ──────────────────────────────────────────────────────

export function formatTable(rows) {
  if (rows.length === 0) return "";

  const cells = rows.map((row) =>
    row.split("|").map((c) => c.trim()).filter((_, i, a) => i > 0 && i < a.length - 1)
  );

  const colCount = Math.max(...cells.map((r) => r.length));
  const colWidths = Array.from({ length: colCount }, (_, ci) =>
    Math.max(...cells.map((row) => (row[ci] || "").length))
  );

  const renderRow = (row, bold = false) =>
    "│ " +
    row.map((cell, ci) => {
      const padded = (cell || "").padEnd(colWidths[ci]);
      return bold ? A.bold(padded) : padded;
    }).join(" │ ") +
    " │";

  const separator = "├─" + colWidths.map((w) => "─".repeat(w)).join("─┼─") + "─┤";
  const topBorder  = "┌─" + colWidths.map((w) => "─".repeat(w)).join("─┬─") + "─┐";
  const botBorder  = "└─" + colWidths.map((w) => "─".repeat(w)).join("─┴─") + "─┘";

  const out = [topBorder, renderRow(cells[0], true)];
  if (cells.length > 1) {
    // Skip pure-separator rows (---|--- style)
    const nonSep = cells.slice(1).filter((row) => !row.every((c) => /^[-:]+$/.test(c)));
    if (nonSep.length > 0) {
      out.push(separator);
      out.push(...nonSep.map((row) => renderRow(row)));
    }
  }
  out.push(botBorder);
  return out.join("\n");
}

// ─── ANSI stripper ────────────────────────────────────────────────────────

export function stripAnsi(text) {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\x1b\[[0-9;]*m/g, "");
}

// ─── Main renderer ────────────────────────────────────────────────────────

export function renderMarkdown(text) {
  if (!text) return "";

  const lines = text.split("\n");
  const out = [];

  let inCode = false;
  let codeLang = "";
  let codeLines = [];
  let tableBuffer = [];

  const flushTable = () => {
    if (tableBuffer.length > 0) {
      out.push(formatTable(tableBuffer));
      tableBuffer = [];
    }
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Fenced code blocks
    if (line.trimStart().startsWith("```")) {
      if (inCode) {
        // End of code block
        out.push(formatCodeBlock(codeLines, codeLang));
        codeLines = [];
        codeLang = "";
        inCode = false;
      } else {
        flushTable();
        codeLang = line.trimStart().slice(3).trim();
        inCode = true;
      }
      continue;
    }
    if (inCode) {
      codeLines.push(line);
      continue;
    }

    // Table rows
    if (line.includes("|")) {
      tableBuffer.push(line);
      continue;
    }
    flushTable();

    // Headings
    const h1 = line.match(/^#\s+(.+)$/);
    if (h1) { out.push(A.bold(A.underline(h1[1]))); continue; }
    const h2 = line.match(/^##\s+(.+)$/);
    if (h2) { out.push(A.bold(h2[1])); continue; }
    const hN = line.match(/^#{3,}\s+(.+)$/);
    if (hN) { out.push(A.bold(hN[1])); continue; }

    // Horizontal rule
    if (/^---+$/.test(line.trim())) {
      const w = Math.min(process.stdout.columns || 80, 60);
      out.push(A.dim("─".repeat(w)));
      continue;
    }

    // Blockquote
    const bq = line.match(/^>\s?(.*)/);
    if (bq) { out.push(A.dim(`  │ ${bq[1]}`)); continue; }

    // Unordered list
    const ul = line.match(/^(\s*)[-*+]\s+(.+)/);
    if (ul) { out.push(`${ul[1]}  • ${renderInline(ul[2])}`); continue; }

    // Ordered list
    const ol = line.match(/^(\s*)(\d+)\.\s+(.+)/);
    if (ol) { out.push(`${ol[1]}${ol[2]}. ${renderInline(ol[3])}`); continue; }

    // Regular line
    out.push(renderInline(line));
  }

  flushTable();

  // Flush unclosed code block
  if (inCode && codeLines.length > 0) {
    out.push(formatCodeBlock(codeLines, codeLang));
  }

  const result = out.join("\n");
  return NO_COLOR ? stripAnsi(result) : result;
}
