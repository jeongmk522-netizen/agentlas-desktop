"use strict";
/*
 * agentlas-repl: 보스턴테리어 터미널의 대화형 셸.
 * agentlas 가 항상 "호스트"다 — 활성 런타임이 claude/codex/gemini면 native-host로 headless 구동해
 * 이 TUI 안에서 렌더하고(구독 인증 유지), BYOK/Ollama면 자체 에이전트 루프(api-agent)를 돌린다.
 *
 * agentlas.cjs 가 helpers 객체로 DB 헬퍼들을 주입한다 (중복 구현 방지).
 */
const readline = require("node:readline");
const { Ui } = require("./agentlas-ui.cjs");
const banner = require("./agentlas-banner.cjs");
const { runNativeTurn } = require("./agentlas-native-host.cjs");
const { runApiTurn } = require("./agentlas-api-agent.cjs");

const TAGLINE = "보스턴테리어 터미널 — 로컬 에이전트 플랫폼";

function runtimeLabel(rt) {
  if (!rt) return "(없음)";
  if (rt.mode === "cli") return rt.kind;
  return `${rt.backend}${rt.model ? " · " + rt.model : ""}`;
}

// "## Memory Events" 트레일링 블록이 스트리밍 화면에 노출되지 않도록 막는 가드.
// 마지막 heading.length 글자를 hold-back 하여 분할된 heading도 안전 처리. acc 전체는 큐레이션용.
function makeMemoryGuard(ui, heading) {
  const N = heading.length;
  let acc = "";
  let printed = 0;
  let cut = false;
  const flush = () => {
    if (cut) return;
    const idx = acc.indexOf(heading);
    if (idx >= 0) {
      if (idx > printed) ui.streamDelta(acc.slice(printed, idx));
      printed = idx;
      cut = true;
    } else if (acc.length > printed) {
      ui.streamDelta(acc.slice(printed));
      printed = acc.length;
    }
  };
  return {
    c: ui.c,
    streamStart: () => ui.streamStart(),
    streamDelta: (t) => {
      if (cut) {
        acc += t;
        return;
      }
      acc += t;
      const idx = acc.indexOf(heading);
      if (idx >= 0) {
        if (idx > printed) ui.streamDelta(acc.slice(printed, idx));
        printed = idx;
        cut = true;
        return;
      }
      const safe = acc.length - N;
      if (safe > printed) {
        ui.streamDelta(acc.slice(printed, safe));
        printed = safe;
      }
    },
    streamEnd: () => {
      flush();
      ui.streamEnd();
    },
    tool: (...a) => ui.tool(...a),
    toolResult: (...a) => ui.toolResult(...a),
    info: (...a) => ui.info(...a),
    warn: (...a) => ui.warn(...a),
    error: (...a) => ui.error(...a),
    status: (...a) => ui.status(...a),
    ok: (...a) => ui.ok(...a),
    cost: (...a) => ui.cost(...a),
    line: (...a) => ui.line(...a),
  };
}

