// 로컬 에이전트/팀 폴더 임포트.
// 드래그&드롭 또는 폴더 선택으로 받은 기존 에이전트 폴더를 분석한다:
//   - 어떤 CLI 런타임 전용인지 라벨 (CLAUDE.md→claude-code, AGENTS.md→codex, GEMINI.md→gemini, .cursor→cursor)
//   - 단일 에이전트인지 팀인지 (TEAM.md / ceo / hr-departments)
//   - 이름·태그라인·시스템 프롬프트
// 원본은 그대로 두고, 위치를 routes.json에 라우팅 저장한다 (앱이 그 폴더를 그대로 사용).
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { getDb } from "../store/db";
import { setRoute, type RuntimeLabel } from "./routes";
import type { InstalledAgent } from "../../shared/types";

const TONES: InstalledAgent["tone"][] = ["blue", "green", "purple", "amber", "peach"];

function exists(p: string): boolean {
  try {
    fs.accessSync(p);
    return true;
  } catch {
    return false;
  }
}

function isDir(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/** 폴더 안의 파일 단서로 런타임 라벨들을 감지. 우선순위 순으로 정렬해 반환. */
export function detectRuntimeLabels(dir: string): RuntimeLabel[] {
  const labels: RuntimeLabel[] = [];
  if (exists(path.join(dir, "CLAUDE.md")) || isDir(path.join(dir, ".claude"))) labels.push("claude-code");
  if (exists(path.join(dir, "AGENTS.md"))) labels.push("codex");
  if (exists(path.join(dir, "GEMINI.md"))) labels.push("gemini");
  if (isDir(path.join(dir, ".cursor")) || exists(path.join(dir, ".cursorrules"))) labels.push("cursor");
  if (labels.length === 0) labels.push("generic");
  return labels;
}

function detectKind(dir: string): "agent" | "team" {
  if (
    exists(path.join(dir, "TEAM.md")) ||
    isDir(path.join(dir, "ceo")) ||
    isDir(path.join(dir, "hr-departments")) ||
    isDir(path.join(dir, "projects"))
  ) {
    return "team";
  }
  return "agent";
}

function readFirst(dir: string, candidates: string[], maxChars = 8000): string {
  for (const name of candidates) {
    const p = path.join(dir, name);
    if (exists(p) && !isDir(p)) {
      try {
        const raw = fs.readFileSync(p, "utf8");
        return raw.slice(0, maxChars);
      } catch {
        // continue
      }
    }
  }
  return "";
}

/** manifest.md / 첫 마크다운 제목 / 폴더명에서 표시 이름 추출. */
function readName(dir: string): string {
  const manifest = readFirst(dir, ["manifest.md", "AGENT.md", "CLAUDE.md", "README.md"], 2000);
  const m = manifest.match(/^#\s+(.+)$/m);
  if (m) {
    return m[1].replace(/\(.*?\)/g, "").trim().slice(0, 60) || path.basename(dir);
  }
  return path.basename(dir);
}

function readTagline(dir: string): string {
  const text = readFirst(dir, ["README.md", "soul.md", "AGENT.md"], 2000);
  // 첫 번째 헤더가 아닌 비어있지 않은 줄
  for (const line of text.split("\n")) {
    const t = line.trim();
    if (t && !t.startsWith("#") && !t.startsWith(">")) return t.slice(0, 140);
  }
  return "";
}

function uniqueSlug(base: string): string {
  const db = getDb();
  let slug = base;
  let n = 1;
  while (db.prepare("SELECT 1 FROM installed_agents WHERE slug = ?").get(slug)) {
    slug = `${base}-${++n}`;
  }
  return slug;
}

export interface LocalImportResult {
  agent: InstalledAgent;
  runtime: RuntimeLabel;
  labels: RuntimeLabel[];
  kind: "agent" | "team";
  path: string;
}

/** 로컬 폴더를 분석·등록하고 라우팅 저장. 원본 파일은 건드리지 않는다. */
export function importLocalFolder(absPath: string): LocalImportResult {
  const dir = path.resolve(absPath);
  if (!isDir(dir)) throw new Error(`Not a folder: ${absPath}`);

  const labels = detectRuntimeLabels(dir);
  const runtime = labels[0];
  const kind = detectKind(dir);
  const name = readName(dir);
  const tagline = readTagline(dir) || (kind === "team" ? "Imported local team" : "Imported local agent");
  const systemPrompt =
    readFirst(dir, ["system-prompt.md", "soul.md", "AGENT.md", "CLAUDE.md", "AGENTS.md", "GEMINI.md"]) ||
    `You are ${name}, a locally imported agent.`;

  const baseSlug =
    "local-" +
    path
      .basename(dir)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "local-agent";
  const slug = uniqueSlug(baseSlug);

  const id = randomUUID();
  const now = new Date().toISOString();
  const tone = TONES[Math.abs(hash(slug)) % TONES.length];

  getDb()
    .prepare(
      `INSERT INTO installed_agents
       (id, slug, name, name_en, tagline, tagline_en, system_prompt, mcp_servers_json,
        env_requirements_json, preferred_backend, trust_grade, installed_at, tone)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(id, slug, name, name, tagline, tagline, systemPrompt, "[]", "[]", null, "A", now, tone);

  setRoute({ agentId: id, path: dir, runtime, labels, kind, importedAt: now });

  const agent: InstalledAgent = {
    id,
    slug,
    name,
    nameEn: name,
    tagline,
    taglineEn: tagline,
    systemPrompt,
    mcpServers: [],
    envRequirements: [],
    preferredBackend: null,
    trustGrade: "A",
    installedAt: now,
    tone,
    runtimeLabel: runtime,
    localPath: dir,
    kind,
  };
  return { agent, runtime, labels, kind, path: dir };
}

function hash(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h << 5) - h + s.charCodeAt(i);
  return h;
}
