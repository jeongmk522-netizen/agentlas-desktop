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
import { setRoute, listRoutes, type RuntimeLabel } from "./routes";
import { upsertLocalTeamFirm } from "../store/firms";
import type { FirmOrgNode, InstalledAgent } from "../../shared/types";

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
  // 루트 마커
  if (
    exists(path.join(dir, "TEAM.md")) ||
    isDir(path.join(dir, "ceo")) ||
    isDir(path.join(dir, "hr-departments")) ||
    isDir(path.join(dir, "projects"))
  ) {
    return "team";
  }
  // .claude/ 중첩 팀 구조 (appbridge 처럼 팀 정의가 .claude/ 아래에 있는 경우)
  if (
    isDir(path.join(dir, ".claude", "ceo")) ||
    isDir(path.join(dir, ".claude", "hr-departments")) ||
    isDir(path.join(dir, ".claude", "agents")) ||
    exists(path.join(dir, ".claude", "orgspec.yaml"))
  ) {
    return "team";
  }
  return "agent";
}

/**
 * 팀이면 CEO 두뇌(.claude/ceo/AGENT.md 등)를 시스템 프롬프트로 삼고, 임의의 작업 폴더(cwd)에서
 * 실행돼도 동작하도록 팀 루트 절대경로 오리엔테이션 헤더를 붙인다.
 * (CEO 브레인은 ./playbook.md, ../orgspec.yaml 같은 상대경로를 쓰므로 그냥 쓰면 다른 cwd에서 깨진다.)
 */
function buildTeamSystemPrompt(dir: string, name: string): string {
  const ceoBrain = readFirst(dir, [path.join(".claude", "ceo", "AGENT.md")], 12000);
  const brain =
    ceoBrain ||
    readFirst(dir, ["AGENTS.md", "CLAUDE.md", path.join(".claude", "CLAUDE.md")], 12000) ||
    `Act as the orchestrating CEO of ${name}.`;
  const claudeRoot = path.join(dir, ".claude");
  const header =
    `You are the CEO / orchestrator of the "${name}" agent team, now launched through Agentlas.\n\n` +
    `TEAM ROOT: ${dir}\n` +
    `Team definition (org spec, playbooks, department & role agents) lives under: ${claudeRoot}\n` +
    `When the instructions below reference team files with relative paths (e.g. ./playbook.md, ../orgspec.yaml, .claude/...), resolve them as ABSOLUTE paths under that team root and read them as needed.\n\n` +
    `TARGET PROJECT: your current working directory is the user's target project. Do ALL building, file creation, and delivery in the current working directory — never inside the team root. Route work to the right department/specialist, sequence multi-step work, keep a brief CEO-style status in Korean, and apply read-only-first safety gates for high-risk actions (billing/auth/security/deploy).\n\n` +
    `--- TEAM BRAIN ---\n`;
  return (header + brain).slice(0, 16000);
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

/** 팀 폴더의 부서 목록 — hr-departments/ 또는 .claude/hr-departments/ 의 하위 디렉토리명. */
function readTeamDepartments(dir: string): string[] {
  for (const root of [path.join(dir, "hr-departments"), path.join(dir, ".claude", "hr-departments")]) {
    try {
      if (isDir(root)) {
        return fs
          .readdirSync(root, { withFileTypes: true })
          .filter((e) => e.isDirectory() && !e.name.startsWith("."))
          .map((e) => e.name)
          .sort();
      }
    } catch {
      // continue
    }
  }
  return [];
}

/** "writer-desk" → "Writer Desk", "persona-qa" → "Persona Qa" 같은 표시용 라벨. */
function deptLabel(name: string): string {
  return name
    .replace(/[-_]+/g, " ")
    .split(" ")
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

/** 팀이면 회사(firm)로도 등록 — CEO = 팀 에이전트, 부서는 조직도 정보 노드. slug 기준 멱등. */
function registerTeamAsFirm(dir: string, agentId: string, slug: string, name: string, tagline: string): void {
  const depts = readTeamDepartments(dir);
  const orgChart: Array<FirmOrgNode & { agentId: string }> = [
    { agentSlug: slug, agentId, role: "CEO", reportsTo: null },
    ...depts.map((d) => ({ agentSlug: `${slug}-${d}`, agentId: "", role: deptLabel(d), reportsTo: slug })),
  ];
  try {
    upsertLocalTeamFirm({ slug: `firm-${slug}`, name, tagline, ceoAgentId: agentId, orgChart });
  } catch (err) {
    console.error("[import] registerTeamAsFirm failed:", err);
  }
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
    kind === "team"
      ? buildTeamSystemPrompt(dir, name)
      : readFirst(dir, ["system-prompt.md", "soul.md", "AGENT.md", "CLAUDE.md", "AGENTS.md", "GEMINI.md"]) ||
        `You are ${name}, a locally imported agent.`;

  const now = new Date().toISOString();

  // 멱등성: 같은 폴더가 이미 임포트돼 있으면 새로 만들지 않고 그 에이전트를 갱신한다.
  // (앱에서 같은 폴더를 다시 드래그해도 local-...-2 중복이 생기지 않도록.)
  const existing = listRoutes().find((r) => {
    try {
      return path.resolve(r.path) === dir;
    } catch {
      return false;
    }
  });
  let row = existing
    ? (getDb().prepare("SELECT id, slug, tone FROM installed_agents WHERE id = ?").get(existing.agentId) as
        | { id: string; slug: string; tone: InstalledAgent["tone"] }
        | undefined)
    : undefined;

  let id: string;
  let slug: string;
  let tone: InstalledAgent["tone"];
  if (existing && row) {
    id = row.id;
    slug = row.slug;
    tone = row.tone;
    getDb()
      .prepare(
        "UPDATE installed_agents SET name = ?, name_en = ?, tagline = ?, tagline_en = ?, system_prompt = ? WHERE id = ?",
      )
      .run(name, name, tagline, tagline, systemPrompt, id);
  } else {
    const baseSlug =
      "local-" +
      path
        .basename(dir)
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 40) || "local-agent";
    slug = uniqueSlug(baseSlug);
    id = randomUUID();
    tone = TONES[Math.abs(hash(slug)) % TONES.length];
    getDb()
      .prepare(
        `INSERT INTO installed_agents
         (id, slug, name, name_en, tagline, tagline_en, system_prompt, mcp_servers_json,
          env_requirements_json, preferred_backend, trust_grade, installed_at, tone)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(id, slug, name, name, tagline, tagline, systemPrompt, "[]", "[]", null, "A", now, tone);
  }

  setRoute({ agentId: id, path: dir, runtime, labels, kind, importedAt: now });

  // 팀이면 FIRMS에도 등록 → 사이드바 FIRMS 목록에 뜨고 "Command CEO" 가능.
  if (kind === "team") registerTeamAsFirm(dir, id, slug, name, tagline);

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
