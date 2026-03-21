import { COLOR, c } from "./colors.js";

function normalizeThoughtLines(thought) {
  const subject = (thought.subject || "").trim();
  const description = (thought.description || "").trim();

  if (!subject && !description) return [];
  if (!subject) return description.split("\n");
  if (!description) return [subject];
  return [subject, ...description.split("\n")];
}

export function renderThinking(thought) {
  const lines = normalizeThoughtLines(thought);
  if (lines.length === 0) return "";

  const out = [];
  out.push(c(COLOR.text.italic, " Thinking... "));
  for (let i = 0; i < lines.length; i++) {
    const prefix = c(COLOR.text.secondary, "│ ");
    const text = i === 0 
      ? c(COLOR.text.bold + COLOR.text.italic, lines[i])
      : c(COLOR.text.secondary + COLOR.text.italic, lines[i]);
    out.push(`${prefix}${text}`);
  }
  return out.join("\n");
}

export function canUseFullscreenTui() {
  return Boolean(process.stdin.isTTY && process.stdout.isTTY && process.env.TERM !== "dumb");
}

export function enterFullscreenTui() {
  process.stdout.write("\x1b[0m\x1b[?25h");
  process.stdout.write("\x1b[?1049h");
  process.stdout.write("\x1b[0m");
  process.stdout.write("\x1b[?25l");
  process.stdout.write("\x1b[2J\x1b[H");
}

export function exitFullscreenTui() {
  process.stdout.write("\x1b[0m\x1b[?25h");
  process.stdout.write("\x1b[?1049l");
}

const BANNER = [
  " █████  █████                    █████                               ",
  "▒▒███  ▒▒███                    ▒▒███                                ",
  " ▒███   ▒███  ████████   █████  ███████    ██████    ███████  ██████ ",
  " ▒███   ▒███ ▒▒███▒▒███ ███▒▒  ▒▒▒███▒    ▒▒▒▒▒███  ███▒▒███ ███▒▒███",
  " ▒███   ▒███  ▒███ ▒███▒▒█████   ▒███      ███████ ▒███ ▒███▒███████ ",
  " ▒███   ▒███  ▒███ ▒███ ▒▒▒▒███  ▒███ ███ ███▒▒███ ▒███ ▒███▒███▒▒▒  ",
  " ▒▒████████   ▒███████  ██████   ▒▒█████ ▒▒████████▒▒███████▒▒██████ ",
  "  ▒▒▒▒▒▒▒▒    ▒███▒▒▒  ▒▒▒▒▒▒     ▒▒▒▒▒   ▒▒▒▒▒▒▒▒  ▒▒▒▒▒███ ▒▒▒▒▒▒  ",
  "              ▒███                                  ███ ▒███         ",
  "              █████                                ▒▒██████          ",
  "             ▒▒▒▒▒                                  ▒▒▒▒▒▒           "
];

export function renderAppHeader(sessionId) {
  const out = [];
  for (const line of BANNER) {
    out.push(c(COLOR.primary, line));
  }
  out.push("");
  out.push(c(COLOR.secondary, " 한국형 Gemini CLI 지향 Upstage Solar-Pro 에이전트"));
  out.push(c(COLOR.accent, ` 세션: ${sessionId}  ·  v1.0.0-solar`));
  out.push(c(COLOR.text.dim, " ──────────────────────────────────────────────────────────"));
  return out.join("\n");
}

export function renderMainHeader(sessionId) {
  process.stdout.write(renderAppHeader(sessionId) + "\n");
  process.stdout.write(
    c(COLOR.text.dim, " 명령: /help /palette /tools /tree /sessions /tasks /models /theme /logs /reset /exit\n\n")
  );
}

