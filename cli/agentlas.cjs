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

// ── Agentlas 아키텍처 (앱과 동일한 빌트인 에이전트 + 메모리) ────────────
// cli/architecture.data.json은 컴파일된 manifest에서 생성됨(scripts/gen-cli-architecture.mjs).
let _arch = null;
function loadArch() {
  if (_arch) return _arch;
  try {
    _arch = require("./architecture.data.json");
  } catch {
    _arch = { version: "0", agents: [], emitterBlock: "", eventsHeading: "## Memory Events", memoryDir: ".agentlas", soulFile: "project-soul-memory.md", sitemapFile: "sitemap.json", logFile: "memory-log.jsonl", kinds: [], scopes: [] };
  }
  return _arch;
}
function tableExists(db, name) {
  try { return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name); } catch { return false; }
}
function columnExists(db, table, col) {
  try { return db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === col); } catch { return false; }
}
// 앱의 seedBuiltinAgents와 동일한 멱등·버전 게이팅 로직(CJS 버전). 스키마가 아직 v12가 아니면
// (= 앱이 마이그레이션 전) 건너뜀 — 앱을 한 번 켜면 마이그레이션+시드가 수행된다.
function seedBuiltins(db) {
  const arch = loadArch();
  if (!arch.agents || !arch.agents.length) return;
  if (!tableExists(db, "meta") || !columnExists(db, "installed_agents", "builtin")) return;
  let installedVersion = null;
  try {
    const r = db.prepare("SELECT value FROM meta WHERE key='architecture_version'").get();
    installedVersion = r ? r.value : null;
  } catch { return; }
  if (installedVersion === arch.version) {
    try {
      const have = db.prepare("SELECT COUNT(*) AS n FROM installed_agents WHERE builtin=1").get();
      if (have.n >= arch.agents.length) return;
    } catch { /* fallthrough */ }
  }
  const now = new Date().toISOString();
  try {
    const tx = db.transaction(() => {
      for (const def of arch.agents) {
        const existing = db.prepare("SELECT id FROM installed_agents WHERE id=? OR slug=?").get(def.id, def.slug);
        if (existing) {
          db.prepare(
            "UPDATE installed_agents SET name=?, name_en=?, tagline=?, tagline_en=?, system_prompt=?, tone=?, role=?, builtin=1, trust_grade='A' WHERE id=?",
          ).run(def.name, def.nameEn, def.tagline, def.taglineEn, def.systemPrompt, def.tone, def.role, existing.id);
        } else {
          db.prepare(
            "INSERT INTO installed_agents (id, slug, name, name_en, tagline, tagline_en, system_prompt, mcp_servers_json, env_requirements_json, preferred_backend, trust_grade, installed_at, tone, builtin, role) VALUES (?,?,?,?,?,?,?,'[]','[]',NULL,'A',?,?,1,?)",
          ).run(def.id, def.slug, def.name, def.nameEn, def.tagline, def.taglineEn, def.systemPrompt, now, def.tone, def.role);
        }
      }
      db.prepare("INSERT INTO meta(key,value) VALUES('architecture_version',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(arch.version);
    });
    tx();
  } catch { /* best-effort */ }
}

const SECRET_RE = [/\b(?:sk|pk|rk)-[A-Za-z0-9]{16,}/, /AKIA[0-9A-Z]{16}/, /ghp_[A-Za-z0-9]{20,}/, /xox[baprs]-[A-Za-z0-9-]{10,}/, /-----BEGIN [A-Z ]*PRIVATE KEY-----/, /\b(?:password|passwd|secret|api[_-]?key|access[_-]?token|bearer)\b\s*[:=]\s*\S+/i];

function ensureProjectMemoryCli(projectPath, projectName) {
  const arch = loadArch();
  try {
    const dir = path.join(projectPath, arch.memoryDir);
    fs.mkdirSync(dir, { recursive: true });
    const name = projectName || path.basename(projectPath) || "Project";
    const soul = path.join(dir, arch.soulFile);
    if (!fs.existsSync(soul)) {
      fs.writeFileSync(soul, `# Project Soul Memory: ${name}\n\nDurable memory for this project folder, maintained by Agentlas.\n\n## Project Purpose\n\n## Current State\n\n## Decisions\n\n## Risks\n\n## Auto-curated memory\n`, "utf8");
    }
    const sitemap = path.join(dir, arch.sitemapFile);
    if (!fs.existsSync(sitemap)) {
      const now = new Date().toISOString();
      fs.writeFileSync(sitemap, JSON.stringify({ project: name, created_at: now, updated_at: now, nodes: [] }, null, 2), "utf8");
    }
    return dir;
  } catch { return null; }
}
function logCli(projectPath, rec) {
  if (!projectPath) return;
  try {
    const dir = ensureProjectMemoryCli(projectPath);
    if (!dir) return;
    fs.appendFileSync(path.join(dir, loadArch().logFile), JSON.stringify(rec) + "\n", "utf8");
  } catch { /* ignore */ }
}
// 작업 폴더 반복 방문 → 활성화(.agentlas 생성). 앱의 activation.ts와 동일한 정책(2회).
function recordCliFolderVisit(db, projectPath) {
  if (!tableExists(db, "folder_activity")) return { activated: false };
  const now = new Date().toISOString();
  try {
    const row = db.prepare("SELECT visits, activated_at FROM folder_activity WHERE path=?").get(projectPath);
    let visits, activatedAt;
    if (row) {
      visits = row.visits + 1; activatedAt = row.activated_at;
      db.prepare("UPDATE folder_activity SET visits=?, last_seen=? WHERE path=?").run(visits, now, projectPath);
    } else {
      visits = 1; activatedAt = null;
      db.prepare("INSERT INTO folder_activity (path, visits, activated_at, first_seen, last_seen) VALUES (?,?,NULL,?,?)").run(projectPath, visits, now, now);
    }
    if (!activatedAt && visits >= 2) {
      db.prepare("UPDATE folder_activity SET activated_at=? WHERE path=?").run(now, projectPath);
      ensureProjectMemoryCli(projectPath);
      activatedAt = now;
    }
    return { activated: !!activatedAt };
  } catch { return { activated: false }; }
}
// `agentlas run` 등이 호출된 작업 디렉터리 → 활성 프로젝트 경로(또는 null).
function activeProjectPath(db) {
  try {
    const cwd = process.cwd();
    if (cwd === os.homedir() || cwd === userDataDir() || cwd === runCwd()) return null;
    const v = recordCliFolderVisit(db, cwd);
    return v.activated ? cwd : null;
  } catch { return null; }
}
function cliMemoryContext(db, projectPath) {
  const sections = [];
  const arch = loadArch();
  if (projectPath) {
    try {
      const soulPath = path.join(projectPath, arch.memoryDir, arch.soulFile);
      if (fs.existsSync(soulPath)) {
        let s = fs.readFileSync(soulPath, "utf8");
        if (s.length > 1800) s = s.slice(0, 1800) + "\n…(truncated)";
        if (s.trim()) sections.push(`### Project memory (${projectPath})\n${s.trim()}`);
      }
    } catch { /* ignore */ }
  }
  if (tableExists(db, "memory_entries")) {
    try {
      const rows = projectPath
        ? db.prepare("SELECT kind, content FROM memory_entries WHERE project_path=? AND superseded_at IS NULL AND scope!='session' ORDER BY created_at DESC LIMIT 12").all(projectPath)
        : db.prepare("SELECT kind, content FROM memory_entries WHERE project_path IS NULL AND scope!='session' AND superseded_at IS NULL ORDER BY created_at DESC LIMIT 12").all();
      if (rows.length) sections.push((projectPath ? "### Recent curated memory\n" : "### Curated memory (global)\n") + rows.map((r) => `- [${r.kind}] ${r.content}`).join("\n"));
    } catch { /* ignore */ }
  }
  if (!sections.length) return "";
  return "## Agentlas memory (read before answering; build on it)\n\n" + sections.join("\n\n");
}
function parseMemoryEventsCli(text) {
  const heading = loadArch().eventsHeading;
  const idx = text.lastIndexOf(heading);
  if (idx < 0) return { events: [], cleaned: text.trim() };
  const after = text.slice(idx + heading.length);
  const fence = after.match(/```(?:json)?\s*([\s\S]*?)```/);
  let events = [];
  if (fence) { try { const d = JSON.parse(fence[1].trim()); if (Array.isArray(d)) events = d; } catch { /* ignore */ } }
  let cut = text.length;
  if (fence && fence.index != null) cut = idx + heading.length + fence.index + fence[0].length;
  else cut = idx;
  return { events, cleaned: (text.slice(0, idx) + text.slice(cut)).trim() };
}
function curateCliReply(db, text, ctx) {
  const { events, cleaned } = parseMemoryEventsCli(text);
  if (!events.length || !tableExists(db, "memory_entries")) return cleaned;
  const arch = loadArch();
  const { randomUUID } = require("node:crypto");
  const now = new Date().toISOString();
  for (const ev of events) {
    const content = ev && typeof ev.content === "string" ? ev.content.trim() : "";
    if (!content) continue;
    if (ev.sensitivity === "secret" || SECRET_RE.some((re) => re.test(content))) continue;
    const kind = arch.kinds.includes(ev.memory_kind) ? ev.memory_kind : "fact";
    let scope = arch.scopes.includes(ev.suggested_scope) ? ev.suggested_scope : "session";
    if (scope === "discard" || scope === "session") { logCli(ctx.projectPath, { action: scope, kind, content, at: now }); continue; }
    if (scope === "project" && !ctx.projectPath) scope = "agent_team";
    const ppath = scope === "project" ? ctx.projectPath : null;
    try {
      const dup = db.prepare("SELECT 1 FROM memory_entries WHERE scope=? AND kind=? AND lower(trim(content))=? AND superseded_at IS NULL AND (project_path IS ? OR project_path=?) LIMIT 1").get(scope, kind, content.toLowerCase(), ppath, ppath);
      if (dup) continue;
      db.prepare("INSERT INTO memory_entries (id,scope,kind,content,project_id,project_path,agent_id,chat_id,confidence,sensitivity,evidence_json,superseded_at,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,NULL,?)").run(randomUUID(), scope, kind, content, null, ppath, ctx.agentId || null, null, ev.confidence || "medium", ev.sensitivity || "internal", JSON.stringify(Array.isArray(ev.evidence_refs) ? ev.evidence_refs : []), now);
      logCli(ctx.projectPath, { action: "written", scope, kind, content, at: now });
    } catch { /* ignore */ }
  }
  return cleaned;
}
function augmentSystem(db, baseSystem, ctx, withEmitter) {
  const arch = loadArch();
  let sys = baseSystem || "";
  const mem = cliMemoryContext(db, ctx && ctx.projectPath);
  if (mem) sys += "\n\n" + mem;
  if (withEmitter && arch.emitterBlock) sys += "\n\n" + arch.emitterBlock;
  return sys;
}

// ── 런타임 CLI 스폰 ────────────────────────────────────────
const RUNTIME_BIN = {
  "claude-code": "claude",
  codex: "codex",
  gemini: "gemini",
};

// 활성 런타임 → 실행 방식 결정. CLI(claude/codex/gemini) 또는 API(BYOK/Ollama).
function resolveRuntime(db, override) {
  if (override) {
    if (!RUNTIME_BIN[override]) fail(`알 수 없는 런타임: ${override} (claude-code|codex|gemini)`);
    return { mode: "cli", kind: override };
  }
  const ar = activeRuntime(db);
  if (ar && RUNTIME_BIN[ar.kind]) return { mode: "cli", kind: ar.kind };
  if (ar && ar.kind === "byok" && ar.backend) return { mode: "api", backend: ar.backend, model: ar.model };
  if (ar && ar.kind === "ollama") return { mode: "api", backend: "ollama", model: ar.model };
  // 폴백: 설치된 CLI 탐지
  for (const kind of Object.keys(RUNTIME_BIN)) {
    if (which(RUNTIME_BIN[kind])) return { mode: "cli", kind };
  }
  fail("사용할 런타임이 없습니다. CLI(claude/codex/gemini)를 설치하거나 앱에서 API 키/Ollama를 설정하세요.");
}

// ── API 러너 (BYOK / Ollama) — 비스트리밍, 최종 텍스트 반환 ──
const DEFAULT_API_MODEL = {
  anthropic: "claude-sonnet-4-5",
  openai: "gpt-4o-mini",
  google: "gemini-1.5-flash",
  ollama: "llama3.1",
};
async function apiKey(backend) {
  const keytar = readKeytar();
  if (!keytar) return null;
  return keytar.getPassword(SERVICE, "byok:" + backend);
}
async function runApi(backend, model, system, prompt) {
  model = model || DEFAULT_API_MODEL[backend];
  if (typeof fetch !== "function") fail("이 런타임에 fetch가 없습니다(앱 런타임으로 실행 필요).");
  if (backend === "ollama") {
    const resp = await fetch("http://127.0.0.1:11434/api/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model, stream: false, messages: [{ role: "system", content: system }, { role: "user", content: prompt }] }),
    });
    if (!resp.ok) fail(`Ollama ${resp.status} — 'ollama serve' 실행/모델 확인`);
    const j = await resp.json();
    return (j.message && j.message.content) || "";
  }
  const key = await apiKey(backend);
  if (!key) fail(`${backend} API 키가 없습니다. 앱 설정 → BYOK에서 키를 등록하세요.`);
  if (backend === "anthropic") {
    const resp = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({ model, max_tokens: 4096, system, messages: [{ role: "user", content: prompt }] }),
    });
    if (!resp.ok) fail(`Anthropic ${resp.status}: ${(await resp.text().catch(() => "")).slice(0, 200)}`);
    const j = await resp.json();
    return (j.content && j.content[0] && j.content[0].text) || "";
  }
  if (backend === "openai") {
    const resp = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer " + key },
      body: JSON.stringify({ model, messages: [{ role: "system", content: system }, { role: "user", content: prompt }] }),
    });
    if (!resp.ok) fail(`OpenAI ${resp.status}: ${(await resp.text().catch(() => "")).slice(0, 200)}`);
    const j = await resp.json();
    return (j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content) || "";
  }
  if (backend === "google") {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(key)}`;
    const resp = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ systemInstruction: { parts: [{ text: system }] }, contents: [{ role: "user", parts: [{ text: prompt }] }] }),
    });
    if (!resp.ok) fail(`Google ${resp.status}: ${(await resp.text().catch(() => "")).slice(0, 200)}`);
    const j = await resp.json();
    const c = j.candidates && j.candidates[0];
    return (c && c.content && c.content.parts && c.content.parts[0] && c.content.parts[0].text) || "";
  }
  fail("지원하지 않는 backend: " + backend);
}

// 1회 실행 — CLI면 spawn(스트리밍 stdout), API면 호출 후 텍스트 출력. 종료코드 반환.
// ctx = { projectPath, agentId } — 메모리 주입/큐레이션에 사용.
async function executeOnce(db, system, prompt, override, ctx) {
  ctx = ctx || { projectPath: null, agentId: null };
  const rt = resolveRuntime(db, override);
  if (rt.mode === "cli") {
    // 네이티브 CLI는 자체 세션을 가지므로 emitter는 넣지 않고(노이즈 방지) 메모리 컨텍스트만 주입.
    const sys = augmentSystem(db, system, ctx, false);
    process.stderr.write(`▸ ${rt.kind}\n`);
    return spawnRuntime(rt.kind, sys, prompt);
  }
  // API 경로 — emitter 동봉 → 답변에서 메모리 이벤트를 파싱·큐레이션하고 블록은 제거.
  const sys = augmentSystem(db, system, ctx, true);
  process.stderr.write(`▸ ${rt.backend}${rt.model ? " · " + rt.model : ""}\n`);
  const text = await runApi(rt.backend, rt.model, sys, prompt);
  const cleaned = curateCliReply(db, text || "", ctx);
  process.stdout.write((cleaned || "").trim() + "\n");
  return 0;
}

// API 백엔드용 간이 대화형 REPL (네이티브 인터랙티브가 없는 BYOK/Ollama).
// 매 턴 메모리 컨텍스트 + emitter를 주입하고 답변에서 메모리를 큐레이션한다.
function apiRepl(db, backend, model, system, label, ctx) {
  ctx = ctx || { projectPath: null, agentId: null };
  const readline = require("node:readline");
  process.stderr.write(`▸ ${label} (${backend}${model ? " · " + model : ""}) — 종료: /exit\n`);
  const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
  const ask = () =>
    rl.question("\nyou › ", async (line) => {
      const tt = (line || "").trim();
      if (tt === "/exit" || tt === "/quit") return rl.close();
      if (!tt) return ask();
      try {
        const sys = augmentSystem(db, system, ctx, true);
        const text = await runApi(backend, model, sys, tt);
        const cleaned = curateCliReply(db, text || "", ctx);
        process.stdout.write("\n" + (cleaned || "").trim() + "\n");
      } catch (e) {
        process.stderr.write("✖ " + (e && e.message) + "\n");
      }
      ask();
    });
  ask();
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

// `claude` 치면 바로 대화형 세션 뜨듯이 — 에이전트 폴더(CLAUDE.md/AGENTS.md/GEMINI.md 보유)에서
// 네이티브 CLI를 인자 없이(대화형) 실행. 에이전트 페르소나는 그 폴더의 프로젝트 지시로 자동 로드. (A+B 결합)
function launchInteractive(db, agent, runtimeOverride) {
  const rt = resolveRuntime(db, runtimeOverride);
  const folder = agentFolder(agent);
  ensureNativeFiles(agent, folder);
  if (rt.mode === "cli") {
    const bin = which(RUNTIME_BIN[rt.kind]) || RUNTIME_BIN[rt.kind];
    process.stderr.write(`▸ ${agent.name} (${rt.kind}) — ${folder}\n`);
    const child = spawn(bin, [], { cwd: folder, stdio: "inherit", env: process.env });
    child.on("error", (err) => fail(`실행 실패(${rt.kind}): ${err.message}`));
    child.on("close", (code) => process.exit(code ?? 0));
    return;
  }
  // BYOK/Ollama는 네이티브 인터랙티브가 없으므로 API REPL로 대화.
  apiRepl(db, rt.backend, rt.model, agent.system_prompt || "", agent.name, { projectPath: activeProjectPath(db), agentId: agent.id });
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
    const arch = a.builtin ? "  [아키텍처]" : "";
    out(`  ${a.slug.padEnd(28)} ${a.name}${arch}${local}`);
  }
  const firms = listFirms(db);
  if (firms.length) {
    out(`\n회사 ${firms.length}개:`);
    for (const f of firms) out(`  ${f.slug.padEnd(28)} ${f.name}  (CEO)`);
  }
  out("\n실행: agentlas <agent>  ·  agentlas firm <firm>  ·  agentlas run <agent> \"...\"  ·  cd \"$(agentlas cd seo)\" && claude");
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
  process.stderr.write(`▸ ${agent.name}\n`);
  const code = await executeOnce(db, agent.system_prompt || "", userPrompt.trim(), runtimeOverride, { projectPath: activeProjectPath(db), agentId: agent.id });
  process.exit(code);
}

// chat / open / 에이전트명 단독 → 네이티브 CLI 대화형 세션 (claude처럼 바로 접속)
function cmdOpen(db, query, runtimeOverride) {
  const agent = resolveAgent(db, query);
  if (!agent) fail(`에이전트를 찾을 수 없습니다: ${query}`);
  launchInteractive(db, agent, runtimeOverride);
}

// ── 회사(firm) — CEO 위임 실행 ─────────────────────────────
function listFirms(db) {
  try {
    return db.prepare("SELECT * FROM firms ORDER BY installed_at DESC").all();
  } catch {
    return [];
  }
}
function resolveFirm(db, query) {
  const firms = listFirms(db);
  const q = (query || "").toLowerCase();
  return (
    firms.find((f) => f.slug === query || f.id === query) ||
    firms.find((f) => (f.name || "").toLowerCase() === q) ||
    firms.find((f) => (f.slug || "").toLowerCase().includes(q) || (f.name || "").toLowerCase().includes(q)) ||
    null
  );
}
function firmSystemPrompt(db, firm) {
  const ceo = db.prepare("SELECT * FROM installed_agents WHERE id = ?").get(firm.ceo_agent_id);
  let roster = "";
  try {
    const org = JSON.parse(firm.org_chart_json);
    roster = org
      .map((n) => `  - ${n.role}: ${n.agentSlug}${n.reportsTo ? ` (reports to ${n.reportsTo})` : ""}`)
      .join("\n");
  } catch {
    /* ignore */
  }
  const base = (ceo && ceo.system_prompt) || `You are the CEO of ${firm.name}.`;
  return `${base}\n\n[FIRM] 당신은 '${firm.name}' 회사의 CEO입니다. 사용자 명령을 부서에 위임해 처리하세요.\n조직도:\n${roster}`;
}
async function cmdFirm(db, query, prompt, runtimeOverride) {
  const firm = resolveFirm(db, query);
  if (!firm) fail(`회사를 찾을 수 없습니다: ${query}`);
  const sys = firmSystemPrompt(db, firm);
  if (prompt && prompt.trim()) {
    process.stderr.write(`▸ ${firm.name} CEO\n`);
    const code = await executeOnce(db, sys, prompt.trim(), runtimeOverride, { projectPath: activeProjectPath(db), agentId: firm.ceo_agent_id });
    process.exit(code);
  }
  // 대화형: firm 폴더에 CEO 컨텍스트를 깔고 네이티브 CLI, 또는 API REPL.
  const rt = resolveRuntime(db, runtimeOverride);
  const folder = path.join(userDataDir(), "firms", firm.slug);
  fs.mkdirSync(folder, { recursive: true });
  const header = `# ${firm.name} — CEO\n\n${sys}\n`;
  writeIfMissing(path.join(folder, "CLAUDE.md"), header);
  writeIfMissing(path.join(folder, "AGENTS.md"), header);
  writeIfMissing(path.join(folder, "GEMINI.md"), header);
  if (rt.mode === "cli") {
    const bin = which(RUNTIME_BIN[rt.kind]) || RUNTIME_BIN[rt.kind];
    process.stderr.write(`▸ ${firm.name} CEO (${rt.kind}) — ${folder}\n`);
    const child = spawn(bin, [], { cwd: folder, stdio: "inherit", env: process.env });
    child.on("error", (err) => fail(`실행 실패(${rt.kind}): ${err.message}`));
    child.on("close", (code) => process.exit(code ?? 0));
    return;
  }
  apiRepl(db, rt.backend, rt.model, sys, firm.name + " CEO", { projectPath: activeProjectPath(db), agentId: firm.ceo_agent_id });
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
      "  agentlas <agent>      claude처럼 바로 대화형 세션 (에이전트 페르소나 로드)",
      "  agentlas              (에이전트 1개면 바로 대화형, 아니면 목록)",
      "  open <agent>          위와 동일 (명시적)",
      "  firm <firm> [cmd]     회사 CEO에 위임 (cmd 없으면 대화형)",
      "  run <agent> [prompt]  1회 실행 — 스크립트/파이프용 (prompt 없으면 stdin)",
      "  cd <agent>            에이전트 폴더 경로 — cd \"$(agentlas cd seo)\" && claude",
      "  (BYOK/Ollama 활성 시 run/대화형은 API로 호출)",
      "  list                  에이전트/회사 + 활성 런타임",
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
  const cmd = rest[0] || "";
  if (cmd === "help" || cmd === "--help" || cmd === "-h") return cmdHelp();

  const db = openDb();

  // Agentlas 아키텍처 빌트인 에이전트를 보장(앱과 동일, 멱등·버전 게이팅). 스키마가 준비됐을 때만.
  try { seedBuiltins(db); } catch { /* best-effort */ }

  // 인자 없이 `agentlas` → 에이전트 1개면 바로 대화형, 아니면 목록 + 사용법
  if (cmd === "") {
    const agents = listAgents(db);
    if (agents.length === 1) return launchInteractive(db, agents[0], runtimeOverride);
    cmdList(db);
    out("\n사용: agentlas <agent>  (claude처럼 바로 대화형) · agentlas run <agent> \"...\" · agentlas help");
    return;
  }

  switch (cmd) {
    case "list":
      return cmdList(db);
    case "cd":
      return cmdCd(db, rest[1]);
    case "run":
      return cmdRun(db, rest[1], rest.slice(2).join(" "), runtimeOverride);
    case "chat":
    case "open":
      return cmdOpen(db, rest[1], runtimeOverride);
    case "firm":
      return cmdFirm(db, rest[1], rest.slice(2).join(" "), runtimeOverride);
    case "env":
      return cmdEnv(db);
    case "doctor":
      return cmdDoctor(db);
    default: {
      // 알려진 명령이 아니면 에이전트명 → (없으면) 회사명 → 대화형 세션
      const agent = resolveAgent(db, cmd);
      if (agent) return launchInteractive(db, agent, runtimeOverride);
      const firm = resolveFirm(db, cmd);
      if (firm) return cmdFirm(db, cmd, "", runtimeOverride);
      fail(`에이전트/회사를 찾을 수 없습니다: ${cmd}  (agentlas list 로 확인)`);
    }
  }
}

main().catch((e) => fail(String(e && e.stack ? e.stack : e)));