// startRepl({ db, subject, runtime, permission, cwd, helpers })
//   subject = { kind:'agent'|'firm', id, label, system }
//   runtime = resolveRuntime 결과 { mode:'cli', kind } | { mode:'api', backend, model }
function startRepl(opts) {
  const { db, helpers } = opts;
  const ui = new Ui();
  const H = opts.helpers;
  const state = {
    subject: opts.subject,
    runtime: opts.runtime,
    permission: opts.permission || "write",
    cwd: opts.cwd,
    history: [],
    native: {}, // kind → { id }
    projectPath: opts.projectPath || null,
  };

  function showBanner() {
    banner.renderBanner({
      ui,
      version: opts.version,
      runtimeLabel: runtimeLabel(state.runtime),
      subjectLabel: state.subject.label,
      permission: state.permission,
      cwd: state.cwd,
      tagline: TAGLINE,
    });
  }
  showBanner();

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: !!process.stdin.isTTY });
  let busy = false;
  let closed = false;
  let currentAbort = null;
  rl.on("close", () => {
    closed = true;
    if (!busy) process.exit(0);
  });

  rl.on("SIGINT", () => {
    if (busy && currentAbort) {
      currentAbort.abort();
      ui.warn("턴 중단됨");
    } else {
      ui.line("");
      ui.line(ui.c.paw("🐾 ") + ui.c.dim("bye"));
      rl.close();
      process.exit(0);
    }
  });

  function ctxNow() {
    return { projectPath: state.projectPath, agentId: state.subject.id, permission: state.permission, cwd: state.cwd };
  }

  // ── 한 턴 실행 ──
  async function runTurn(prompt) {
    busy = true;
    currentAbort = new AbortController();
    const signal = currentAbort.signal;
    const ctx = ctxNow();
    const rt = state.runtime;
    try {
      if (rt.mode === "cli") {
        const bin = H.which(H.RUNTIME_BIN[rt.kind]) || H.RUNTIME_BIN[rt.kind];
        const session = state.native[rt.kind] || (state.native[rt.kind] = {});
        const sys = H.augmentSystem(db, state.subject.system, ctx, false);
        const res = await runNativeTurn({
          kind: rt.kind,
          bin,
          prompt,
          systemPrompt: session.id ? "" : sys,
          cwd: state.cwd,
          permission: state.permission,
          session,
          ui,
          signal,
        });
        // 빈 응답(툴만/에러/중단)은 히스토리에 넣지 않는다 — 빈 content가 다음 턴 API를 깨뜨림(특히 Anthropic 400).
        const at = (res.text || "").trim();
        if (at && !res.error) state.history.push({ role: "user", text: prompt }, { role: "assistant", text: at });
      } else {
        // API 경로 — emitter 동봉 + 메모리 가드로 트레일링 블록 숨김 + 큐레이션.
        const sys = H.augmentSystem(db, state.subject.system, ctx, true);
        let apiKey = null;
        if (rt.backend !== "ollama") {
          apiKey = await H.apiKey(rt.backend);
          if (!apiKey) {
            ui.error(`${rt.backend} API 키가 없습니다. 앱 설정 → BYOK에서 키를 등록하거나 /runtime 으로 전환하세요.`);
            return;
          }
        }
        const messages = state.history
          .filter((h) => h.text && h.text.trim())
          .map((h) => ({ role: h.role, content: h.text }))
          .concat([{ role: "user", content: prompt }]);
        const guard = makeMemoryGuard(ui, H.eventsHeading());
        const res = await runApiTurn({
          backend: rt.backend,
          model: rt.model || H.defaultApiModel(rt.backend),
          apiKey,
          system: sys,
          messages,
          ctx,
          ui: guard,
          signal,
        });
        const cleaned = (H.curateCliReply(db, res.text || "", ctx) || "").trim();
        if (cleaned) state.history.push({ role: "user", text: prompt }, { role: "assistant", text: cleaned });
      }
    } catch (e) {
      ui.stopSpinner();
      if (signal.aborted) {
        // 사용자 Ctrl-C — SIGINT 핸들러가 이미 "턴 중단됨"을 출력함 (중복 방지)
      } else if (e && e.name === "AbortError") {
        ui.warn("응답이 지연되어 중단했습니다 (idle timeout)");
      } else {
        ui.error((e && e.message) || String(e));
      }
    } finally {
      busy = false;
      currentAbort = null;
    }
  }

  // ── 슬래시 커맨드 ──
  function setRuntime(arg) {
    const cliKinds = { "claude-code": 1, claude: 1, codex: 1, gemini: 1 };
    const apiBackends = { anthropic: 1, openai: 1, google: 1, ollama: 1 };
    let a = (arg || "").trim();
    if (a === "claude") a = "claude-code";
    if (cliKinds[a]) {
      const bin = H.which(H.RUNTIME_BIN[a]);
      if (!bin) return ui.error(`${a} CLI가 설치돼 있지 않습니다.`);
      state.runtime = { mode: "cli", kind: a };
      state.native = {};
      return ui.ok(`런타임 → ${a}`);
    }
    if (apiBackends[a]) {
      state.runtime =
        a === "ollama"
          ? { mode: "api", backend: "ollama", model: state.runtime.backend === "ollama" ? state.runtime.model : null }
          : { mode: "api", backend: a, model: null };
      return ui.ok(`런타임 → ${runtimeLabel(state.runtime)}`);
    }
    ui.warn("사용법: /runtime claude-code|codex|gemini|anthropic|openai|google|ollama");
  }

  function switchSubject(kind, query) {
    if (kind === "agent") {
      const agent = H.resolveAgent(db, query);
      if (!agent) return ui.error(`에이전트를 찾을 수 없습니다: ${query}`);
      state.subject = { kind: "agent", id: agent.id, label: agent.name, system: agent.system_prompt || `You are ${agent.name}.` };
    } else {
      const firm = H.resolveFirm(db, query);
      if (!firm) return ui.error(`회사를 찾을 수 없습니다: ${query}`);
      state.subject = { kind: "firm", id: firm.ceo_agent_id, label: firm.name + " CEO", system: H.firmSystemPrompt(db, firm) };
    }
    state.history = [];
    state.native = {};
    ui.ok(`전환 → ${state.subject.label}`);
  }

  async function handleSlash(line) {
    const [cmd, ...rest] = line.slice(1).split(/\s+/);
    const arg = rest.join(" ");
    switch (cmd) {
      case "help":
      case "?":
        printHelp(ui);
        return true;
      case "agents": {
        const ags = H.listAgents(db);
        ui.line("");
        for (const a of ags) ui.line("  " + ui.c.emerald(a.slug.padEnd(28)) + ui.c.text(a.name));
        return true;
      }
      case "firms": {
        const fs = H.listFirms(db);
        ui.line("");
        for (const f of fs) ui.line("  " + ui.c.emerald(f.slug.padEnd(28)) + ui.c.text(f.name) + ui.c.dim("  (CEO)"));
        return true;
      }
      case "agent":
        if (!arg) return ui.warn("사용법: /agent <name>"), true;
        switchSubject("agent", arg);
        return true;
      case "firm":
        if (!arg) return ui.warn("사용법: /firm <name>"), true;
        switchSubject("firm", arg);
        return true;
      case "runtime":
        setRuntime(arg);
        return true;
      case "model":
        if (state.runtime.mode !== "api") return ui.warn("model은 BYOK/Ollama(api) 런타임에서만 설정합니다."), true;
        state.runtime.model = arg || null;
        ui.ok(`model → ${state.runtime.model || "(기본값)"}`);
        return true;
      case "permission":
      case "perm": {
        const p = (arg || "").toLowerCase();
        if (!["read", "write", "full"].includes(p)) return ui.warn("사용법: /permission read|write|full"), true;
        state.permission = p;
        ui.ok(`권한 → ${p}`);
        return true;
      }
      case "cwd":
        if (arg) {
          const path = require("node:path");
          const fs = require("node:fs");
          const next = path.resolve(state.cwd, arg);
          if (!fs.existsSync(next)) return ui.error(`경로 없음: ${next}`), true;
          state.cwd = next;
          state.native = {}; // 작업 폴더 바뀌면 native 세션 리셋
          if (H.projectPathFor) state.projectPath = H.projectPathFor(db, next); // 메모리 주입/큐레이션도 새 폴더 기준으로
          ui.ok(`cwd → ${banner.shorten(next)}`);
        } else {
          ui.info(state.cwd);
        }
        return true;
      case "memory": {
        const mem = H.cliMemoryContext(db, state.projectPath);
        ui.line("");
        ui.markdown(mem || "(메모리 없음)");
        return true;
      }
      case "clear":
        state.history = [];
        state.native = {};
        if (ui.enabled) process.stdout.write("\x1b[2J\x1b[H");
        showBanner();
        return true;
      case "import":
        if (!arg) return ui.warn("사용법: /import <폴더경로>"), true;
        try {
          const r = H.importLocal(db, arg);
          ui.ok(`${r.updated ? "갱신" : "임포트"}: ${r.name} (${r.kind}) — /agent ${r.slug} 또는 /firm 으로 전환`);
        } catch (e) {
          ui.error((e && e.message) || String(e));
        }
        return true;
      case "doctor":
        H.doctor(db, ui);
        return true;
      case "status":
        banner.renderStatus({ ui, runtimeLabel: runtimeLabel(state.runtime), subjectLabel: state.subject.label, permission: state.permission, cwd: state.cwd });
        return true;
      case "exit":
      case "quit":
      case "q":
        ui.line(ui.c.paw("🐾 ") + ui.c.dim("bye"));
        rl.close();
        process.exit(0);
        return false;
      default:
        ui.warn(`알 수 없는 명령: /${cmd}  (/help)`);
        return true;
    }
  }

  // ── 메인 루프 ──
  function ask() {
    if (closed) return process.exit(0);
    rl.question("\n" + ui.promptLabel(), async (line) => {
      const t = (line || "").trim();
      if (!t) return ask();
      if (t.startsWith("/")) {
        const cont = await handleSlash(t);
        if (cont === false) return;
        return ask();
      }
      await runTurn(t);
      ask();
    });
  }
  ask();
}

