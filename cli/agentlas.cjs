#!/usr/bin/env node
/*
 * Agentlas terminal CLI (Phase 1).
 *
 * 앱(GUI)과 같은 데이터를 공유한다 — 같은 userData의 SQLite, 같은 keychain(env).
 * Electron-as-Node로 실행되도록 설계: 앱이 번들한 네이티브 모듈(better-sqlite3 / keytar)을
 * 그대로 require 한다. (래퍼: ELECTRON_RUN_AS_NODE=1 <Agentlas execPath> <이 파일> ...)
 *
 * 명령:
 *   agentlas list                  설치된 에이전트/회사 + 활성 런타임
 *   agentlas cd <agent>            에이전트 폴더 경로 출력 (CLAUDE.md/AGENTS.md/GEMINI.md 생성)
 *                                  → cd "$(agentlas cd seo)" && claude
 *   agentlas run <agent> [prompt]  활성(또는 --runtime) CLI로 1회 실행. prompt 없으면 stdin.
 *   agentlas chat <agent>          대화형 REPL
 *   agentlas env [list]            공유 env 키 목록 (이름만)
 *   agentlas doctor                런타임/데이터 점검
 *   agentlas help
 *
 * 옵션: --runtime claude-code|codex|gemini
 */
"use strict";

const path = require("node:path");
const os = require("node:os");
const fs = require("node:fs");
const readline = require("node:readline");
const { spawn } = require("node:child_process");

// ── 앱과 동일한 userData 경로 (electron app.getPath('userData')와 일치) ──
function userDataDir() {
  const override = process.env.AGENTLAS_USER_DATA_DIR;
  if (override) return override;
  const home = os.homedir();
  if (process.platform === "darwin") return path.join(home, "Library", "Application Support", "Agentlas");
  if (process.platform === "win32") return path.join(process.env.APPDATA || path.join(home, "AppData", "Roaming"), "Agentlas");
  return path.join(process.env.XDG_CONFIG_HOME || path.join(home, ".config"), "Agentlas");
}

const SERVICE = "com.agentlas.desktop";
const ENV_PREFIX = "env:";

function dbPath() {
  return path.join(userDataDir(), "agentlas.sqlite");
}

function openDb() {
  let Database;
  try {
    Database = require("better-sqlite3");
  } catch (e) {
    fail(
      "better-sqlite3 모듈을 불러올 수 없습니다. agentlas CLI는 Agentlas 앱의 런타임으로 실행돼야 합니다.\n" +
        "(설정 → CLI 설치로 래퍼를 만들거나, 앱을 한 번 실행해 주세요.)\n" +
        String(e && e.message),
    );
  }
  const p = dbPath();
  if (!fs.existsSync(p)) {
    fail(`데이터를 찾을 수 없습니다: ${p}\nAgentlas 앱을 한 번 실행해 에이전트를 설치하세요.`);
  }
  return new Database(p, { readonly: false, fileMustExist: true });
}

function readKeytar() {
  try {
    return require("keytar");
  } catch {
    return null;
  }
}

// ── 데이터 접근 ────────────────────────────────────────────
function listAgents(db) {
  return db.prepare("SELECT * FROM installed_agents ORDER BY installed_at DESC").all();
}
function activeRuntime(db) {
  try {
    return db.prepare("SELECT * FROM active_runtime WHERE id = 1").get() || null;
  } catch {
    return null;
  }
}
function routesMap() {
  try {
    return JSON.parse(fs.readFileSync(path.join(userDataDir(), "agent-routes.json"), "utf8"));
  } catch {
    return {};
  }
}
function resolveAgent(db, query) {
  const agents = listAgents(db);
  const q = (query || "").toLowerCase();
  return (
    agents.find((a) => a.slug === query || a.id === query) ||
    agents.find((a) => (a.name || "").toLowerCase() === q || (a.name_en || "").toLowerCase() === q) ||
    agents.find((a) => (a.slug || "").toLowerCase().includes(q) || (a.name || "").toLowerCase().includes(q) || (a.name_en || "").toLowerCase().includes(q)) ||
    null
  );
}
function agentFolder(agent) {
  const routes = routesMap();
  const r = routes[agent.id];
  if (r && r.path) return r.path; // 로컬 임포트는 원본 폴더
  return path.join(userDataDir(), "agents", agent.slug);
}

// ── 런타임 CLI 스폰 ────────────────────────────────────────
const RUNTIME_BIN = {
  "claude-code": "claude",
  codex: "codex",
  gemini: "gemini",
};

