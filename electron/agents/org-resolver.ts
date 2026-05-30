// LLM 팀 구조 리졸버 — 임의의 에이전트-팀 폴더를 사용자의 활성 런타임(BYOK/CLI)으로
// "읽기 전용" 스캔해 CEO → 본부 → 전문가 3-tier ResolvedOrg를 생성한다.
// 하드코딩 파서가 아니라 LLM이 임의 구조를 이해한다(폴더 레이아웃이 천차만별이므로).
// 결과는 app config(saveResolvedOrg) + 원본 폴더의 .agentlas/orgspec.json sidecar에 저장하며,
// 사용자의 원본 파일은 절대 수정하지 않는다.
import fs from "node:fs";
import path from "node:path";
import type { ResolvedDivision, ResolvedNode, ResolvedOrg } from "../../shared/types";
import { getFirm } from "../store/firms";
import { getAgentById } from "../mcp/registry";
import { saveResolvedOrg } from "../store/org-spec";
import { pickActiveRunner } from "../mcp/client";
import { PROJECT_MEMORY_DIR } from "../architecture/manifest";

const SKIP_DIRS = new Set([
  ".git",
  "node_modules",
  "dist",
  ".next",
  "out",
  "build",
  ".cache",
  "__pycache__",
  PROJECT_MEMORY_DIR,
]);
const TEXT_EXT = new Set([".md", ".markdown", ".yaml", ".yml", ".json", ".txt", ".mdx"]);
const MAX_FILES = 140;
const MAX_EXCERPT = 700;
const MAX_MAP_CHARS = 24000;
const MAX_PROMPT_FILE = 8000;

type Raw = Record<string, unknown>;
const str = (v: unknown, fallback = ""): string => (typeof v === "string" ? v : fallback);

function walk(root: string): string[] {
  const out: string[] = [];
  const stack: Array<{ dir: string; depth: number }> = [{ dir: root, depth: 0 }];
  while (stack.length > 0 && out.length < MAX_FILES) {
    const top = stack.pop();
    if (!top) break;
    let entries: fs.Dirent[] = [];
    try {
      entries = fs.readdirSync(top.dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      // 숨김은 건너뛰되 .claude(팀 정의 흔히 거기 있음)는 허용
      if (e.name.startsWith(".") && e.name !== ".claude") continue;
      const full = path.join(top.dir, e.name);
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name)) continue;
        if (top.depth < 5) stack.push({ dir: full, depth: top.depth + 1 });
      } else if (e.isFile()) {
        out.push(full);
        if (out.length >= MAX_FILES) break;
      }
    }
  }
  return out;
}

function buildFolderMap(root: string): string {
  const files = walk(root);
  const lines: string[] = ["FILES:"];
  for (const f of files) lines.push(`  ${path.relative(root, f)}`);
  lines.push("\nEXCERPTS (agent-definition-like files):");
  let total = 0;
  for (const f of files) {
    if (total > MAX_MAP_CHARS) break;
    const ext = path.extname(f).toLowerCase();
    const base = path.basename(f).toLowerCase();
    const likely =
      TEXT_EXT.has(ext) &&
      (base.includes("agent") ||
        base.includes("soul") ||
        base.includes("orgspec") ||
        base.includes("role") ||
        base.includes("ceo") ||
        base.includes("director") ||
        base.includes("system") ||
        base.includes("readme") ||
        ext === ".yaml" ||
        ext === ".yml");
    if (!likely) continue;
    let content = "";
    try {
      content = fs.readFileSync(f, "utf8").slice(0, MAX_EXCERPT);
    } catch {
      continue;
    }
    const block = `\n--- ${path.relative(root, f)} ---\n${content}`;
    total += block.length;
    lines.push(block);
  }
  return lines.join("\n").slice(0, MAX_MAP_CHARS);
}

function slugify(s: string): string {
  return (
    s
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "node"
  );
}

function extractJson(text: string): Raw | null {
  const candidates: string[] = [];
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) candidates.push(fence[1]);
  const brace = text.match(/\{[\s\S]*\}/);
  if (brace) candidates.push(brace[0]);
  for (const c of candidates) {
    try {
      const parsed = JSON.parse(c.trim());
      if (parsed && typeof parsed === "object") return parsed as Raw;
    } catch {
      // try next
    }
  }
  return null;
}

function readPromptFile(root: string, ref: unknown): string | undefined {
  const rel = str(ref).trim();
  if (!rel) return undefined;
  const safe = path.normalize(rel).replace(/^(\.\.(\/|\\|$))+/, "");
  const full = path.join(root, safe);
  if (!full.startsWith(root)) return undefined; // traversal 방지
  try {
    return fs.readFileSync(full, "utf8").slice(0, MAX_PROMPT_FILE);
  } catch {
    return undefined;
  }
}