function printHelp(ui) {
  const c = ui.c;
  const rows = [
    ["대화", "그냥 입력하면 현재 에이전트/회사가 응답 (스트리밍 + 툴)"],
    ["/agents", "설치된 에이전트 목록"],
    ["/agent <name>", "다른 에이전트로 전환"],
    ["/firms · /firm <name>", "회사(CEO) 목록 / 전환"],
    ["/runtime <kind>", "런타임 전환 (claude-code|codex|gemini|anthropic|openai|google|ollama)"],
    ["/model <id>", "BYOK/Ollama 모델 지정"],
    ["/permission <lvl>", "권한 (read|write|full)"],
    ["/cwd [path]", "작업 폴더 보기/변경"],
    ["/memory", "주입되는 메모리 컨텍스트 보기"],
    ["/import <path>", "로컬 폴더(에이전트/팀) 임포트"],
    ["/clear", "대화 비우고 화면 정리"],
    ["/doctor", "런타임/데이터 점검"],
    ["/exit", "종료 (Ctrl-C: 턴 중단 / 유휴 시 종료)"],
  ];
  ui.line("");
  for (const [k, v] of rows) ui.line("  " + c.emerald(k.padEnd(22)) + c.dim(v));
}

module.exports = { startRepl, runtimeLabel };
