// Auto-activation: when a user works REPEATEDLY in the same folder, the Agentlas
// architecture turns itself on for that folder — it creates .agentlas/ (PM Soul memory +
// AI Sitemap) and starts injecting/curating project memory. One-off folders stay untouched.
import { getDb } from "../store/db";
import { ensureProjectMemory } from "../memory/project-files";

// 2nd visit = "repeated work". Low on purpose so continuity kicks in early.
const ACTIVATE_AT_VISITS = 2;

export interface VisitResult {
  visits: number;
  activated: boolean;
  /** True only on the turn activation first happened (for UI/log surfacing). */
  justActivated: boolean;
}

/**
 * Record a visit to a working folder. Activates the architecture once the visit count
 * crosses the threshold. Idempotent and cheap.
 */
export function recordFolderVisit(projectPath: string, projectName?: string): VisitResult {
  const db = getDb();
  const now = new Date().toISOString();
  const row = db
    .prepare("SELECT visits, activated_at FROM folder_activity WHERE path = ?")
    .get(projectPath) as { visits: number; activated_at: string | null } | undefined;

  let visits: number;
  let activatedAt: string | null;
  if (row) {
    visits = row.visits + 1;
    activatedAt = row.activated_at;
    db.prepare("UPDATE folder_activity SET visits = ?, last_seen = ? WHERE path = ?").run(
      visits,
      now,
      projectPath,
    );
  } else {
    visits = 1;
    activatedAt = null;
    db.prepare(
      "INSERT INTO folder_activity (path, visits, activated_at, first_seen, last_seen) VALUES (?, ?, NULL, ?, ?)",
    ).run(projectPath, visits, now, now);
  }

  let justActivated = false;
  if (!activatedAt && visits >= ACTIVATE_AT_VISITS) {
    db.prepare("UPDATE folder_activity SET activated_at = ? WHERE path = ?").run(now, projectPath);
    ensureProjectMemory(projectPath, projectName);
    activatedAt = now;
    justActivated = true;
  }

  return { visits, activated: Boolean(activatedAt), justActivated };
}

export function isFolderActivated(projectPath: string): boolean {
  const row = getDb()
    .prepare("SELECT activated_at FROM folder_activity WHERE path = ?")
    .get(projectPath) as { activated_at: string | null } | undefined;
  return Boolean(row?.activated_at);
}

/** Force-activate now (used by explicit UI/CLI actions). */
export function activateFolder(projectPath: string, projectName?: string): void {
  const db = getDb();
  const now = new Date().toISOString();
  const row = db
    .prepare("SELECT visits FROM folder_activity WHERE path = ?")
    .get(projectPath) as { visits: number } | undefined;
  if (row) {
    db.prepare("UPDATE folder_activity SET activated_at = COALESCE(activated_at, ?), last_seen = ? WHERE path = ?").run(
      now,
      now,
      projectPath,
    );
  } else {
    db.prepare(
      "INSERT INTO folder_activity (path, visits, activated_at, first_seen, last_seen) VALUES (?, 1, ?, ?, ?)",
    ).run(projectPath, now, now, now);
  }
  ensureProjectMemory(projectPath, projectName);
}
