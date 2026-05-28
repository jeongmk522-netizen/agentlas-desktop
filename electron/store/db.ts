// 로컬 영구 저장 — userData/agentlas.sqlite.
// PRD 6.1: better-sqlite3, 동기 API라 IPC 핸들러에서 그대로 호출 가능.
// 채팅 로그는 기본 로컬 — 클라우드 백업은 사용자 명시 토글에만 (PRD 6.3).
//
// 스키마 버전 관리: user_version pragma로 마이그레이션. M0 → projects/chats 도입 시 chat_messages 재구성.
import Database from "better-sqlite3";
import path from "node:path";
import { app } from "electron";

let _db: Database.Database | null = null;

const SCHEMA_VERSION = 10;

export function initStore(): void {
  if (_db) return;
  const dbPath = path.join(app.getPath("userData"), "agentlas.sqlite");
  _db = new Database(dbPath);
  _db.pragma("journal_mode = WAL");
  _db.pragma("foreign_keys = ON");

  const userVersion = (_db.pragma("user_version", { simple: true }) as number) ?? 0;

  // ── v0 → v1: 초기 스키마 (active_runtime, installed_agents) ─
  if (userVersion < 1) {
    _db.exec(`
      CREATE TABLE IF NOT EXISTS active_runtime (
        id INTEGER PRIMARY KEY CHECK(id = 1),
        kind TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS installed_agents (
        id TEXT PRIMARY KEY,
        slug TEXT UNIQUE NOT NULL,
        name TEXT NOT NULL,
        tagline TEXT NOT NULL,
        system_prompt TEXT NOT NULL DEFAULT '',
        mcp_servers_json TEXT NOT NULL,
        preferred_backend TEXT,
        trust_grade TEXT NOT NULL,
        installed_at TEXT NOT NULL,
        tone TEXT NOT NULL
      );
    `);

    // 이전 v0 dev DB에 system_prompt 없으면 추가
    const cols = _db
      .prepare("PRAGMA table_info(installed_agents)")
      .all() as Array<{ name: string }>;
    if (!cols.some((c) => c.name === "system_prompt")) {
      _db.exec(
        "ALTER TABLE installed_agents ADD COLUMN system_prompt TEXT NOT NULL DEFAULT ''",
      );
    }
  }

  // ── v1 → v2: projects, chats 도입. chat_messages는 chat_id FK ─
  if (userVersion < 2) {
    // 이전 v1 dev DB의 chat_messages(agent_id 기반)는 버린다 — M0 dev 데이터.
    _db.exec(`
      DROP TABLE IF EXISTS chat_messages;

      CREATE TABLE IF NOT EXISTS projects (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        description TEXT,
        default_agent_id TEXT,
        context_note TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY(default_agent_id) REFERENCES installed_agents(id) ON DELETE SET NULL
      );

      CREATE TABLE IF NOT EXISTS chats (
        id TEXT PRIMARY KEY,
        project_id TEXT,
        agent_id TEXT NOT NULL,
        title TEXT NOT NULL DEFAULT '새 채팅',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE SET NULL,
        FOREIGN KEY(agent_id) REFERENCES installed_agents(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_chats_updated ON chats(updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_chats_project_updated
        ON chats(project_id, updated_at DESC);

      CREATE TABLE chat_messages (
        id TEXT PRIMARY KEY,
        chat_id TEXT NOT NULL,
        role TEXT NOT NULL CHECK(role IN ('user','assistant','system')),
        text TEXT NOT NULL,
        created_at TEXT NOT NULL,
        FOREIGN KEY(chat_id) REFERENCES chats(id) ON DELETE CASCADE
      );
      CREATE INDEX idx_chat_messages_chat_created
        ON chat_messages(chat_id, created_at);
    `);
  }

  // ── v2 → v3: firms 테이블 + chats.firm_id + automations.target_type/id ─
  if (userVersion < 3) {
    _db.exec(`
      CREATE TABLE IF NOT EXISTS firms (
        id TEXT PRIMARY KEY,
        slug TEXT UNIQUE NOT NULL,
        name TEXT NOT NULL,
        tagline TEXT NOT NULL,
        persona TEXT NOT NULL,
        ceo_agent_id TEXT NOT NULL,
        org_chart_json TEXT NOT NULL,
        installed_at TEXT NOT NULL,
        FOREIGN KEY(ceo_agent_id) REFERENCES installed_agents(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_firms_installed ON firms(installed_at DESC);
    `);

    // chats.firm_id 추가
    const chatCols = _db
      .prepare("PRAGMA table_info(chats)")
      .all() as Array<{ name: string }>;
    if (!chatCols.some((c) => c.name === "firm_id")) {
      _db.exec("ALTER TABLE chats ADD COLUMN firm_id TEXT REFERENCES firms(id) ON DELETE SET NULL");
      _db.exec("CREATE INDEX IF NOT EXISTS idx_chats_firm_updated ON chats(firm_id, updated_at DESC)");
    }

    // automations는 메모리 stub이라 스키마 변경 불필요 — 새 구조로 그냥 시작
  }

  // ── v3 → v4: chats.archived_at (보관함) ───────────────────
  if (userVersion < 4) {
    const chatCols = _db
      .prepare("PRAGMA table_info(chats)")
      .all() as Array<{ name: string }>;
    if (!chatCols.some((c) => c.name === "archived_at")) {
      _db.exec("ALTER TABLE chats ADD COLUMN archived_at TEXT");
      _db.exec(
        "CREATE INDEX IF NOT EXISTS idx_chats_archived_updated ON chats(archived_at, updated_at DESC)",
      );
    }
  }

  // ── v5 → v6: installed_agents.env_requirements_json ─────
  if (userVersion < 6) {
    const cols = _db
      .prepare("PRAGMA table_info(installed_agents)")
      .all() as Array<{ name: string }>;
    if (!cols.some((c) => c.name === "env_requirements_json")) {
      _db.exec(
        "ALTER TABLE installed_agents ADD COLUMN env_requirements_json TEXT NOT NULL DEFAULT '[]'",
      );
    }
  }

  // ── v4 → v5: installed_agents/firms 다국어 (name_en, tagline_en) ─
  if (userVersion < 5) {
    const agentCols = _db
      .prepare("PRAGMA table_info(installed_agents)")
      .all() as Array<{ name: string }>;
    if (!agentCols.some((c) => c.name === "name_en")) {
      _db.exec("ALTER TABLE installed_agents ADD COLUMN name_en TEXT NOT NULL DEFAULT ''");
    }
    if (!agentCols.some((c) => c.name === "tagline_en")) {
      _db.exec("ALTER TABLE installed_agents ADD COLUMN tagline_en TEXT NOT NULL DEFAULT ''");
    }
    const firmCols = _db
      .prepare("PRAGMA table_info(firms)")
      .all() as Array<{ name: string }>;
    if (!firmCols.some((c) => c.name === "name_en")) {
      _db.exec("ALTER TABLE firms ADD COLUMN name_en TEXT NOT NULL DEFAULT ''");
    }
    if (!firmCols.some((c) => c.name === "tagline_en")) {
      _db.exec("ALTER TABLE firms ADD COLUMN tagline_en TEXT NOT NULL DEFAULT ''");
    }
  }

  // ── v6 → v7: active_runtime distinguishes BYOK backends ──
  if (userVersion < 7) {
    const runtimeCols = _db
      .prepare("PRAGMA table_info(active_runtime)")
      .all() as Array<{ name: string }>;
    if (!runtimeCols.some((c) => c.name === "backend")) {
      _db.exec("ALTER TABLE active_runtime ADD COLUMN backend TEXT");
    }
    if (!runtimeCols.some((c) => c.name === "source")) {
      _db.exec("ALTER TABLE active_runtime ADD COLUMN source TEXT");
    }
  }

  // ── v7 → v8: chats.working_folder (워킹 폴더 패널) ───────
  if (userVersion < 8) {
    const chatCols = _db
      .prepare("PRAGMA table_info(chats)")
      .all() as Array<{ name: string }>;
    if (!chatCols.some((c) => c.name === "working_folder")) {
      _db.exec("ALTER TABLE chats ADD COLUMN working_folder TEXT");
    }
  }

  // ── v8 → v9: active_runtime.model (Ollama 등 로컬 LLM의 활성 모델) ─
  if (userVersion < 9) {
    const runtimeCols = _db
      .prepare("PRAGMA table_info(active_runtime)")
      .all() as Array<{ name: string }>;
    if (!runtimeCols.some((c) => c.name === "model")) {
      _db.exec("ALTER TABLE active_runtime ADD COLUMN model TEXT");
    }
  }

  // ── v9 → v10: 외부 MCP 툴 서버 + 에이전트별 연결 ────────
  if (userVersion < 10) {
    _db.exec(`
      CREATE TABLE IF NOT EXISTS mcp_servers (
        id TEXT PRIMARY KEY,
        catalog_id TEXT,
        name TEXT NOT NULL,
        name_en TEXT NOT NULL DEFAULT '',
        transport TEXT NOT NULL,
        command TEXT,
        args_json TEXT NOT NULL DEFAULT '[]',
        url TEXT,
        env_keys_json TEXT NOT NULL DEFAULT '[]',
        enabled INTEGER NOT NULL DEFAULT 1,
        installed_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS agent_mcp_servers (
        agent_id TEXT NOT NULL,
        server_id TEXT NOT NULL,
        PRIMARY KEY (agent_id, server_id),
        FOREIGN KEY(agent_id) REFERENCES installed_agents(id) ON DELETE CASCADE,
        FOREIGN KEY(server_id) REFERENCES mcp_servers(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_agent_mcp_agent ON agent_mcp_servers(agent_id);
    `);
  }

  _db.pragma(`user_version = ${SCHEMA_VERSION}`);
}

export function getDb(): Database.Database {
  if (!_db) {
    throw new Error("Store not initialized. Call initStore() in app.whenReady().");
  }
  return _db;
}
