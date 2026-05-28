// 에이전트 파일 — 설치된 각 에이전트의 폴더(userData/agents/<slug>/)에 사람이 읽고
// 편집할 수 있는 파일을 materialize 하고, 그 폴더 안에서만 안전하게 read/write 한다.
//
// 설계:
//   - 라이브러리 > 에이전트에서 에이전트를 누르면 우측 패널이 이 폴더를 보여준다.
//   - `system-prompt.md`는 그 에이전트의 동작 프롬프트 원문 — 편집하면 DB에도 반영돼 즉시 적용.
//   - `AGENT.md` / `manifest.md`는 개요·메타데이터 (읽기용, 편집해도 무방).
//   - 시크릿 값은 절대 쓰지 않는다. env는 키 이름만 나열.
//   - 경로는 항상 에이전트 폴더 내부로 제한 (escape 방지).
import fs from "node:fs";
import path from "node:path";
import { app } from "electron";
import { getDb } from "../store/db";
import { getRoute } from "./routes";
import { listDirectory, readTextFilePreview, type DirListing, type TextFilePreview } from "../fs/workspace";

interface AgentRow {
  id: string;
  slug: string;
  name: string;
  name_en: string;
  tagline: string;
  tagline_en: string;
  system_prompt: string;
  mcp_servers_json: string;
  env_requirements_json: string;
  trust_grade: string;
  tone: string;
}

function agentsRoot(): string {
  return path.join(app.getPath("userData"), "agents");
}

/** 이 에이전트의 파일이 실제로 사는 폴더. 로컬 임포트면 원본 폴더, 아니면 userData/agents/<slug>. */
function resolveDir(agentId: string, slug: string): { dir: string; isLocal: boolean } {
  const route = getRoute(agentId);
  if (route) return { dir: route.path, isLocal: true };
  return { dir: agentFolderPath(slug), isLocal: false };
}

export function agentFolderPath(slug: string): string {
  return path.join(agentsRoot(), slug);
}

function getRow(agentId: string): AgentRow | null {
  const row = getDb()
    .prepare("SELECT * FROM installed_agents WHERE id = ?")
    .get(agentId) as AgentRow | undefined;
  return row ?? null;
}

function parseArr(json: string): string[] {
  try {
    const v = JSON.parse(json);
    return Array.isArray(v) ? (v as string[]) : [];
  } catch {
    return [];
  }
}

function parseEnv(json: string): Array<{ key: string; label?: string; required?: boolean; hint?: string }> {
  try {
    const v = JSON.parse(json);
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

/** 누락된 파일만 생성 — 사용자 편집을 덮어쓰지 않는다. */
export function materializeAgentFiles(agentId: string): string | null {
  const row = getRow(agentId);
  if (!row) return null;
  // 로컬 임포트 에이전트는 원본 폴더를 그대로 쓰므로 별도 파일을 만들지 않는다.
  const route = getRoute(agentId);
  if (route) return route.path;
  const dir = agentFolderPath(row.slug);
  fs.mkdirSync(dir, { recursive: true });

  writeIfMissing(path.join(dir, "system-prompt.md"), row.system_prompt || "");

  writeIfMissing(
    path.join(dir, "AGENT.md"),
    [
      `# ${row.name}${row.name_en && row.name_en !== row.name ? ` (${row.name_en})` : ""}`,
      "",
      row.tagline || "",
      "",
      `**Trust grade**: ${row.trust_grade}`,
      `**Slug**: ${row.slug}`,
      "",
      "## How it works",
      "",
      "This agent runs on your own LLM (CLI subscription, BYOK key, or local Ollama).",
      "Its behavior is defined by `system-prompt.md` in this folder — edit that file to",
      "change how the agent responds. Edits apply immediately to new messages.",
      "",
      "## System prompt",
      "",
      "See `system-prompt.md`.",
      "",
    ].join("\n"),
  );

  const envReqs = parseEnv(row.env_requirements_json);
  writeIfMissing(
    path.join(dir, "manifest.md"),
    [
      `# Manifest — ${row.name}`,
      "",
      `**id**: ${row.id}`,
      `**slug**: ${row.slug}`,
      `**trust**: ${row.trust_grade}`,
      `**tone**: ${row.tone}`,
      "",
      "## MCP servers",
      "",
      ...(parseArr(row.mcp_servers_json).length
        ? parseArr(row.mcp_servers_json).map((s) => `- ${s}`)
        : ["(none)"]),
      "",
      "## Environment variables",
      "",
      ...(envReqs.length
        ? envReqs.map(
            (e) => `- \`${e.key}\`${e.required ? " (required)" : " (optional)"}${e.label ? ` — ${e.label}` : ""}`,
          )
        : ["(none)"]),
      "",
    ].join("\n"),
  );

  return dir;
}

function writeIfMissing(file: string, content: string): void {
  if (fs.existsSync(file)) return;
  fs.writeFileSync(file, content.endsWith("\n") ? content : content + "\n", "utf8");
}

/** 지정한 base 폴더 내부 경로인지 확인. 아니면 throw. */
function ensureInside(baseDir: string, absPath: string): string {
  const root = path.resolve(baseDir);
  const resolved = path.resolve(absPath);
  const rel = path.relative(root, resolved);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new Error("Path escapes the agent folder");
  }
  return resolved;
}

export async function listAgentFiles(agentId: string): Promise<DirListing> {
  const row = getRow(agentId);
  if (!row) return { path: "", exists: false, entries: [] };
  const { dir, isLocal } = resolveDir(agentId, row.slug);
  if (!isLocal) materializeAgentFiles(agentId);
  return listDirectory(dir, false);
}

export async function readAgentFile(agentId: string, absPath: string): Promise<TextFilePreview> {
  const row = getRow(agentId);
  if (!row) return { path: absPath, content: "", truncated: false, size: 0, reason: "binary" };
  const { dir } = resolveDir(agentId, row.slug);
  // 에이전트 전환 시 이전 에이전트의 경로가 잠깐 넘어올 수 있다 — throw 대신 빈 미리보기로 안전 처리.
  let safe: string;
  try {
    safe = ensureInside(dir, absPath);
  } catch {
    return { path: absPath, content: "", truncated: false, size: 0, reason: "binary" };
  }
  return readTextFilePreview(safe);
}

export function writeAgentFile(agentId: string, absPath: string, content: string): { ok: boolean } {
  const row = getRow(agentId);
  if (!row) throw new Error("Agent not found");
  const { dir } = resolveDir(agentId, row.slug);
  const safe = ensureInside(dir, absPath);
  fs.mkdirSync(path.dirname(safe), { recursive: true });
  fs.writeFileSync(safe, content, "utf8");
  // system-prompt.md 편집은 DB에도 반영해 새 메시지에 즉시 적용.
  if (path.basename(safe) === "system-prompt.md") {
    getDb().prepare("UPDATE installed_agents SET system_prompt = ? WHERE id = ?").run(content, agentId);
  }
  return { ok: true };
}

/** 설치된 모든 에이전트의 파일을 보장(앱 부팅 시). 로컬 임포트(라우팅 보유)는 건너뛴다. */
export function materializeAllAgents(): void {
  const rows = getDb().prepare("SELECT id FROM installed_agents").all() as Array<{ id: string }>;
  for (const r of rows) {
    try {
      if (getRoute(r.id)) continue;
      materializeAgentFiles(r.id);
    } catch {
      // ignore — 개별 실패는 무시
    }
  }
}