export function renderHelpKorean() {
  process.stdout.write(c(COLOR.bold, "upstage-cli 사용법\n"));
  process.stdout.write("\n");
  process.stdout.write("  upstage chat\n");
  process.stdout.write("  upstage ask -p \"파일 구조 분석해줘\"\n");
  process.stdout.write("  upstage ask -p \"이슈 #142 고쳐줘\" --confirm-patches\n");
  process.stdout.write("  upstage tui\n");
  process.stdout.write("  upstage chat --go-tui\n");
  process.stdout.write("  /palette test\n");
  process.stdout.write("\n");
  process.stdout.write(c(COLOR.bold, "옵션\n"));
  process.stdout.write("  --model <name>        Upstage 모델 지정\n");
  process.stdout.write("  --no-stream           스트리밍 비활성화\n");
  process.stdout.write("  --session <id>        특정 세션 불러오기\n");
  process.stdout.write("  --new-session         새 세션 시작\n");
  process.stdout.write("  --reset-session       현재 세션 초기화\n");
  process.stdout.write("  --confirm-patches     고위험 도구 실행 전 확인\n");
  process.stdout.write("  --go-tui              Go Bubble Tea TUI 실행\n");
  process.stdout.write("\n");
  process.stdout.write(c(COLOR.bold, "단축키(오픈코드 스타일)\n"));
  process.stdout.write("  ctrl+l logs   ctrl+s sessions   ctrl+k commands\n");
  process.stdout.write("  ctrl+o models ctrl+t theme      ctrl+? help\n");
  process.stdout.write("\n");
}

export function renderEvent(event) {
  if (!event || typeof event !== "object") {
    return;
  }
  if (event.type === "PLAN") {
    process.stdout.write(c(COLOR.primary, "[PLAN] "));
    process.stdout.write(`mode=${event.mode} keywords=${(event.keywords || []).join(",") || "none"}\n`);
    return;
  }
  if (event.type === "TOOL") {
    process.stdout.write(c(COLOR.subA, "[TOOL] "));
    process.stdout.write(`${event.tool} ${JSON.stringify(event.args || {})}\n`);
    return;
  }
  if (event.type === "OBSERVATION") {
    process.stdout.write(c(COLOR.subB, "[OBSERVATION] "));
    process.stdout.write(`${event.tool} ok=${event.ok}\n`);
    return;
  }
  if (event.type === "PATCH_PREVIEW") {
    process.stdout.write(c(COLOR.primary, "[PATCH PREVIEW]\n"));
    process.stdout.write(`${event.patch?.unifiedDiff || "(no diff)"}\n`);
    return;
  }
  if (event.type === "VERIFY_LOG") {
    const stage = event.stage || "verify";
    const text = (event.text || "").trim();
    if (text) {
      process.stdout.write(c(COLOR.subA, `[VERIFY:${stage}] `) + `${text}\n`);
    }
    return;
  }
  if (event.type === "VERIFY_RESULT") {
    process.stdout.write(c(COLOR.primary, `[VERIFY RESULT] stage=${event.stage}\n`));
    return;
  }
  if (event.type === "POLICY_DECISION") {
    process.stdout.write(c(COLOR.subB, "[POLICY] "));
    process.stdout.write(
      `${event.tool || "n/a"} action=${event.actionClass || "n/a"} approved=${event.approved ?? event.allowed ?? "n/a"}\n`
    );
  }
}

export function renderToolList(tools) {
  process.stdout.write(c(COLOR.bold, "사용 가능한 도구\n"));
  for (const tool of tools) {
    process.stdout.write(`- ${tool.name} (${tool.risk})\n`);
  }
}

export function renderSessionList(items) {
  process.stdout.write(c(COLOR.bold, "최근 세션\n"));
  for (const item of items) {
    process.stdout.write(`- ${item.id} (${item.workspace?.cwd || "unknown"})\n`);
  }
}

export function renderTaskSummary(summary) {
  process.stdout.write(c(COLOR.bold, "작업 요약\n"));
  process.stdout.write(`- plans: ${summary.plans}\n`);
  process.stdout.write(`- tools: ${summary.tools}\n`);
  process.stdout.write(`- observations: ${summary.observations}\n`);
  process.stdout.write(`- approvals: ${summary.approvals}\n`);
}

