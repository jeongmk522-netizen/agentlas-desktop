// Durable memory store (memory_entries table). The Memory Curator owns writes here.
import { randomUUID } from "node:crypto";
import { getDb } from "../store/db";
import type { MemoryKind, MemoryScope } from "../architecture/manifest";

export interface MemoryEntry {
  id: string;
  scope: MemoryScope;
  kind: MemoryKind;
  content: string;
  projectId: string | null;
  projectPath: string | null;
  agentId: string | null;
  chatId: string | null;
  confidence: "high" | "medium" | "low";
  sensitivity: "public" | "internal" | "private" | "confidential" | "secret";
  evidence: string[];
  supersededAt: string | null;
  createdAt: string;
}

interface Row {
  id: string;
  scope: string;
  kind: string;
  content: string;
  project_id: string | null;
  project_path: string | null;
  agent_id: string | null;
  chat_id: string | null;
  confidence: string;
  sensitivity: string;
  evidence_json: string;
  superseded_at: string | null;
  created_at: string;
}

function toEntry(r: Row): MemoryEntry {
  let evidence: string[] = [];
  try {
    evidence = JSON.parse(r.evidence_json) as string[];
  } catch {
    evidence = [];
  }
  return {
    id: r.id,
    scope: r.scope as MemoryScope,
    kind: r.kind as MemoryKind,
    content: r.content,
    projectId: r.project_id,
    projectPath: r.project_path,
    agentId: r.agent_id,
    chatId: r.chat_id,
    confidence: r.confidence as MemoryEntry["confidence"],
    sensitivity: r.sensitivity as MemoryEntry["sensitivity"],
    evidence,
    supersededAt: r.superseded_at,
    createdAt: r.created_at,
  };
}

export interface NewMemoryEntry {
  scope: MemoryScope;
  kind: MemoryKind;
  content: string;
  projectId?: string | null;
  projectPath?: string | null;
  agentId?: string | null;
  chatId?: string | null;
  confidence?: MemoryEntry["confidence"];
  sensitivity?: MemoryEntry["sensitivity"];
  evidence?: string[];
}

export function insertMemoryEntry(e: NewMemoryEntry): MemoryEntry {
  const id = randomUUID();
  const now = new Date().toISOString();
  getDb()
    .prepare(
      `INSERT INTO memory_entries
       (id, scope, kind, content, project_id, project_path, agent_id, chat_id,
        confidence, sensitivity, evidence_json, superseded_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)`,
    )
    .run(
      id,
      e.scope,
      e.kind,
      e.content,
      e.projectId ?? null,
      e.projectPath ?? null,
      e.agentId ?? null,
      e.chatId ?? null,
      e.confidence ?? "medium",
      e.sensitivity ?? "internal",
      JSON.stringify(e.evidence ?? []),
      now,
    );
  return {
    id,
    scope: e.scope,
    kind: e.kind,
    content: e.content,
    projectId: e.projectId ?? null,
    projectPath: e.projectPath ?? null,
    agentId: e.agentId ?? null,
    chatId: e.chatId ?? null,
    confidence: e.confidence ?? "medium",
    sensitivity: e.sensitivity ?? "internal",
    evidence: e.evidence ?? [],
    supersededAt: null,
    createdAt: now,
  };
}

/** Live (non-superseded) memory for a project folder, newest first. */
export function listMemoryByPath(projectPath: string, limit = 40): MemoryEntry[] {
  const rows = getDb()
    .prepare(
      `SELECT * FROM memory_entries
       WHERE project_path = ? AND superseded_at IS NULL
       ORDER BY created_at DESC LIMIT ?`,
    )
    .all(projectPath, limit) as Row[];
  return rows.map(toEntry);
}

/** Global (folder-less) durable memory — used when a chat has no working folder. */
export function listGlobalMemory(limit = 30): MemoryEntry[] {
  const rows = getDb()
    .prepare(
      `SELECT * FROM memory_entries
       WHERE project_path IS NULL AND scope != 'session' AND superseded_at IS NULL
       ORDER BY created_at DESC LIMIT ?`,
    )
    .all(limit) as Row[];
  return rows.map(toEntry);
}

/** Dedup check: same scope+kind+content already live for this path (or globally). */
export function hasEquivalentMemory(
  scope: MemoryScope,
  kind: MemoryKind,
  content: string,
  projectPath: string | null,
): boolean {
  const norm = content.trim().toLowerCase();
  const row = getDb()
    .prepare(
      `SELECT 1 FROM memory_entries
       WHERE scope = ? AND kind = ? AND lower(trim(content)) = ?
         AND superseded_at IS NULL
         AND (project_path IS ? OR project_path = ?)
       LIMIT 1`,
    )
    .get(scope, kind, norm, projectPath, projectPath);
  return Boolean(row);
}

export function countMemory(): number {
  const r = getDb().prepare("SELECT COUNT(*) AS n FROM memory_entries").get() as { n: number };
  return r.n;
}
