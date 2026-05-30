// Builds the memory context injected into the system prompt before a run.
// Kept compact (token-bounded) on purpose — it runs on every turn.
import {
  listGlobalMemory,
  listGlobalMemoryForAgent,
  listMemoryByPath,
  listMemoryByPathForAgent,
  type MemoryEntry,
} from "./store";
import { readProjectSoul, readSitemap } from "./project-files";

const SOUL_MAX_CHARS = 1800;
const MAX_ENTRIES = 12;
const CONTEXT_MAX_CHARS = 180;

function summarizeSitemap(projectPath: string): string | null {
  const sm = readSitemap(projectPath);
  if (!sm || typeof sm !== "object") return null;
  const nodes = (sm as { nodes?: unknown[] }).nodes;
  if (!Array.isArray(nodes) || nodes.length === 0) return null;
  const byStatus: Record<string, number> = {};
  for (const n of nodes) {
    const status = (n as { status?: string }).status ?? "unknown";
    byStatus[status] = (byStatus[status] ?? 0) + 1;
  }
  const parts = Object.entries(byStatus).map(([s, n]) => `${s}:${n}`);
  return `AI Sitemap: ${nodes.length} nodes (${parts.join(", ")}).`;
}

function entryLines(entries: MemoryEntry[]): string {
  return entries
    .slice(0, MAX_ENTRIES)
    .map((e) => {
      const ctx = e.requestContext;
      const parts = [
        ctx?.userIntent,
        ctx?.targetProject ? `target:${ctx.targetProject}` : null,
        ctx?.triggerTerms && ctx.triggerTerms.length > 0 ? `terms:${ctx.triggerTerms.join(",")}` : null,
      ].filter(Boolean);
      const suffix =
        parts.length > 0
          ? ` (context: ${parts.join("; ").slice(0, CONTEXT_MAX_CHARS)})`
          : "";
      return `- [${e.kind}] ${e.content}${suffix}`;
    })
    .join("\n");
}

/**
 * Returns a memory context block (or empty string). When `projectPath` is set, prefers
 * the folder's curated memory + soul + sitemap; otherwise falls back to global memory.
 */
export function buildMemoryContext(
  projectPath: string | null,
  agentId?: string | null,
): string {
  const sections: string[] = [];
  // agentId가 주어지면 per-agent 스코프(공유 + 본인 agent_repo만)로 읽어, 각 본부/전문가
  // 세션이 자기 메모리만 보게 한다. 미지정이면 기존 동작(전체) 유지(단일 에이전트 경로).
  const perAgent = agentId !== undefined;

  if (projectPath) {
    const soul = readProjectSoul(projectPath);
    if (soul && soul.trim()) {
      const trimmed =
        soul.length > SOUL_MAX_CHARS ? soul.slice(0, SOUL_MAX_CHARS) + "\n…(truncated)" : soul;
      sections.push(`### Project memory (${projectPath})\n${trimmed.trim()}`);
    }
    const sitemap = summarizeSitemap(projectPath);
    if (sitemap) sections.push(sitemap);
    const entries = (
      perAgent
        ? listMemoryByPathForAgent(projectPath, agentId ?? null, MAX_ENTRIES)
        : listMemoryByPath(projectPath, MAX_ENTRIES)
    ).filter((e) => e.scope !== "session");
    if (entries.length > 0) {
      sections.push(`### Recent curated memory\n${entryLines(entries)}`);
    }
  } else {
    const entries = perAgent
      ? listGlobalMemoryForAgent(agentId ?? null, MAX_ENTRIES)
      : listGlobalMemory(MAX_ENTRIES);
    if (entries.length > 0) {
      sections.push(`### Curated memory (global)\n${entryLines(entries)}`);
    }
  }

  if (sections.length === 0) return "";
  return [
    "## Agentlas memory (read before answering; five-scope + request_context recall)",
    ...sections,
  ].join("\n\n");
}
