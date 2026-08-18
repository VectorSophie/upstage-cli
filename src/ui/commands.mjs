import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import os from "node:os";
import { renderMarkdown } from "./markdown.mjs";
import { checkpointsDir, listCheckpoints, restoreCheckpoint } from "../core/rewind.mjs";
import { appendSpec, readSpecs } from "../core/spec.mjs";
import { listRecipes, loadRecipe, parseRecipeRunArgs, renderRecipe, saveRecipe } from "../core/recipes.mjs";

// ─── Command definitions ──────────────────────────────────────────────────

/**
 * Each command: { description, handler(args, state) → { response, exit? } }
 * state shape: {
 *   messages, turnCount, tokenUsage, model, tools,
 *   _contextManager, _checkpointManager,
 *   _permissionMode, _session, _settings, _registry
 * }
 */
export const COMMANDS = {
  "/help": {
    description: "사용 가능한 명령어 목록 표시",
    handler(_args, _state) {
      const lines = Object.entries(COMMANDS).map(
        ([cmd, def]) => `  ${cmd.padEnd(16)} ${def.description}`
      );
      return { response: `명령어 목록:\n\n${lines.join("\n")}` };
    }
  },

  "/clear": {
    description: "대화 기록 초기화",
    handler(_args, _state) {
      return { response: "__clear__", clearMessages: true };
    }
  },

  "/compact": {
    description: "컨텍스트 수동 압축",
    handler(_args, state) {
      const cm = state?._contextManager;
      if (!cm) return { response: "컨텍스트 관리자가 초기화되지 않았습니다." };
      const before = cm.getTokenCount(state.messages || []);
      const compacted = cm.compact(state.messages || []);
      const after = cm.getTokenCount(compacted);
      return {
        response: `컨텍스트 압축 완료: ${before} → ${after} 토큰 (${state.messages?.length || 0} → ${compacted.length} 메시지)`,
        updatedMessages: compacted
      };
    }
  },

  "/rewind": {
    description: "파일 체크포인트 목록 표시 / 복원 (/rewind <id> 또는 /rewind last)",
    async handler(args, state) {
      const cwd = state?._session?.workspace?.cwd || process.cwd();
      const base = checkpointsDir(cwd);
      const target = args && args[0];

      if (!target) {
        const list = await listCheckpoints(base);
        if (list.length === 0) return { response: "복원할 체크포인트가 없습니다." };
        const lines = list.map((c, i) => {
          const when = c.timestamp ? new Date(c.timestamp).toLocaleTimeString() : "?";
          const kind = c.isNew ? "new" : "edit";
          return `  ${String(i + 1).padStart(2)}. ${c.id}  ${when}  [${kind}]  ${c.relativePath}`;
        });
        return { response: `체크포인트 (최신순):\n\n${lines.join("\n")}\n\n복원: /rewind <id>  ·  마지막 되돌리기: /rewind last` };
      }

      const id = target === "last" || target === "latest" ? null : target;
      const res = await restoreCheckpoint(base, id);
      if (!res.ok) return { response: `되돌리기 실패: ${res.error}` };
      return { response: `↩ 복원됨: ${res.relativePath} (${res.action}, ${res.id})` };
    }
  },

  "/spec": {
    description: "스펙 기록/조회 (UPSTAGE.md에 지속 저장) — /spec <내용>",
    async handler(args, state) {
      const cwd = state?._session?.workspace?.cwd || process.cwd();
      const text = (args || []).join(" ").trim();
      if (!text) {
        const specs = await readSpecs(cwd);
        return { response: specs ? `현재 스펙:\n\n${specs}` : "기록된 스펙이 없습니다. /spec <내용> 으로 추가하세요." };
      }
      const { entry } = await appendSpec(cwd, text);
      return { response: `📝 스펙 저장됨 (UPSTAGE.md):\n${entry}` };
    }
  },

  "/cost": {
    description: "토큰 사용량 및 예상 비용 표시",
    handler(_args, state) {
      const usage = state?.tokenUsage || { total: 0, cost: 0 };
      return {
        response: `토큰 사용량: ${usage.total.toLocaleString()} tokens\n예상 비용: $${(usage.cost || 0).toFixed(6)}`
      };
    }
  },

  "/tokens": {
    description: "현재 토큰 사용량",
    handler(_args, state) {
      return COMMANDS["/cost"].handler(_args, state);
    }
  },

  "/undo": {
    description: "마지막 파일 변경 되돌리기",
    async handler(_args, state) {
      const cm = state?._checkpointManager;
      if (!cm) return { response: "체크포인트 관리자가 초기화되지 않았습니다." };
      const result = await cm.undo();
      if (!result) return { response: "되돌릴 체크포인트가 없습니다." };
      return { response: `파일 복원 완료: ${result.filePath}` };
    }
  },

  "/model": {
    description: "현재 모델 표시",
    handler(_args, state) {
      return { response: `현재 모델: ${state?.model || "solar-pro2"}` };
    }
  },

  "/tools": {
    description: "등록된 도구 목록",
    handler(_args, state) {
      const tools = state?._registry?.list?.() || state?.tools || [];
      const lines = tools.map((t) => `  ${(t.name || t).padEnd(24)} ${t.risk || ""}`);
      return { response: `등록된 도구 (${tools.length}개):\n${lines.join("\n")}` };
    }
  },

  "/status": {
    description: "세션 상태 표시",
    handler(_args, state) {
      const s = state?._session;
      if (!s) return { response: "세션 정보 없음" };
      const lines = [
        `세션 ID : ${s.id}`,
        `생성일시: ${new Date(s.createdAt).toLocaleString("ko-KR")}`,
        `작업공간: ${s.workspace?.cwd || process.cwd()}`,
        `메시지수: ${(s.history || []).length}`,
        `도구호출: ${(s.toolResults || []).length}`,
      ];
      return { response: lines.join("\n") };
    }
  },

  "/config": {
    description: "현재 설정 표시",
    handler(_args, state) {
      const cfg = state?._settings || {};
      const lines = [
        `모델         : ${cfg.model || "solar-pro2"}`,
        `자동압축     : ${cfg.autoCompactEnabled ?? true}`,
        `파일체크포인트: ${cfg.fileCheckpointingEnabled ?? true}`,
        `압축임계값   : ${cfg.compactThreshold ?? 0.8}`,
        `최대컨텍스트 : ${cfg.maxContextTokens ?? 65536}`,
        `스트리밍     : ${cfg.stream ?? true}`,
        `언어         : ${cfg.language || "ko"}`,
      ];
      return { response: `현재 설정:\n\n${lines.join("\n")}` };
    }
  },

  "/permissions": {
    description: "현재 권한 모드 표시",
    handler(_args, state) {
      return { response: `권한 모드: ${state?._permissionMode || "default"}` };
    }
  },

  "/doctor": {
    description: "시스템 진단",
    handler(_args, state) {
      const nodeVer = process.version;
      const platform = `${process.platform}/${process.arch}`;
      const apiKey = !!process.env.UPSTAGE_API_KEY;
      const toolCount = state?._registry?.list?.()?.length ?? state?.tools?.length ?? 0;
      const lines = [
        `Node.js       : ${nodeVer}`,
        `플랫폼        : ${platform}`,
        `API 키 설정   : ${apiKey ? "✓" : "✗ (UPSTAGE_API_KEY 미설정)"}`,
        `등록 도구     : ${toolCount}개`,
        `홈 디렉토리   : ${os.homedir()}`,
        `작업 디렉토리 : ${process.cwd()}`,
      ];
      return { response: `시스템 진단:\n\n${lines.join("\n")}` };
    }
  },

  "/diff": {
    description: "git diff 표시",
    handler(_args, _state) {
      try {
        const diff = execSync("git diff --stat HEAD", { encoding: "utf8", timeout: 5000 });
        return { response: diff.trim() || "변경 사항 없음" };
      } catch (_e) {
        return { response: "git 저장소가 아니거나 git 명령 실행 실패" };
      }
    }
  },

  "/init": {
    description: ".upstage/ 디렉토리 초기화",
    async handler(_args, _state) {
      const dirs = [
        join(process.cwd(), ".upstage"),
        join(process.cwd(), ".upstage", "checkpoints"),
        join(process.cwd(), ".upstage", "agents"),
        join(process.cwd(), ".upstage", "skills"),
      ];
      for (const d of dirs) {
        if (!existsSync(d)) await mkdir(d, { recursive: true });
      }
      return { response: ".upstage/ 디렉토리 초기화 완료" };
    }
  },

  "/fast": {
    description: "빠른 모드 전환 (미구현)",
    handler(_args, _state) {
      return { response: "빠른 모드 전환: /config 에서 fastMode를 설정하세요." };
    }
  },

  "/think": {
    description: "확장 사고 전환 (미구현)",
    handler(_args, _state) {
      return { response: "확장 사고 모드는 alwaysThinkingEnabled 설정을 사용하세요." };
    }
  },

  "/plan": {
    description: "계획 모드 전환 (읽기 전용)",
    handler(_args, state) {
      const current = state?._permissionMode;
      const next = current === "plan" ? "default" : "plan";
      return { response: `권한 모드 변경: ${current} → ${next}\n(재시작 후 적용)` };
    }
  },

  "/vim": {
    description: "vim 키바인딩 전환 (미구현)",
    handler(_args, _state) {
      return { response: "vim 키바인딩은 settings.vimMode 설정을 사용하세요." };
    }
  },

  "/memory": {
    description: "대화 메모리 사용량",
    handler(_args, state) {
      const msgs = state?.messages || [];
      const cm = state?._contextManager;
      const tokens = cm ? cm.getTokenCount(msgs) : "알 수 없음";
      return { response: `메시지 수: ${msgs.length}\n토큰 추정: ${tokens}` };
    }
  },

  "/forget": {
    description: "마지막 N개 메시지 삭제 (사용법: /forget 2)",
    handler(args, state) {
      const n = parseInt(args[0] || "2", 10);
      if (!Number.isFinite(n) || n <= 0) return { response: "올바른 숫자를 입력하세요. 예: /forget 2" };
      const msgs = state?.messages || [];
      const updated = msgs.slice(0, -n);
      return {
        response: `마지막 ${n}개 메시지 삭제 (${msgs.length} → ${updated.length})`,
        updatedMessages: updated
      };
    }
  },

  "/mcp": {
    description: "MCP 서버 상태",
    handler(_args, state) {
      const clients = state?._mcpClients || {};
      const names = Object.keys(clients);
      if (names.length === 0) return { response: "연결된 MCP 서버 없음" };
      return { response: `MCP 서버 (${names.length}개):\n${names.map((n) => `  • ${n}`).join("\n")}` };
    }
  },

  "/hooks": {
    description: "설정된 훅 표시",
    handler(_args, state) {
      const hooks = state?._settings?.hooks || {};
      const entries = Object.entries(hooks);
      if (entries.length === 0) return { response: "설정된 훅 없음" };
      const lines = entries.map(([k, v]) => `  ${k}: ${Array.isArray(v) ? `${v.length}개` : typeof v}`);
      return { response: `설정된 훅:\n${lines.join("\n")}` };
    }
  },

  "/agents": {
    description: "사용자 정의 에이전트 목록",
    handler(_args, state) {
      const loader = state?._agentLoader;
      if (!loader) return { response: "에이전트 로더가 초기화되지 않았습니다." };
      const agents = loader.list?.() || [];
      if (agents.length === 0) return { response: "로드된 에이전트 없음 (.upstage/agents/ 에 정의 추가)" };
      return { response: `에이전트 (${agents.length}개):\n${agents.map((a) => `  • ${a.name}: ${a.description || ""}`).join("\n")}` };
    }
  },

  "/skills": {
    description: "사용 가능한 스킬 목록",
    handler(_args, state) {
      const loader = state?._skillsLoader;
      if (!loader) return { response: "스킬 로더가 초기화되지 않았습니다." };
      const skills = loader.list?.() || [];
      if (skills.length === 0) return { response: "로드된 스킬 없음 (.upstage/skills/ 에 정의 추가)" };
      return {
        response: `스킬 (${skills.length}개) — /<이름> 으로 직접 실행:\n${skills
          .map((s) => `  • /${s.name}${s.license ? ` [${s.license}]` : ""}: ${s.description || ""}`)
          .join("\n")}`
      };
    }
  },

  "/sessions": {
    description: "최근 세션 목록 열기",
    handler(_args, _state) {
      return { response: "__show_sessions__", showSessions: true };
    }
  },

  "/lang": {
    description: "언어 변경 (사용법: /lang ko 또는 /lang en)",
    handler(args, _state) {
      const lang = args[0];
      if (!lang) return { response: "사용법: /lang ko 또는 /lang en" };
      return { response: `__lang_change__`, changeLang: lang };
    }
  },

  "/tree": {
    description: "리포지토리 맵 표시",
    handler(_args, _state) {
      return { response: "__show_tree__", showTree: true };
    }
  },

  "/new": {
    description: "새 세션 시작",
    handler(_args, _state) {
      return { response: "__new_session__", newSession: true };
    }
  },

  "/recipe": {
    description: "재사용 가능한 프롬프트 템플릿 (사용법: /recipe save <이름> <템플릿...> · /recipe run <이름> [key=value...] · /recipe list)",
    async handler(args, state) {
      const cwd = state?._session?.workspace?.cwd || process.cwd();
      const sub = (args?.[0] || "").toLowerCase();

      if (sub === "list") {
        const recipes = await listRecipes(cwd);
        if (recipes.length === 0) return { response: "저장된 레시피가 없습니다. /recipe save <이름> <템플릿> 으로 추가하세요." };
        const lines = recipes.map((r) => `  ${r.name.padEnd(20)} ${r.description || r.template.slice(0, 50)}`);
        return { response: `레시피 (${recipes.length}개):\n${lines.join("\n")}` };
      }

      if (sub === "save") {
        const name = args[1];
        const template = args.slice(2).join(" ");
        if (!name || !template) return { response: "사용법: /recipe save <이름> <템플릿...> (템플릿 안에 {{param}} 사용 가능)" };
        try {
          await saveRecipe(cwd, name, { template });
          return { response: `📝 레시피 저장됨: ${name}` };
        } catch (err) {
          return { response: `레시피 저장 실패: ${err.message}` };
        }
      }

      if (sub === "run") {
        const { name, params } = parseRecipeRunArgs(args.slice(1));
        if (!name) return { response: "사용법: /recipe run <이름> [key=value...]" };
        const recipe = await loadRecipe(cwd, name);
        if (!recipe) return { response: `레시피를 찾을 수 없습니다: ${name}` };
        const rendered = renderRecipe(recipe, params);
        return { response: `__run_recipe__`, runPrompt: rendered };
      }

      return { response: "사용법: /recipe save <이름> <템플릿...> · /recipe run <이름> [key=value...] · /recipe list" };
    }
  },

  "/watch": {
    description: "파일의 // ai! 주석을 감지해 자동 실행 (watch mode) — /unwatch 로 중지",
    handler(_args, state) {
      if (state?._watching) return { response: "이미 감시 중입니다. /unwatch 로 먼저 중지하세요." };
      return { response: "__watch_start__", startWatch: true };
    }
  },

  "/unwatch": {
    description: "watch mode 중지",
    handler(_args, state) {
      if (!state?._watching) return { response: "감시 중이 아닙니다." };
      return { response: "__watch_stop__", stopWatch: true };
    }
  },

  "/branch": {
    description: "현재 세션을 분기 (지금까지의 대화를 복사해 새 세션 시작) — /branch list 로 분기 목록 확인",
    async handler(args, state) {
      if ((args?.[0] || "").toLowerCase() === "list") {
        const current = state?._session;
        if (!current) return { response: "세션 정보 없음" };
        const { listSessions } = await import("../runtime/session.mjs");
        const all = await listSessions();
        const rootId = current.parentSessionId || current.id;
        const related = all.filter((s) => s.id === rootId || s.parentSessionId === rootId || s.id === current.parentSessionId);
        if (related.length <= 1) return { response: "분기된 세션이 없습니다." };
        const lines = related.map((s) => `  ${s.id === current.id ? "→" : " "} ${s.id.slice(0, 8)}  ${new Date(s.updatedAt).toLocaleString("ko-KR")}${s.parentSessionId ? "  (분기)" : "  (원본)"}`);
        return { response: `세션 분기 (${related.length}개):\n\n${lines.join("\n")}` };
      }
      return { response: "__branch_session__", branchSession: true };
    }
  },

  "/exit": {
    description: "종료",
    handler(_args, _state) {
      return { response: "Goodbye. 안녕히 계세요.", exit: true };
    }
  },

  "/quit": {
    description: "종료",
    handler(_args, _state) {
      return COMMANDS["/exit"].handler(_args, _state);
    }
  },
};