function pickRuntimeKind(db, override) {
  if (override) {
    if (!RUNTIME_BIN[override]) fail(`알 수 없는 런타임: ${override} (claude-code|codex|gemini)`);
    return override;
  }
  const ar = activeRuntime(db);
  if (ar && RUNTIME_BIN[ar.kind]) return ar.kind;
  // 활성이 BYOK/Ollama거나 없으면 설치된 CLI를 탐지해 폴백
  for (const kind of Object.keys(RUNTIME_BIN)) {
    if (which(RUNTIME_BIN[kind])) return kind;
  }
  fail(
    "사용할 CLI 런타임을 찾지 못했습니다. Claude Code / Codex / Gemini CLI를 설치·로그인하거나 " +
      "--runtime 으로 지정하세요. (BYOK/Ollama는 앱 GUI에서 사용 — CLI 모드는 Phase 1에서 CLI 런타임만 지원)",
  );
}

function which(cmd) {
  const paths = (process.env.PATH || "").split(path.delimiter);
  const exts = process.platform === "win32" ? [".cmd", ".exe", ""] : [""];
  const extra = [
    path.join(os.homedir(), ".claude/local"),
    path.join(os.homedir(), ".codex/bin"),
    path.join(os.homedir(), ".gemini/bin"),
    "/opt/homebrew/bin",
    "/usr/local/bin",
  ];
  for (const dir of [...paths, ...extra]) {
    for (const ext of exts) {
      const full = path.join(dir, cmd + ext);
      try {
        fs.accessSync(full, fs.constants.X_OK);
        return full;
      } catch {
        /* next */
      }
    }
  }
  return null;
}

function runCwd() {
  const dir = path.join(userDataDir(), "agent-cwd");
  try {
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  } catch {
    return os.homedir();
  }
}

function buildArgs(kind, systemPrompt, prompt) {
  if (kind === "claude-code") return ["-p", prompt, "--append-system-prompt", systemPrompt];
  if (kind === "codex") return ["exec", "--skip-git-repo-check", `[SYSTEM]\n${systemPrompt}\n\n${prompt}`];
  if (kind === "gemini") return ["--prompt", `[SYSTEM]\n${systemPrompt}\n\n${prompt}`];
  return [prompt];
}

function spawnRuntime(kind, systemPrompt, prompt) {
  return new Promise((resolve) => {
    const bin = which(RUNTIME_BIN[kind]) || RUNTIME_BIN[kind];
    const child = spawn(bin, buildArgs(kind, systemPrompt, prompt), {
      cwd: runCwd(),
      stdio: ["ignore", "inherit", "inherit"],
      env: process.env,
    });
    child.on("error", (err) => {
      process.stderr.write(`\n실행 실패(${kind}): ${err.message}\n`);
      resolve(1);
    });
    child.on("close", (code) => resolve(code ?? 0));
  });
}

// ── 명령 구현 ──────────────────────────────────────────────
function cmdList(db) {
  const agents = listAgents(db);
  const ar = activeRuntime(db);
  out(`활성 런타임: ${ar ? `${ar.kind}${ar.backend ? " · " + ar.backend : ""}${ar.model ? " · " + ar.model : ""}` : "(없음)"}`);
  out(`설치된 에이전트 ${agents.length}개:`);
  const routes = routesMap();
  for (const a of agents) {
    const local = routes[a.id] ? "  [local]" : "";
    out(`  ${a.slug.padEnd(28)} ${a.name}${local}`);
  }
  out("\n실행: agentlas run <slug> \"프롬프트\"   ·   네이티브: cd \"$(agentlas cd <slug>)\" && claude");
}

function ensureNativeFiles(agent, folder) {
  fs.mkdirSync(folder, { recursive: true });
  const sys = agent.system_prompt || `You are ${agent.name}.`;
  writeIfMissing(path.join(folder, "system-prompt.md"), sys);
  const header = `# ${agent.name}\n\n${agent.tagline || ""}\n\n${sys}\n`;
  // 네이티브 CLI가 프로젝트 지시로 자동 인식하는 파일들
  writeIfMissing(path.join(folder, "CLAUDE.md"), header);
  writeIfMissing(path.join(folder, "AGENTS.md"), header);
  writeIfMissing(path.join(folder, "GEMINI.md"), header);
}
function writeIfMissing(file, content) {
  try {
    if (!fs.existsSync(file)) fs.writeFileSync(file, content.endsWith("\n") ? content : content + "\n", "utf8");
  } catch {
    /* ignore */
  }
}

function cmdCd(db, query) {
  const agent = resolveAgent(db, query);
  if (!agent) fail(`에이전트를 찾을 수 없습니다: ${query}`);
  const folder = agentFolder(agent);
  ensureNativeFiles(agent, folder);
  // 경로만 stdout으로 (cd "$(agentlas cd seo)") — 안내는 stderr로.
  process.stderr.write(`# ${agent.name} — 네이티브 CLI 컨텍스트(CLAUDE.md/AGENTS.md/GEMINI.md) 준비됨\n`);
  process.stdout.write(folder + "\n");
}