export function renderFileTree(repoMap) {
  process.stdout.write(c(COLOR.bold, "파일 트리\n"));
  const byExt = repoMap.byExtension || {};
  for (const [ext, files] of Object.entries(byExt)) {
    process.stdout.write(c(COLOR.subB, `- ${ext}\n`));
    for (const file of files.slice(0, 8)) {
      process.stdout.write(`  - ${file}\n`);
    }
    if (files.length > 8) {
      process.stdout.write(c(COLOR.dim, `  - ... (${files.length - 8} more)\n`));
    }
  }
}

export function renderDiff(diffContent) {
  if (!diffContent) return c(COLOR.status.warning, "No diff content.");

  const lines = diffContent.split(/\r?\n/);
  const out = [];
  let currentOldLine = 0;
  let currentNewLine = 0;

  for (const line of lines) {
    if (line.startsWith("@@")) {
      const match = line.match(/^@@ -(\d+),?\d* \+(\d+),?\d* @@/);
      if (match) {
        currentOldLine = parseInt(match[1], 10);
        currentNewLine = parseInt(match[2], 10);
      }
      out.push(c(COLOR.accent, line));
      continue;
    }

    let prefix = "  ";
    let content = line.substring(1);
    let color = COLOR.text.primary;
    let bgColor = "";

    if (line.startsWith("+")) {
      prefix = "+ ";
      color = COLOR.status.success;
      bgColor = COLOR.diff.added;
      currentNewLine++;
    } else if (line.startsWith("-")) {
      prefix = "- ";
      color = COLOR.status.error;
      bgColor = COLOR.diff.removed;
      currentOldLine++;
    } else if (line.startsWith(" ")) {
      currentOldLine++;
      currentNewLine++;
    }

    const gutter = c(COLOR.text.secondary, `${currentNewLine}`.padStart(4));
    out.push(`${gutter} ${c(bgColor + color, prefix + content)}`);
  }

  return out.join("\n");
}

function wrapLines(text, width) {
  const source = String(text || "").replace(/\r\n/g, "\n").split("\n");
  const out = [];
  for (const line of source) {
    if (line.length <= width) {
      out.push(line);
      continue;
    }
    let start = 0;
    while (start < line.length) {
      out.push(line.slice(start, start + width));
      start += width;
    }
  }
  return out;
}

export function renderUserMessage(text, width) {
  const prefix = c(COLOR.accent, "> ");
  const innerWidth = width - 2;
  const wrapped = wrapLines(text, innerWidth);
  return wrapped.map((line, i) => {
    if (i === 0) return `${prefix}${c(COLOR.text.primary, line)}`;
    return `  ${c(COLOR.text.primary, line)}`;
  }).join("\n");
}

