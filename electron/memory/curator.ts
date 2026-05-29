// Deterministic Memory Curator — runs after EVERY turn (no extra LLM call, no latency).
// It applies the curator contract in code: safety redaction, scope resolution, dedup,
// and durable persistence. The Memory Curator *agent* (LLM) remains available for explicit
// deep curation; this is the always-on substrate that keeps memory flowing for every chat.
import {
  appendMemoryLog,
  appendSoulMemory,
} from "./project-files";
import { hasEquivalentMemory, insertMemoryEntry } from "./store";
import { parseMemoryEvents, type RawMemoryEvent } from "./events";
import type { MemoryKind, MemoryScope } from "../architecture/manifest";

// Secret/credential patterns — events matching these are dropped, never stored.
const SECRET_PATTERNS: RegExp[] = [
  /\b(?:sk|pk|rk)-[A-Za-z0-9]{16,}/,
  /AKIA[0-9A-Z]{16}/,
  /ghp_[A-Za-z0-9]{20,}/,
  /xox[baprs]-[A-Za-z0-9-]{10,}/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\b(?:password|passwd|secret|api[_-]?key|access[_-]?token|bearer)\b\s*[:=]\s*\S+/i,
];

function looksSecret(content: string): boolean {
  return SECRET_PATTERNS.some((re) => re.test(content));
}

export interface CurationContext {
  projectPath: string | null;
  projectId: string | null;
  agentId: string | null;
  chatId: string | null;
}

export interface CurationReport {
  written: number;
  deduped: number;
  redacted: number;
  sessionOnly: number;
  discarded: number;
}

const SOUL_KINDS: ReadonlySet<MemoryKind> = new Set<MemoryKind>([
  "decision",
  "preference",
  "risk",
  "procedure",
]);

function resolveScope(ev: RawMemoryEvent, ctx: CurationContext): MemoryScope {
  if (ev.suggested_scope === "project" && !ctx.projectPath) {
    // No folder bound to this chat → keep it durable but global.
    return "agent_team";
  }
  return ev.suggested_scope;
}

/** Curate a batch of raw events into durable memory. Pure side effects + a report. */
export function curateEvents(
  events: RawMemoryEvent[],
  ctx: CurationContext,
): CurationReport {
  const report: CurationReport = {
    written: 0,
    deduped: 0,
    redacted: 0,
    sessionOnly: 0,
    discarded: 0,
  };
  const soulLines: string[] = [];

  for (const ev of events) {
    if (ev.sensitivity === "secret" || looksSecret(ev.content)) {
      report.redacted += 1;
      if (ctx.projectPath) {
        appendMemoryLog(ctx.projectPath, {
          action: "redacted",
          reason: "secret",
          kind: ev.memory_kind,
          at: new Date().toISOString(),
        });
      }
      continue;
    }

    const scope = resolveScope(ev, ctx);
    if (scope === "discard") {
      report.discarded += 1;
      continue;
    }
    if (scope === "session") {
      // Temporary — log only, never durable.
      report.sessionOnly += 1;
      if (ctx.projectPath) {
        appendMemoryLog(ctx.projectPath, {
          action: "session",
          kind: ev.memory_kind,
          content: ev.content,
          at: new Date().toISOString(),
        });
      }
      continue;
    }

    const projectPath = scope === "project" ? ctx.projectPath : null;
    if (hasEquivalentMemory(scope, ev.memory_kind, ev.content, projectPath)) {
      report.deduped += 1;
      continue;
    }

    insertMemoryEntry({
      scope,
      kind: ev.memory_kind,
      content: ev.content,
      projectId: ctx.projectId,
      projectPath,
      agentId: ctx.agentId,
      chatId: ctx.chatId,
      confidence: ev.confidence,
      sensitivity: ev.sensitivity,
      evidence: ev.evidence_refs,
    });
    report.written += 1;

    if (ctx.projectPath) {
      appendMemoryLog(ctx.projectPath, {
        action: "written",
        scope,
        kind: ev.memory_kind,
        content: ev.content,
        at: new Date().toISOString(),
      });
      if (SOUL_KINDS.has(ev.memory_kind) && scope === "project") {
        soulLines.push(`(${ev.memory_kind}) ${ev.content}`);
      }
    }
  }

  if (ctx.projectPath && soulLines.length > 0) {
    appendSoulMemory(ctx.projectPath, soulLines);
  }

  return report;
}

/**
 * Convenience: parse an agent reply, curate its events, return the cleaned text + report.
 * Called from the run path after each assistant turn.
 */
export function curateReply(
  replyText: string,
  ctx: CurationContext,
): { cleanedText: string; report: CurationReport } {
  const { events, cleanedText } = parseMemoryEvents(replyText);
  const report =
    events.length > 0
      ? curateEvents(events, ctx)
      : { written: 0, deduped: 0, redacted: 0, sessionOnly: 0, discarded: 0 };
  return { cleanedText, report };
}