async function cmdRun(db, query, prompt, runtimeOverride) {
  const agent = resolveAgent(db, query);
  if (!agent) fail(`에이전트를 찾을 수 없습니다: ${query}`);
  let userPrompt = prompt;
  if (!userPrompt) userPrompt = await readStdin();
  if (!userPrompt || !userPrompt.trim()) fail("프롬프트가 비어 있습니다. agentlas run <agent> \"...\" 또는 stdin으로 전달하세요.");
  const kind = pickRuntimeKind(db, runtimeOverride);
  process.stderr.write(`▸ ${agent.name} (${kind})\n`);
  const code = await spawnRuntime(kind, agent.system_prompt || "", userPrompt.trim());
  process.exit(code);
}

async function cmdChat(db, query, runtimeOverride) {
  const agent = resolveAgent(db, query);
  if (!agent) fail(`에이전트를 찾을 수 없습니다: ${query}`);
  const kind = pickRuntimeKind(db, runtimeOverride);
  process.stderr.write(`▸ ${agent.name} (${kind}) — 종료: Ctrl+C 또는 빈 줄에 /exit\n`);
  const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
  const ask = () =>
    rl.question("\nyou › ", async (line) => {
      const t = (line || "").trim();
      if (t === "/exit" || t === "/quit") {
        rl.close();
        return;
      }
      if (!t) return ask();
      await spawnRuntime(kind, agent.system_prompt || "", t);
      ask();
    });
  ask();
}

function cmdEnv(db) {
  const keytar = readKeytar();
  if (!keytar) fail("keytar 모듈을 불러올 수 없습니다(앱 런타임으로 실행 필요).");
  keytar
    .findCredentials(SERVICE)
    .then((creds) => {
      const keys = creds.map((c) => c.account).filter((a) => a.startsWith(ENV_PREFIX)).map((a) => a.slice(ENV_PREFIX.length));
      out(`공유 env 키 ${keys.length}개 (값은 표시 안 함):`);
      for (const k of keys.sort()) out(`  ${k}`);
    })
    .catch((e) => fail("env 조회 실패: " + e.message));
}

function cmdDoctor(db) {
  out(`userData: ${userDataDir()}`);
  out(`db: ${fs.existsSync(dbPath()) ? "OK" : "없음"}`);
  const ar = activeRuntime(db);
  out(`활성 런타임: ${ar ? ar.kind : "(없음)"}`);
  for (const [kind, bin] of Object.entries(RUNTIME_BIN)) {
    const p = which(bin);
    out(`  ${kind.padEnd(12)} ${p ? "설치됨: " + p : "미설치(PATH에 없음)"}`);
  }
}

function cmdHelp() {
  out(
    [
      "agentlas — Agentlas 터미널 CLI",
      "",
      "  list                  에이전트/회사 + 활성 런타임",
      "  cd <agent>            에이전트 폴더 경로 (네이티브 CLI용) — cd \"$(agentlas cd seo)\" && claude",
      "  run <agent> [prompt]  활성 CLI로 1회 실행 (prompt 없으면 stdin)",
      "  chat <agent>          대화형 REPL",
      "  env                   공유 env 키 목록",
      "  doctor                런타임/데이터 점검",
      "",
      "옵션: --runtime claude-code|codex|gemini",
    ].join("\n"),
  );
}

// ── 유틸 ──────────────────────────────────────────────────
function out(s) {
  process.stdout.write(s + "\n");
}
function fail(msg) {
  process.stderr.write("✖ " + msg + "\n");
  process.exit(1);
}
function readStdin() {
  return new Promise((resolve) => {
    if (process.stdin.isTTY) return resolve("");
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (c) => (data += c));
    process.stdin.on("end", () => resolve(data));
  });
}

// ── 엔트리 ─────────────────────────────────────────────────
async function main() {
  const argv = process.argv.slice(2);
  let runtimeOverride = null;
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--runtime") {
      runtimeOverride = argv[++i];
    } else {
      rest.push(argv[i]);
    }
  }
  const cmd = rest[0] || "help";
  if (cmd === "help" || cmd === "--help" || cmd === "-h") return cmdHelp();

  const db = openDb();
  switch (cmd) {
    case "list":
      return cmdList(db);
    case "cd":
      return cmdCd(db, rest[1]);
    case "run":
      return cmdRun(db, rest[1], rest.slice(2).join(" "), runtimeOverride);
    case "chat":
      return cmdChat(db, rest[1], runtimeOverride);
    case "env":
      return cmdEnv(db);
    case "doctor":
      return cmdDoctor(db);
    default:
      process.stderr.write(`알 수 없는 명령: ${cmd}\n\n`);
      return cmdHelp();
  }
}

main().catch((e) => fail(String(e && e.stack ? e.stack : e)));