const RESOLVER_SYSTEM = `You are Agentlas's team-structure resolver. You are given a map (file list + excerpts) of an arbitrary AI-agent-team folder. Infer the org as exactly 3 tiers: a single CEO, its divisions (department heads), and each division's specialists.

Rules:
- Output ONLY one JSON object, no prose, no markdown fence.
- Shape: {"divisions":[{"role":"...","name":"...","promptFileRef":"relative/path or null","specialists":[{"role":"...","name":"...","promptFileRef":"relative/path or null"}]}]}
- The CEO is already known — do NOT include it; only resolve divisions + specialists beneath it.
- role = the function (e.g. "Marketing Division", "Designer"); name = a display name (may equal role).
- promptFileRef = the relative file path (from the listed FILES) whose content defines that agent's behavior, or null.
- If the team is flat (no clear sub-structure), return the leaf roles as divisions with empty specialists.
- Be faithful to the folder; do not invent agents that aren't represented.`;

/** firm의 팀 폴더를 LLM으로 분석해 3-tier ResolvedOrg를 만들어 저장한다. */
export async function resolveTeamOrg(
  firmId: string,
): Promise<{ ok: boolean; org?: ResolvedOrg; error?: string }> {
  const firm = getFirm(firmId);
  if (!firm) return { ok: false, error: "firm not found" };
  const ceoAgent = getAgentById(firm.ceoAgentId);
  const sourcePath = ceoAgent?.localPath;
  if (!ceoAgent || !sourcePath || !fs.existsSync(sourcePath)) {
    return { ok: false, error: "no local source folder for this team" };
  }
  const picked = await pickActiveRunner();
  if (!picked) return { ok: false, error: "no active LLM runtime" };

  const map = buildFolderMap(sourcePath);
  const userPrompt = `CEO (already known): ${ceoAgent.name}\n\nTeam folder map:\n${map}`;

  let text = "";
  try {
    const result = await picked.runner(
      {
        systemPrompt: RESOLVER_SYSTEM,
        history: [],
        userPrompt,
        backendLabel: picked.label,
        model: picked.active.model ?? undefined,
        locale: "en",
      },
      { onPartial: () => {}, onStatus: () => {} },
    );
    text = result.text;
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }

  const data = extractJson(text);
  const rawDivisions = data && Array.isArray(data.divisions) ? (data.divisions as unknown[]) : null;
  if (!rawDivisions) return { ok: false, error: "resolver did not return valid org JSON" };

  const usedIds = new Set<string>();
  const mkId = (role: string, name: string): string => {
    const base = slugify(name || role);
    let id = base;
    let i = 2;
    while (usedIds.has(id)) id = `${base}-${i++}`;
    usedIds.add(id);
    return id;
  };
  const toNode = (raw: unknown): ResolvedNode => {
    const o = (raw && typeof raw === "object" ? raw : {}) as Raw;
    const role = str(o.role, str(o.name, "Agent"));
    const name = str(o.name, role);
    return {
      id: mkId(role, name),
      name,
      role,
      prompt: readPromptFile(sourcePath, o.promptFileRef),
      promptFileRef: str(o.promptFileRef) || undefined,
    };
  };

  const ceo: ResolvedNode = {
    id: firm.ceoAgentId,
    name: ceoAgent.name,
    role: "CEO",
    agentId: firm.ceoAgentId,
    prompt: ceoAgent.systemPrompt,
  };
  const divisions: ResolvedDivision[] = rawDivisions.slice(0, 24).map((d) => {
    const o = (d && typeof d === "object" ? d : {}) as Raw;
    const specialists = Array.isArray(o.specialists)
      ? (o.specialists as unknown[]).slice(0, 24).map(toNode)
      : [];
    return { ...toNode(d), specialists };
  });

  const org: ResolvedOrg = {
    source: "resolver",
    ceo,
    divisions,
    sourcePath,
    resolvedAt: new Date().toISOString(),
  };
  saveResolvedOrg(firmId, org);
  writeSidecar(sourcePath, org);
  return { ok: true, org };
}

/** .agentlas/orgspec.json sidecar (원본 폴더 안의 전용 디렉터리 — 기존 파일은 안 건드림). */
function writeSidecar(root: string, org: ResolvedOrg): void {
  try {
    const dir = path.join(root, PROJECT_MEMORY_DIR);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "orgspec.json"), JSON.stringify(org, null, 2), "utf8");
  } catch {
    // best-effort — app config에는 이미 저장됨
  }
}