// ─── Dispatcher ───────────────────────────────────────────────────────────

export async function executeCommand(input, state) {
  const trimmed = (input || "").trim();
  if (!trimmed.startsWith("/")) {
    return { response: `알 수 없는 명령어: ${trimmed}` };
  }

  const parts = trimmed.split(/\s+/);
  const cmd = parts[0].toLowerCase();
  const args = parts.slice(1);

  const def = COMMANDS[cmd];
  if (!def) {
    // Fall back to a user/project-defined skill (src/skills/loader.mjs) —
    // `/summarize some text` runs the "summarize" skill the same way
    // `/recipe run` does, before falling through to "unknown command".
    // Manual invocation this way; the load_skill tool is the autonomous
    // path for the model to reach for the same skills on its own.
    const skill = state?._skillsLoader?.get?.(cmd.slice(1));
    if (skill) {
      try {
        return { response: "__run_skill__", runPrompt: state._skillsLoader.run(skill.name, args.join(" ")) };
      } catch (err) {
        return { response: `스킬 실행 오류: ${err.message}` };
      }
    }
    const close = getCompletions(cmd);
    const hint = close.length > 0 ? ` (혹시 ${close[0]}?)` : "";
    return { response: `알 수 없는 명령어: ${cmd}${hint}` };
  }

  try {
    const result = await def.handler(args, state);
    return result || { response: "" };
  } catch (err) {
    return { response: `명령어 실행 오류: ${err.message}` };
  }
}

// ─── Tab completions ──────────────────────────────────────────────────────

export function getCompletions(partial) {
  const p = (partial || "").toLowerCase();
  return Object.keys(COMMANDS)
    .filter((cmd) => cmd.startsWith(p))
    .sort();
}

// ─── Markdown re-export for consumers ────────────────────────────────────

export { renderMarkdown };
