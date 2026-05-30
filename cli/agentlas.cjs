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
// 도구 사용 권한 (read|write|full). 빌드/파일 생성이 기본 동작이므로 기본값 write.
// `--permission full` 로 셸 명령 포함 전체 자동(npm/mkdir 등) 허용. main()에서 설정.
let PERMISSION = "write";
let PERMISSION_EXPLICIT = false; // true once --permission is passed (overrides saved prefs)

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

// ── 로컬 폴더 임포트 (앱의 electron/agents/import-local.ts 와 동일 규칙) ──
// 터미널에서 "폴더 드래그" = `agentlas import <path>`. 앱과 같은 DB/라우트를 공유한다.
function exists(p) { try { fs.accessSync(p); return true; } catch { return false; } }
function isDir(p) { try { return fs.statSync(p).isDirectory(); } catch { return false; } }
function readFileSafe(p, maxChars) {
  try { const s = fs.readFileSync(p, "utf8"); return maxChars ? s.slice(0, maxChars) : s; } catch { return ""; }
}
function readFirst(dir, names, maxChars) {
  for (const n of names) {
    const p = path.join(dir, n);
    if (exists(p) && !isDir(p)) { const s = readFileSafe(p, maxChars || 8000); if (s) return s; }
  }
  return "";
}
function detectRuntimeLabels(dir) {
  const labels = [];
  if (exists(path.join(dir, "CLAUDE.md")) || isDir(path.join(dir, ".claude"))) labels.push("claude-code");
  if (exists(path.join(dir, "AGENTS.md"))) labels.push("codex");
  if (exists(path.join(dir, "GEMINI.md"))) labels.push("gemini");
  if (isDir(path.join(dir, ".cursor")) || exists(path.join(dir, ".cursorrules"))) labels.push("cursor");
  if (!labels.length) labels.push("generic");
  return labels;
}
// 팀 감지 — 루트뿐 아니라 .claude/ 중첩 구조도 인식한다 (appbridge 처럼).
function detectKind(dir) {
  const rootMarkers = ["TEAM.md", "ceo", "hr-departments", "projects"];
  for (const m of rootMarkers) if (exists(path.join(dir, m))) return "team";
  const nestedMarkers = [".claude/ceo", ".claude/hr-departments", ".claude/agents", ".claude/orgspec.yaml"];
  for (const m of nestedMarkers) if (exists(path.join(dir, m))) return "team";
  return "agent";
}
function readImportName(dir) {
  const text = readFirst(dir, ["manifest.md", "AGENT.md", "CLAUDE.md", "README.md"], 2000);
  const m = text.match(/^#\s+(.+)$/m);
  if (m) { const n = m[1].replace(/\(.*?\)/g, "").trim().slice(0, 60); if (n) return n; }
  return path.basename(dir);
}
function readImportTagline(dir) {
  const text = readFirst(dir, ["README.md", "soul.md", "AGENT.md"], 2000);
  for (const line of text.split("\n")) {
    const t = line.trim();
    if (t && !t.startsWith("#") && !t.startsWith(">")) return t.slice(0, 140);
  }
  // 팀 orgspec mission 첫 줄 fallback
  const org = readFileSafe(path.join(dir, ".claude", "orgspec.yaml"), 4000);
  const mm = org.match(/mission:\s*\|?\s*\n?\s*(.+)/);
  if (mm) return mm[1].trim().slice(0, 140);
  return "";
}
// 팀이면 CEO 두뇌를 시스템 프롬프트로 잡고, 임의 cwd에서도 동작하도록 절대경로 헤더를 붙인다.
function buildImportSystemPrompt(dir, name, kind) {
  if (kind === "team") {
    const ceoBrain = readFileSafe(path.join(dir, ".claude", "ceo", "AGENT.md"));
    const rootAgents = readFileSafe(path.join(dir, "AGENTS.md"));
    const rootClaude = readFileSafe(path.join(dir, "CLAUDE.md"));
    const nestedClaude = readFileSafe(path.join(dir, ".claude", "CLAUDE.md"));
    let brain = ceoBrain || rootAgents || rootClaude || nestedClaude;
    const claudeRoot = path.join(dir, ".claude");
    const header =
      `You are the CEO / orchestrator of the "${name}" agent team, now launched through Agentlas.\n\n` +
      `TEAM ROOT: ${dir}\n` +
      `Team definition (org spec, playbooks, department & role agents) lives under: ${claudeRoot}\n` +
      `When the instructions below reference team files with relative paths (e.g. ./playbook.md, ../orgspec.yaml, .claude/...), resolve them as ABSOLUTE paths under that team root and read them as needed.\n\n` +
      `TARGET PROJECT: your current working directory is the user's target project. Do ALL building, file creation, and delivery in the current working directory — never inside the team root. Route work to the right department/specialist, sequence multi-step work, keep a brief CEO-style status in Korean, and apply read-only-first safety gates for high-risk actions (billing/auth/security/deploy).\n\n` +
      `--- TEAM BRAIN ---\n`;
    return (header + (brain || `Act as the orchestrating CEO of ${name}.`)).slice(0, 16000);
  }
  const sys = readFirst(dir, ["system-prompt.md", "soul.md", "AGENT.md", "CLAUDE.md", "AGENTS.md", "GEMINI.md"]);
  return sys || `You are ${name}, a locally imported agent.`;
}
function importLocalFolderCli(db, absPath) {
  const dir = path.resolve(absPath);
  if (!isDir(dir)) fail(`폴더가 아닙니다: ${absPath}`);
  const labels = detectRuntimeLabels(dir);
  const runtime = labels[0];
  const kind = detectKind(dir);
  const name = readImportName(dir);
  const tagline = readImportTagline(dir) || (kind === "team" ? "Imported local team" : "Imported local agent");
  const systemPrompt = buildImportSystemPrompt(dir, name, kind);

  // 같은 경로가 이미 임포트돼 있으면 그 에이전트를 갱신(멱등).
  const routes = routesMap();
  let existingId = null;
  for (const [aid, r] of Object.entries(routes)) {
    if (r && path.resolve(r.path || "") === dir) { existingId = aid; break; }
  }
  const now = new Date().toISOString();
  const TONES = ["blue", "green", "purple", "amber", "peach"];
  let id, slug;
  if (existingId) {
    id = existingId;
    const row = db.prepare("SELECT slug FROM installed_agents WHERE id=?").get(id);
    slug = row ? row.slug : null;
    if (slug) {
      db.prepare("UPDATE installed_agents SET name=?, name_en=?, tagline=?, tagline_en=?, system_prompt=? WHERE id=?")
        .run(name, name, tagline, tagline, systemPrompt, id);
    } else { existingId = null; }
  }
  if (!existingId) {
    const base = "local-" + (path.basename(dir).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "agent");
    slug = base; let n = 1;
    while (db.prepare("SELECT 1 FROM installed_agents WHERE slug=?").get(slug)) slug = `${base}-${++n}`;
    id = require("node:crypto").randomUUID();
    let h = 0; for (let i = 0; i < slug.length; i++) h = (h << 5) - h + slug.charCodeAt(i);
    const tone = TONES[Math.abs(h) % TONES.length];
    db.prepare(
      "INSERT INTO installed_agents (id, slug, name, name_en, tagline, tagline_en, system_prompt, mcp_servers_json, env_requirements_json, preferred_backend, trust_grade, installed_at, tone, builtin) VALUES (?,?,?,?,?,?,?,'[]','[]',NULL,'A',?,?,0)",
    ).run(id, slug, name, name, tagline, tagline, systemPrompt, now, tone);
  }
  // 라우트 저장
  routes[id] = { agentId: id, path: dir, runtime, labels, kind, importedAt: now };
  fs.writeFileSync(path.join(userDataDir(), "agent-routes.json"), JSON.stringify(routes, null, 2), "utf8");

  // 팀이면 회사(firm)로도 등록 → 앱 FIRMS 목록 + `agentlas firm <slug>` 사용 가능. slug 기준 멱등.
  let firm = null;
  if (kind === "team") {
    try { firm = upsertLocalTeamFirmCli(db, dir, id, slug, name, tagline); } catch { /* best-effort */ }
  }
  return { id, slug, name, tagline, runtime, labels, kind, path: dir, updated: !!existingId, firmSlug: firm ? firm.slug : null };
}
// 팀 폴더 → 회사(firm) upsert (앱의 upsertLocalTeamFirm 과 동일). slug 기준 멱등.
function readTeamDepartmentsCli(dir) {
  for (const root of [path.join(dir, "hr-departments"), path.join(dir, ".claude", "hr-departments")]) {
    try {
      if (isDir(root)) {
        return fs.readdirSync(root, { withFileTypes: true })
          .filter((e) => e.isDirectory() && !e.name.startsWith("."))
          .map((e) => e.name).sort();
      }
    } catch { /* continue */ }
  }
  return [];
}
function deptLabelCli(name) {
  return name.replace(/[-_]+/g, " ").split(" ").filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");
}
function upsertLocalTeamFirmCli(db, dir, ceoAgentId, agentSlug, name, tagline) {
  if (!tableExists(db, "firms")) return null;
  const depts = readTeamDepartmentsCli(dir);
  const orgChart = [
    { agentSlug, agentId: ceoAgentId, role: "CEO", reportsTo: null },
    ...depts.map((d) => ({ agentSlug: `${agentSlug}-${d}`, agentId: "", role: deptLabelCli(d), reportsTo: agentSlug })),
  ];
  const firmSlug = `firm-${agentSlug}`;
  const chartJson = JSON.stringify(orgChart);
  const existing = db.prepare("SELECT id FROM firms WHERE slug=?").get(firmSlug);
  if (existing) {
    db.prepare("UPDATE firms SET name=?, name_en=?, tagline=?, tagline_en=?, persona=?, ceo_agent_id=?, org_chart_json=? WHERE id=?")
      .run(name, name, tagline, tagline, "", ceoAgentId, chartJson, existing.id);
    return { id: existing.id, slug: firmSlug };
  }
  const id = require("node:crypto").randomUUID();
  db.prepare(
    "INSERT INTO firms (id, slug, name, name_en, tagline, tagline_en, persona, ceo_agent_id, org_chart_json, installed_at) VALUES (?,?,?,?,?,?,?,?,?,?)",
  ).run(id, firmSlug, name, name, tagline, tagline, "", ceoAgentId, chartJson, new Date().toISOString());
  return { id, slug: firmSlug };
}
function cmdImport(db, absPath) {
  if (!absPath) fail("사용법: agentlas import <폴더경로>");
  const r = importLocalFolderCli(db, absPath);
  out(`${r.updated ? "갱신" : "임포트"} 완료: ${r.name}  (${r.kind})`);
  out(`  slug:    ${r.slug}`);
  out(`  runtime: ${r.runtime}  [${r.labels.join(", ")}]`);
  out(`  path:    ${r.path}`);
  if (r.firmSlug) out(`  firm:    ${r.firmSlug}  (FIRMS 등록됨 — 앱 사이드바 + 'agentlas firm ${r.firmSlug}')`);
  out("");
  out(`실행: agentlas ${r.slug} "..."   ·   agentlas run ${r.slug} "..."   (대상 프로젝트 폴더에서 실행)`);
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
function ensureMemoryContextColumn(db) {
  try {
    if (tableExists(db, "memory_entries") && !columnExists(db, "memory_entries", "context_json")) {
      db.exec("ALTER TABLE memory_entries ADD COLUMN context_json TEXT NOT NULL DEFAULT '{}'");
    }
  } catch { /* ignore */ }
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
function coerceText(v, max) {
  if (typeof v !== "string") return undefined;
  const s = v.trim();
  return s ? s.slice(0, max) : undefined;
}
function coerceNullableText(v, max) {
  if (v === null) return null;
  return coerceText(v, max);
}
function normalizeRequestContext(ev, ctx, projectPath) {
  const raw = ev && ev.request_context && typeof ev.request_context === "object" ? ev.request_context : {};
  const triggerTerms = Array.isArray(raw.trigger_terms)
    ? [...new Set(raw.trigger_terms.filter((x) => typeof x === "string").map((x) => x.trim()).filter(Boolean))]
        .slice(0, 12)
        .map((x) => x.slice(0, 40))
    : undefined;
  const cwd = coerceNullableText(raw.cwd_at_request, 500) ?? ctx.cwdAtRequest ?? ctx.cwd ?? ctx.projectPath ?? null;
  const targetProject = coerceNullableText(raw.target_project, 120) ?? ctx.projectId ?? null;
  const targetPath = coerceNullableText(raw.target_path, 500) ?? projectPath ?? null;
  const out = {};
  const userIntent = coerceText(raw.user_intent, 240);
  const outcome = coerceNullableText(raw.outcome, 240);
  if (userIntent) out.user_intent = userIntent;
  if (triggerTerms && triggerTerms.length) out.trigger_terms = triggerTerms;
  if (cwd !== undefined) out.cwd_at_request = cwd;
  if (targetProject !== undefined) out.target_project = targetProject;
  if (targetPath !== undefined) out.target_path = targetPath;
  out.cross_context = typeof raw.cross_context === "boolean" ? raw.cross_context : !!(cwd && targetPath && cwd !== targetPath);
  if (outcome !== undefined) out.outcome = outcome;
  if (SECRET_RE.some((re) => re.test(JSON.stringify(out)))) return {};
  return Object.keys(out).length ? out : {};
}
function contextLine(json) {
  try {
    const ctx = JSON.parse(json || "{}");
    const parts = [
      ctx.user_intent || ctx.userIntent,
      (ctx.target_project || ctx.targetProject) ? `target:${ctx.target_project || ctx.targetProject}` : null,
      Array.isArray(ctx.trigger_terms || ctx.triggerTerms) && (ctx.trigger_terms || ctx.triggerTerms).length
        ? `terms:${(ctx.trigger_terms || ctx.triggerTerms).join(",")}`
        : null,
    ].filter(Boolean);
    return parts.length ? ` (context: ${parts.join("; ").slice(0, 180)})` : "";
  } catch {
    return "";
  }
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
  ensureMemoryContextColumn(db);
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
        ? db.prepare("SELECT kind, content, context_json FROM memory_entries WHERE superseded_at IS NULL AND scope!='session' AND (project_path=? OR (project_path IS NULL AND scope IN ('user_identity','team_memory','agent_team'))) ORDER BY created_at DESC LIMIT 12").all(projectPath)
        : db.prepare("SELECT kind, content, context_json FROM memory_entries WHERE project_path IS NULL AND scope!='session' AND superseded_at IS NULL ORDER BY created_at DESC LIMIT 12").all();
      if (rows.length) sections.push((projectPath ? "### Recent curated memory\n" : "### Curated memory (global)\n") + rows.map((r) => `- [${r.kind}] ${r.content}${contextLine(r.context_json)}`).join("\n"));
    } catch { /* ignore */ }
  }
  if (!sections.length) return "";
  return "## Agentlas memory (read before answering; five-scope + request_context recall)\n\n" + sections.join("\n\n");
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
  ensureMemoryContextColumn(db);
  const arch = loadArch();
  const { randomUUID } = require("node:crypto");
  const now = new Date().toISOString();
  for (const ev of events) {
    const content = ev && typeof ev.content === "string" ? ev.content.trim() : "";
    if (!content) continue;
    if (ev.sensitivity === "secret" || SECRET_RE.some((re) => re.test(content))) continue;
    const kind = arch.kinds.includes(ev.memory_kind) ? ev.memory_kind : "fact";
    let scope = ev.suggested_scope === "agent_team"
      ? "team_memory"
      : arch.scopes.includes(ev.suggested_scope) ? ev.suggested_scope : "session";
    const kindAllowsUserIdentity = ["fact", "decision", "preference", "procedure"].includes(kind);
    if (scope === "user_identity" && (ev.confidence !== "high" || !kindAllowsUserIdentity)) scope = "session";
    if (scope === "discard" || scope === "session") { logCli(ctx.projectPath, { action: scope, kind, content, at: now }); continue; }
    if (scope === "project" && !ctx.projectPath) scope = "team_memory";
    const ppath = scope === "project" ? ctx.projectPath : null;
    const requestContext = normalizeRequestContext(ev, ctx, ppath);
    try {
      const dup = db.prepare("SELECT 1 FROM memory_entries WHERE scope=? AND kind=? AND lower(trim(content))=? AND superseded_at IS NULL AND (project_path IS ? OR project_path=?) LIMIT 1").get(scope, kind, content.toLowerCase(), ppath, ppath);
      if (dup) continue;
      db.prepare("INSERT INTO memory_entries (id,scope,kind,content,project_id,project_path,agent_id,chat_id,confidence,sensitivity,evidence_json,context_json,superseded_at,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,NULL,?)").run(randomUUID(), scope, kind, content, ctx.projectId || null, ppath, ctx.agentId || null, null, ev.confidence || "medium", ev.sensitivity || "internal", JSON.stringify(Array.isArray(ev.evidence_refs) ? ev.evidence_refs : []), JSON.stringify(requestContext), now);
      logCli(ctx.projectPath, { action: "written", scope, kind, content, request_context: requestContext, at: now });
    } catch { /* ignore */ }
  }
  return cleaned;
}
// 선택된 인터페이스 언어를 권위적으로 못박는 지시. 입력 언어 미러링을 막아
// "영어로 설정했는데 한글이 나오는" 문제를 차단한다 (desktop status-i18n.sysGuide와 동일 원칙).
function langDirective(lang) {
  return lang === "ko"
    ? "사용자의 인터페이스 언어는 한국어입니다. 사용자가 어떤 언어로 입력하든 항상 한국어로 답변하세요. 사용자가 이번 메시지에서 다른 언어로 답하라고 명시적으로 요청할 때만 그 언어를 쓰세요."
    : "The user's interface language is English. Always reply in English, regardless of the language the user writes in. Only use another language if the user explicitly asks you to in this message.";
}

function prefsLang() {
  try {
    return require("./agentlas-config.cjs").loadPrefs(userDataDir()).lang || "en";
  } catch {
    return "en";
  }
}

function augmentSystem(db, baseSystem, ctx, withEmitter) {
  const arch = loadArch();
  let sys = baseSystem || "";
  // 언어 지시를 맨 앞에 — 하위 CLI(claude/codex/gemini)의 입력-언어 미러링보다 우선하도록.
  const lang = (ctx && ctx.lang) || prefsLang();
  sys = langDirective(lang) + (sys ? "\n\n" + sys : "");
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
  if (!ctx.cwdAtRequest) ctx.cwdAtRequest = projectCwd();
  const rt = resolveRuntime(db, override);
  if (rt.mode === "cli") {
    // 네이티브 CLI는 자체 세션을 가지므로 emitter는 넣지 않고(노이즈 방지) 메모리 컨텍스트만 주입.
    const sys = augmentSystem(db, system, ctx, false);
    const cwd = ctx.projectPath || projectCwd();
    const permission = ctx.permission || "write";
    process.stderr.write(`▸ ${rt.kind} · ${permission} · ${cwd}\n`);
    return spawnRuntime(rt.kind, sys, prompt, { cwd, permission });
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
  if (!ctx.cwdAtRequest) ctx.cwdAtRequest = ctx.cwd || projectCwd();
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

// 에이전트가 실제로 실행될 작업 폴더 = 사용자가 명령을 친 현재 디렉터리(= 대상 프로젝트).
// 단, home/userData/agent-cwd 같은 "프로젝트 아님" 위치면 안전한 전용 폴더로 폴백한다.
function projectCwd() {
  try {
    const cwd = process.cwd();
    if (!cwd || cwd === os.homedir() || cwd === userDataDir() || cwd === runCwd()) return runCwd();
    return cwd;
  } catch {
    return runCwd();
  }
}

// 권한 → 네이티브 CLI 권한 모드 매핑 (앱의 claude-code.ts 와 동일 의미).
//   read=기본(헤드리스에서 위험 툴 자동 거부) · write=편집 허용 · full=셸 포함 전체 자동.
function buildArgs(kind, systemPrompt, prompt, permission) {
  if (kind === "claude-code") {
    const perm =
      permission === "full"
        ? ["--permission-mode", "bypassPermissions"]
        : permission === "write"
          ? ["--permission-mode", "acceptEdits"]
          : [];
    return ["-p", prompt, "--append-system-prompt", systemPrompt, ...perm];
  }
  if (kind === "codex") {
    // codex exec: write 이상이면 자동 승인+워크스페이스 쓰기, full이면 샌드박스/승인 우회.
    const perm =
      permission === "full"
        ? ["--dangerously-bypass-approvals-and-sandbox"]
        : permission === "write"
          ? ["--full-auto"]
          : [];
    return ["exec", "--skip-git-repo-check", ...perm, `[SYSTEM]\n${systemPrompt}\n\n${prompt}`];
  }
  if (kind === "gemini") {
    const perm = permission === "full" || permission === "write" ? ["--yolo"] : [];
    return ["--prompt", `[SYSTEM]\n${systemPrompt}\n\n${prompt}`, ...perm];
  }
  return [prompt];
}

// `claude` 치면 바로 대화형 세션 뜨듯이 — 에이전트 폴더(CLAUDE.md/AGENTS.md/GEMINI.md 보유)에서
// 네이티브 CLI를 인자 없이(대화형) 실행. 에이전트 페르소나는 그 폴더의 프로젝트 지시로 자동 로드. (A+B 결합)
// 보스턴테리어 터미널(대화형 TUI)로 진입. agentlas 가 항상 "호스트"다 —
// 활성 런타임이 claude/codex/gemini면 native-host로 headless 구동해 이 TUI 안에서 렌더하고,
// BYOK/Ollama면 자체 에이전트 루프(api-agent)를 돌린다. (apiRepl/네이티브 인계는 대체됨)
function launchInteractive(db, agent, runtimeOverride) {
  const subject = {
    kind: "agent",
    id: agent.id,
    slug: agent.slug,
    label: agent.name,
    system: agent.system_prompt || `You are ${agent.name}.`,
    capAgent: agent,
  };
  return launchTui(db, subject, runtimeOverride);
}

// REPL이 필요로 하는 DB 헬퍼들을 한 객체로 노출 (중복 구현 방지).
function buildHelpers(db) {
  return {
    which,
    RUNTIME_BIN,
    augmentSystem: (db_, base, ctx, emit) => augmentSystem(db_, base, ctx, emit),
    curateCliReply: (db_, text, ctx) => curateCliReply(db_, text, ctx),
    apiKey: (backend) => apiKey(backend),
    eventsHeading: () => loadArch().eventsHeading,
    defaultApiModel: (backend) => DEFAULT_API_MODEL[backend],
    resolveAgent,
    resolveFirm,
    listAgents,
    listFirms,
    firmSystemPrompt,
    cliMemoryContext: (db_, pp) => cliMemoryContext(db_, pp),
    importLocal: (db_, p) => importLocalFolderCli(db_, p),
    // /cwd 로 작업 폴더를 바꿀 때 그 폴더의 활성 프로젝트 경로(또는 null)를 재계산 — activeProjectPath의 명시-dir 버전.
    projectPathFor: (db_, dir) => {
      try {
        if (!dir || dir === os.homedir() || dir === userDataDir() || dir === runCwd()) return null;
        const v = recordCliFolderVisit(db_, dir);
        return v.activated ? dir : null;
      } catch {
        return null;
      }
    },
    doctor: (db_, ui) => {
      ui.line("");
      ui.info("userData: " + userDataDir());
      ui.info("db: " + (fs.existsSync(dbPath()) ? "OK" : "없음"));
      const ar = activeRuntime(db_);
      ui.info("활성 런타임: " + (ar ? ar.kind : "(없음)"));
      for (const [kind, bin] of Object.entries(RUNTIME_BIN)) {
        const p = which(bin);
        ui.info(`  ${kind.padEnd(12)} ${p ? "설치됨" : "미설치"}`);
      }
    },
  };
}

function launchTui(db, subject, runtimeOverride) {
  let startRepl, config;
  try {
    ({ startRepl } = require("./agentlas-repl.cjs"));
    config = require("./agentlas-config.cjs");
  } catch (e) {
    fail("Failed to load the terminal UI module: " + (e && e.message));
  }
  const dir = userDataDir();
  const prefs = config.loadPrefs(dir);
  // Runtime: explicit --runtime wins; else a saved default (cli kind, installed); else app's active runtime.
  let override = runtimeOverride;
  if (!override && prefs.runtime && prefs.runtime !== "auto" && RUNTIME_BIN[prefs.runtime] && which(RUNTIME_BIN[prefs.runtime])) {
    override = prefs.runtime;
  }
  const runtime = resolveRuntime(db, override);
  // Permission: explicit --permission wins; else the saved default; else "write".
  const permission = PERMISSION_EXPLICIT ? PERMISSION : prefs.permission || PERMISSION;
  startRepl({
    db,
    subject,
    runtime,
    permission,
    cwd: projectCwd(),
    projectPath: activeProjectPath(db),
    helpers: buildHelpers(db),
    prefs,
    savePrefs: (p) => config.savePrefs(dir, p),
  });
}

function spawnRuntime(kind, systemPrompt, prompt, opts) {
  opts = opts || {};
  const cwd = opts.cwd || runCwd();
  return new Promise((resolve) => {
    const bin = which(RUNTIME_BIN[kind]) || RUNTIME_BIN[kind];
    const child = spawn(bin, buildArgs(kind, systemPrompt, prompt, opts.permission), {
      cwd,
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
  let lang = "en";
  try { lang = require("./agentlas-config.cjs").loadPrefs(userDataDir()).lang || "en"; } catch { /* default en */ }
  const nm = (a) => (lang === "en" && a.name_en && a.name_en !== a.name ? a.name_en : a.name);
  out(`Active runtime: ${ar ? `${ar.kind}${ar.backend ? " · " + ar.backend : ""}${ar.model ? " · " + ar.model : ""}` : "(none)"}`);
  out(`${agents.length} agent(s) installed:`);
  const routes = routesMap();
  for (const a of agents) {
    const local = routes[a.id] ? "  [local]" : "";
    const arch = a.builtin ? "  [architecture]" : "";
    out(`  ${a.slug.padEnd(28)} ${nm(a)}${arch}${local}`);
  }
  const firms = listFirms(db);
  if (firms.length) {
    out(`\n${firms.length} company(ies):`);
    for (const f of firms) out(`  ${f.slug.padEnd(28)} ${nm(f)}  (CEO)`);
  }
  out("\nRun: agentlas <agent>  ·  agentlas firm <firm>  ·  agentlas run <agent> \"...\"");
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
  const code = await executeOnce(db, agent.system_prompt || "", userPrompt.trim(), runtimeOverride, { projectPath: activeProjectPath(db), agentId: agent.id, permission: PERMISSION });
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
    const code = await executeOnce(db, sys, prompt.trim(), runtimeOverride, { projectPath: activeProjectPath(db), agentId: firm.ceo_agent_id, permission: PERMISSION });
    process.exit(code);
  }
  // 대화형 — agentlas TUI. CEO 페르소나를 system으로, 작업은 현재 폴더에서.
  const subject = {
    kind: "firm",
    id: firm.ceo_agent_id,
    slug: firm.slug,
    label: firm.name + " CEO",
    system: sys,
    capAgent: { name: firm.name, name_en: firm.name_en || firm.name, tagline: firm.tagline, system_prompt: sys },
  };
  return launchTui(db, subject, runtimeOverride);
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
      "agentlas — the Boston Terrier terminal",
      "",
      "  agentlas              open the terminal (mascot splash, then pick an agent)",
      "  agentlas <agent>      jump straight into a chat with one agent",
      "  open <agent>          same as above (explicit)",
      "  firm <firm> [cmd]     delegate to a company's CEO (interactive if no cmd)",
      "  run <agent> [prompt]  one-shot — for scripts/pipes (reads stdin if no prompt)",
      "  import <path>         import a local folder (agent or team)",
      "  cd <agent>            print the agent folder — cd \"$(agentlas cd seo)\" && claude",
      "  list                  agents/companies + active runtime",
      "  env                   shared env key names",
      "  doctor                check runtimes and data",
      "  setup                 re-run first-launch setup (language · runtime · permission)",
      "",
      "Options: --runtime claude-code|codex|gemini  ·  --permission read|write|full (default write)",
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
    } else if (argv[i] === "--permission" || argv[i] === "-P") {
      const p = (argv[++i] || "").toLowerCase();
      if (!["read", "write", "full"].includes(p)) fail(`알 수 없는 권한: ${p} (read|write|full)`);
      PERMISSION = p;
      PERMISSION_EXPLICIT = true;
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
    return launchTui(db, null, runtimeOverride); // splash + interactive agent picker
  }

  switch (cmd) {
    case "list":
      return cmdList(db);
    case "import":
      return cmdImport(db, rest[1]);
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
    case "setup": {
      // re-run the first-launch onboarding wizard (language → runtime → permission)
      const cfg = require("./agentlas-config.cjs");
      const dir = userDataDir();
      const p = cfg.loadPrefs(dir);
      delete p.onboarded;
      cfg.savePrefs(dir, p);
      return launchTui(db, null, runtimeOverride);
    }
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
