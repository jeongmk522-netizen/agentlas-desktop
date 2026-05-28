// 외부 MCP 서버 레지스트리 — SQLite 영구화. 전역 공유(모든 에이전트·팀이 함께 사용).
// 값(시크릿)은 keychain의 글로벌 env vault에만; 여기엔 어떤 env 키를 쓰는지만 저장.
import { randomUUID } from "node:crypto";
import { getDb } from "../store/db";
import { getCatalogEntry } from "./catalog";
import type { InstalledMcpServer, McpTransport } from "../../shared/types";

interface ServerRow {
  id: string;
  catalog_id: string | null;
  name: string;
  name_en: string;
  transport: McpTransport;
  command: string | null;
  args_json: string;
  url: string | null;
  env_keys_json: string;
  enabled: number;
  installed_at: string;
}

function toServer(row: ServerRow): InstalledMcpServer {
  return {
    id: row.id,
    catalogId: row.catalog_id,
    name: row.name,
    nameEn: row.name_en || row.name,
    transport: row.transport,
    command: row.command,
    args: safeJsonArray(row.args_json),
    url: row.url,
    envKeys: safeJsonArray(row.env_keys_json),
    enabled: row.enabled === 1,
    installedAt: row.installed_at,
  };
}

function safeJsonArray(json: string): string[] {
  try {
    const v = JSON.parse(json);
    return Array.isArray(v) ? (v as string[]) : [];
  } catch {
    return [];
  }
}

export function listInstalledServers(): InstalledMcpServer[] {
  const rows = getDb()
    .prepare("SELECT * FROM mcp_servers ORDER BY installed_at DESC")
    .all() as ServerRow[];
  return rows.map(toServer);
}

export function getServer(id: string): InstalledMcpServer | null {
  const row = getDb().prepare("SELECT * FROM mcp_servers WHERE id = ?").get(id) as
    | ServerRow
    | undefined;
  return row ? toServer(row) : null;
}

/** 카탈로그 항목으로 설치. 같은 카탈로그 id가 이미 있으면 그걸 반환(중복 방지). */
export function installFromCatalog(catalogId: string): InstalledMcpServer {
  const entry = getCatalogEntry(catalogId);
  if (!entry) throw new Error(`Unknown MCP catalog id: ${catalogId}`);

  const db = getDb();
  const existing = db
    .prepare("SELECT * FROM mcp_servers WHERE catalog_id = ?")
    .get(catalogId) as ServerRow | undefined;
  if (existing) return toServer(existing);

  const id = randomUUID();
  const now = new Date().toISOString();
  const envKeys = entry.envRequirements.map((r) => r.key);
  db.prepare(
    `INSERT INTO mcp_servers
       (id, catalog_id, name, name_en, transport, command, args_json, url, env_keys_json, enabled, installed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)`,
  ).run(
    id,
    entry.id,
    entry.name,
    entry.nameEn,
    entry.transport,
    entry.command ?? null,
    JSON.stringify(entry.args ?? []),
    entry.url ?? null,
    JSON.stringify(envKeys),
    now,
  );
  return getServer(id)!;
}

export function installCustomServer(def: {
  name: string;
  transport: McpTransport;
  command?: string;
  args?: string[];
  url?: string;
  envKeys?: string[];
}): InstalledMcpServer {
  const name = def.name.trim();
  if (!name) throw new Error("MCP server name required");
  if (def.transport === "stdio" && !def.command?.trim()) {
    throw new Error("stdio MCP server requires a command");
  }
  if ((def.transport === "sse" || def.transport === "http") && !def.url?.trim()) {
    throw new Error("sse/http MCP server requires a URL");
  }

  const id = randomUUID();
  const now = new Date().toISOString();
  getDb()
    .prepare(
      `INSERT INTO mcp_servers
         (id, catalog_id, name, name_en, transport, command, args_json, url, env_keys_json, enabled, installed_at)
       VALUES (?, NULL, ?, ?, ?, ?, ?, ?, ?, 1, ?)`,
    )
    .run(
      id,
      name,
      name,
      def.transport,
      def.command?.trim() ?? null,
      JSON.stringify(def.args ?? []),
      def.url?.trim() ?? null,
      JSON.stringify(def.envKeys ?? []),
      now,
    );
  return getServer(id)!;
}

export function removeServer(id: string): void {
  getDb().prepare("DELETE FROM mcp_servers WHERE id = ?").run(id);
  // agent_mcp_servers는 FK ON DELETE CASCADE로 자동 정리됨
}

export function setServerEnabled(id: string, enabled: boolean): InstalledMcpServer {
  getDb().prepare("UPDATE mcp_servers SET enabled = ? WHERE id = ?").run(enabled ? 1 : 0, id);
  const server = getServer(id);
  if (!server) throw new Error(`MCP server not found: ${id}`);
  return server;
}
