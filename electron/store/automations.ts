// 자동화 — M0 in-memory stub. M1에서 SQLite + node-cron or macOS launchd.
// targetType: agent (개별 에이전트 호출) | firm (CEO에게 명령 → 회사 전체 동원)
import { randomUUID } from "node:crypto";
import type { Automation } from "../../shared/types";

const STORE: Map<string, Automation> = new Map();

export function listAutomations(): Automation[] {
  return [...STORE.values()].sort((a, b) =>
    a.createdAt < b.createdAt ? 1 : -1,
  );
}

export function createAutomation(
  input: Omit<Automation, "id" | "createdAt" | "lastRunAt" | "enabled">,
): Automation {
  const id = randomUUID();
  const automation: Automation = {
    ...input,
    id,
    enabled: true,
    createdAt: new Date().toISOString(),
    lastRunAt: null,
  };
  STORE.set(id, automation);
  return automation;
}

export function toggleAutomation(id: string, enabled: boolean): Automation {
  const existing = STORE.get(id);
  if (!existing) throw new Error(`Automation not found: ${id}`);
  const next = { ...existing, enabled };
  STORE.set(id, next);
  return next;
}

export function removeAutomation(id: string): void {
  STORE.delete(id);
}
