// Parses the "## Memory Events" block an agent appends to its reply (see
// MEMORY_EMITTER_BLOCK). Returns normalized events + the reply with the block stripped,
// so the chat stays clean while the curator still receives the structured data.
import {
  MEMORY_EVENTS_HEADING,
  MEMORY_KINDS,
  MEMORY_SCOPES,
  type MemoryKind,
  type MemoryScope,
} from "../architecture/manifest";

export interface RawMemoryEvent {
  memory_kind: MemoryKind;
  content: string;
  suggested_scope: MemoryScope;
  confidence: "high" | "medium" | "low";
  sensitivity: "public" | "internal" | "private" | "confidential" | "secret";
  evidence_refs: string[];
}

export interface ParsedMemory {
  events: RawMemoryEvent[];
  /** Reply text with the Memory Events block removed (trimmed). */
  cleanedText: string;
}

function coerceKind(v: unknown): MemoryKind {
  return MEMORY_KINDS.includes(v as MemoryKind) ? (v as MemoryKind) : "fact";
}

function coerceScope(v: unknown): MemoryScope {
  return MEMORY_SCOPES.includes(v as MemoryScope) ? (v as MemoryScope) : "session";
}

function coerceConfidence(v: unknown): RawMemoryEvent["confidence"] {
  return v === "high" || v === "low" ? v : "medium";
}

function coerceSensitivity(v: unknown): RawMemoryEvent["sensitivity"] {
  return v === "public" || v === "private" || v === "confidential" || v === "secret"
    ? v
    : "internal";
}

function normalize(raw: unknown): RawMemoryEvent | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const content = typeof o.content === "string" ? o.content.trim() : "";
  if (!content) return null;
  const evidence = Array.isArray(o.evidence_refs)
    ? o.evidence_refs.filter((x): x is string => typeof x === "string")
    : [];
  return {
    memory_kind: coerceKind(o.memory_kind),
    content,
    suggested_scope: coerceScope(o.suggested_scope),
    confidence: coerceConfidence(o.confidence),
    sensitivity: coerceSensitivity(o.sensitivity),
    evidence_refs: evidence,
  };
}

/**
 * Find the Memory Events heading, then the first JSON fence after it. Tolerant of
 * ```json or bare ``` fences and trailing prose.
 */
export function parseMemoryEvents(text: string): ParsedMemory {
  const headingIdx = text.lastIndexOf(MEMORY_EVENTS_HEADING);
  if (headingIdx < 0) return { events: [], cleanedText: text.trim() };

  const after = text.slice(headingIdx + MEMORY_EVENTS_HEADING.length);
  const fence = after.match(/```(?:json)?\s*([\s\S]*?)```/);
  let events: RawMemoryEvent[] = [];
  if (fence) {
    try {
      const data = JSON.parse(fence[1].trim());
      if (Array.isArray(data)) {
        events = data.map(normalize).filter((e): e is RawMemoryEvent => e !== null);
      }
    } catch {
      events = [];
    }
  }

  // Strip from the heading to the end of the fenced block (or end of string).
  let cut = text.length;
  if (fence && fence.index != null) {
    cut = headingIdx + MEMORY_EVENTS_HEADING.length + fence.index + fence[0].length;
  } else {
    cut = headingIdx; // no fence found — drop the dangling heading too
  }
  const cleaned = (text.slice(0, headingIdx) + text.slice(cut)).trim();
  return { events, cleanedText: cleaned };
}