function highlightCode(code, lang) {
  if (!code) return "";
  const lines = code.split("\n");
  return lines.map(line => {
    let h = line;
    h = h.replace(/(\/\/.*$)/g, c(COLOR.text.dim, "$1"));
    h = h.replace(/(["'].*?["'])/g, c(COLOR.status.success, "$1"));
    h = h.replace(/\b(export|import|from|const|let|var|function|return|class|if|else|for|while|await|async)\b/g, c(COLOR.primary, "$1"));
    h = h.replace(/\b(\d+)\b/g, c(COLOR.accent, "$1"));
    return h;
  }).join("\n");
}

export function renderSolarMessage(text, width) {
  const prefix = c(COLOR.primary, "✦ ");
  const innerWidth = width - 2;
  
  const parts = text.split(/```/);
  const rendered = [];
  
  for (let i = 0; i < parts.length; i++) {
    if (i % 2 === 1) {
      const content = parts[i].trim();
      const firstLineIdx = content.indexOf("\n");
      const lang = firstLineIdx !== -1 ? content.slice(0, firstLineIdx) : "";
      const code = firstLineIdx !== -1 ? content.slice(firstLineIdx + 1) : content;
      
      rendered.push(c(COLOR.text.dim, "  " + "─".repeat(innerWidth - 2)));
      rendered.push(highlightCode(code, lang).split("\n").map(l => "  " + l).join("\n"));
      rendered.push(c(COLOR.text.dim, "  " + "─".repeat(innerWidth - 2)));
    } else {
      const wrapped = wrapLines(parts[i], innerWidth);
      rendered.push(...wrapped.map((line, j) => {
        if (i === 0 && j === 0) return `${prefix}${c(COLOR.text.primary, line)}`;
        return `  ${c(COLOR.text.primary, line)}`;
      }));
    }
  }
  
  return rendered.join("\n");
}

function visibleLength(value) {
  return String(value || "").replace(/\x1b\[[0-9;]*m/g, "").length;
}

function padVisible(value, width) {
  const line = String(value || "");
  const length = visibleLength(line);
  if (length >= width) {
    return line;
  }
  return `${line}${" ".repeat(width - length)}`;
}

function box(title, lines, width, color) {
  const top = `┌─ ${title} ${"─".repeat(Math.max(0, width - title.length - 4))}`;
  const bottom = `└${"─".repeat(Math.max(0, width - 1))}`;
  const body = lines.map((line) => `│ ${line}${" ".repeat(Math.max(0, width - line.length - 2))}`);
  return [c(color, top), ...body, c(color, bottom)];
}

function mergeColumns(leftLines, rightLines, leftWidth, rightWidth, gap = 2) {
  const rows = Math.max(leftLines.length, rightLines.length);
  const out = [];
  for (let i = 0; i < rows; i += 1) {
    const left = padVisible(leftLines[i] || "", leftWidth);
    const right = padVisible(rightLines[i] || "", rightWidth);
    out.push(`${left}${" ".repeat(gap)}${right}`);
  }
  return out;
}

function statusChip(label, value, color) {
  return c(color, ` ${label}: ${value} `);
}

function buildStatusBar(state, width) {
  const left = [
    statusChip("mode", "chat", COLOR.primary),
    statusChip("session", state.sessionId.slice(0, 8), COLOR.secondary),
    statusChip("status", state.status, COLOR.accent)
  ].join(" ");

  const right = [
    `plans ${state.taskStats.plans}`,
    `tools ${state.taskStats.tools}`,
    `obs ${state.taskStats.observations}`,
    `approvals ${state.taskStats.approvals}`,
    "ctrl+l logs",
    "ctrl+s sessions",
    "ctrl+k commands",
    "ctrl+o models",
    "ctrl+t theme",
    "ctrl+? help"
  ].join("  ");

  const leftLen = visibleLength(left);
  const rightLen = visibleLength(right);
  if (leftLen + rightLen + 2 <= width) {
    return `${left}${" ".repeat(width - leftLen - rightLen)}${c(COLOR.text.dim, right)}`;
  }
  return `${left}\n${c(COLOR.text.dim, right)}`;
}

function centeredOverlay(title, lines, width) {
  const overlayWidth = Math.max(42, Math.min(Math.floor(width * 0.72), 92));
  const inner = Math.max(28, overlayWidth - 2);
  const wrapped = lines.flatMap((line) => wrapLines(line, inner)).slice(0, 18);
  const boxLines = box(title, wrapped, overlayWidth, COLOR.primary);
  const pad = Math.max(0, Math.floor((width - overlayWidth) / 2));
  return boxLines.map((line) => `${" ".repeat(pad)}${line}`);
}

export function createChatScreen(sessionId) {
  const state = {
    sessionId,
    status: "대기",
    logs: [],
    timeline: [],
    assistant: "",
    panelTitle: "안내",
    panelLines: ["질문을 입력하면 에이전트가 단계별로 처리합니다."],
    stopReason: "",
    showOverlay: false,
    overlayTitle: "",
    overlayLines: [],
    taskStats: {
      plans: 0,
      tools: 0,
      observations: 0,
      approvals: 0
    }
  };

  const pushLog = (line) => {
    state.logs.push(line);
    if (state.logs.length > 80) {
      state.logs = state.logs.slice(-80);
    }
  };

  const pushTimeline = (line) => {
    state.timeline.push(line);
    if (state.timeline.length > 150) {
      state.timeline = state.timeline.slice(-150);
    }
  };

  const setPanel = (title, lines) => {
    state.panelTitle = title;
    state.panelLines = Array.isArray(lines) ? lines.slice(0, 120) : [String(lines || "")];
  };

  const redraw = () => {
    const cols = process.stdout.columns || 120;
    const rows = process.stdout.rows || 38;
    const width = Math.max(48, cols - 2);
    const isWide = width >= 110;
    const leftWidth = isWide ? Math.max(44, Math.floor(width * 0.72) - 2) : width;
    const rightWidth = isWide ? Math.max(28, width - leftWidth - 2) : width;
    const leftInnerWidth = Math.max(26, leftWidth - 2);
    const rightInnerWidth = Math.max(20, rightWidth - 2);

    process.stdout.write("\x1b[2J\x1b[H");
    process.stdout.write(c(COLOR.primary, ` Upstage Workspace  ·  Solar-Pro Agent\n`));
    process.stdout.write(c(COLOR.accent, ` Session ${state.sessionId}${state.stopReason ? `  ·  ${state.stopReason}` : ""}\n\n`));

    const timelineLines = state.timeline.flatMap(item => {
      if (item.type === "user") return [renderUserMessage(item.text, leftInnerWidth), ""];
      if (item.type === "solar") return [renderSolarMessage(item.text, leftInnerWidth), ""];
      if (item.type === "thinking") return [renderThinking(item.thought), ""];
      if (item.type === "log") return [c(COLOR.text.dim, item.text)];
      return [];
    }).slice(-Math.max(12, Math.floor(rows * 0.45)));
    
    const timelineBox = box("채팅 타임라인", timelineLines, leftWidth, COLOR.accent);

    const assistantLines = wrapLines(state.assistant || "(응답 대기 중)", leftInnerWidth).slice(-Math.max(6, Math.floor(rows * 0.20)));
    const assistantBox = box("Upstage Solar 응답", assistantLines, leftWidth, COLOR.secondary);

    const activityLines = state.logs
      .slice(-Math.max(6, Math.floor(rows * 0.20)))
      .flatMap((line) => wrapLines(line, leftInnerWidth));
    const activityBox = box("시스템 활동", activityLines, leftWidth, COLOR.primary);

    const panelLines = state.panelLines.flatMap((line) => wrapLines(line, rightInnerWidth)).slice(0, 12);
    const panelBox = box(state.panelTitle, panelLines, rightWidth, COLOR.primary);
    const stats = [
      `plans: ${state.taskStats.plans}`,
      `tools: ${state.taskStats.tools}`,
      `obs:   ${state.taskStats.observations}`,
      `approvals: ${state.taskStats.approvals}`
    ];
    const statsBox = box("작업 메트릭", stats, rightWidth, COLOR.accent);
    const shortcutsBox = box(
      "빠른 명령 (OpenCode-like)",
      ["/help", "/palette <q>", "/tools", "/tree", "/sessions", "/reset", "/exit"],
      rightWidth,
      COLOR.secondary
    );

    if (isWide) {
      const leftColumn = [...timelineBox, "", ...assistantBox, "", ...activityBox];
      const rightColumn = [...panelBox, "", ...statsBox, "", ...shortcutsBox];
      const merged = mergeColumns(leftColumn, rightColumn, leftWidth, rightWidth, 2);
      process.stdout.write(`${merged.join("\n")}\n\n`);
    } else {
      process.stdout.write(`${timelineBox.join("\n")}\n`);
      process.stdout.write(`${assistantBox.join("\n")}\n`);
      process.stdout.write(`${activityBox.join("\n")}\n`);
      process.stdout.write(`${panelBox.join("\n")}\n`);
      process.stdout.write(`${statsBox.join("\n")}\n\n`);
    }

    if (state.showOverlay) {
      const overlay = centeredOverlay(state.overlayTitle || "dialog", state.overlayLines, width);
      process.stdout.write(`${overlay.join("\n")}\n\n`);
    }

    process.stdout.write(`${buildStatusBar(state, width)}\n`);
    process.stdout.write(
      c(COLOR.dim, "명령: /help /palette /tools /tree /sessions /tasks /models /theme /logs /reset /exit\n")
    );
  };

  return {
    redraw,
    setStatus(value) {
      state.status = value;
    },
    clearAssistant() {
      state.assistant = "";
    },
    appendAssistantToken(token) {
      state.assistant += token;
      const last = state.timeline[state.timeline.length - 1];
      if (last && last.type === "solar") {
        last.text += token;
      } else {
        pushTimeline({ type: "solar", text: token });
      }
    },
    setAssistantFinal(text) {
      state.assistant = text || "";
      const last = state.timeline[state.timeline.length - 1];
      if (last && last.type === "solar") {
        last.text = text;
      } else {
        pushTimeline({ type: "solar", text: text || "" });
      }
    },
    setStopReason(reason) {
      state.stopReason = reason || "";
    },
    log(message) {
      pushLog(message);
      pushTimeline({ type: "log", text: `• ${message}` });
    },
    pushUserMessage(text) {
      pushTimeline({ type: "user", text });
    },
    pushSolarMessage(text) {
      pushTimeline({ type: "solar", text });
    },
    pushThinking(thought) {
      pushTimeline({ type: "thinking", thought });
    },
    setPanel,
    openOverlay(title, lines) {
      state.showOverlay = true;
      state.overlayTitle = title;
      state.overlayLines = Array.isArray(lines) ? lines.slice(0, 120) : [String(lines || "")];
    },
    closeOverlay() {
      state.showOverlay = false;
      state.overlayTitle = "";
      state.overlayLines = [];
    },
    getTaskSummary() {
      return { ...state.taskStats };
    },
    onEvent(event) {
      if (!event || typeof event !== "object") {
        return;
      }
      if (event.type === "PLAN") {
        const line = `[PLAN] mode=${event.mode} keywords=${(event.keywords || []).join(",") || "none"}`;
        pushLog(line);
        pushTimeline({ type: "log", text: `planning · ${event.mode}` });
        state.taskStats.plans += 1;
      } else if (event.type === "THINKING") {
        pushTimeline({ type: "thinking", thought: event.thought });
        state.status = "Thinking";
      } else if (event.type === "TOOL") {
        const line = `[TOOL] ${event.tool} ${JSON.stringify(event.args || {})}`;
        pushLog(line);
        pushTimeline({ type: "log", text: `tool · ${event.tool}` });
        state.taskStats.tools += 1;
      } else if (event.type === "OBSERVATION") {
        const line = `[OBSERVATION] ${event.tool} ok=${event.ok}`;
        pushLog(line);
        pushTimeline({ type: "log", text: `observation · ${event.tool} (${event.ok ? "ok" : "fail"})` });
        state.taskStats.observations += 1;
      } else if (event.type === "PATCH_PREVIEW") {
        const preview = String(event.patch?.unifiedDiff || "(no diff)")
          .split("\n")
          .slice(0, 14);
        setPanel("PATCH PREVIEW", preview);
      } else if (event.type === "VERIFY_LOG") {
        const text = (event.text || "").trim();
        if (text) {
          pushLog(`[VERIFY:${event.stage || "verify"}] ${text}`);
          pushTimeline({ type: "log", text: `verify · ${event.stage || "verify"}` });
        }
      } else if (event.type === "VERIFY_RESULT") {
        pushLog(`[VERIFY RESULT] stage=${event.stage}`);
        pushTimeline({ type: "log", text: `verified · ${event.stage}` });
      } else if (event.type === "POLICY_DECISION") {
        const decision =
          typeof event.approved === "boolean"
            ? `approved=${event.approved}`
            : `allowed=${event.allowed}`;
        pushLog(`[POLICY] ${event.tool || "n/a"} ${event.actionClass || "n/a"} ${decision}`);
        pushTimeline({ type: "log", text: `policy · ${event.tool || "n/a"} ${decision}` });
        state.taskStats.approvals += 1;
        setPanel("승인/정책", [
          `tool: ${event.tool || "n/a"}`,
          `action: ${event.actionClass || "n/a"}`,
          decision
        ]);
      }
    }
  };
}
