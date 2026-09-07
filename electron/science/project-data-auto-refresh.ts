import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import {
  discoverScienceProjectData,
  readResolvedScienceProjectDataCandidate,
  resolveScienceProjectDataCandidate,
  scienceProjectDataRootIdentity,
  SCIENCE_PROJECT_DATA_LIMITS,
} from "./project-data-discovery";
import type { ScienceStore } from "./store";
import type {
  ScienceProjectDataRefreshMode,
  ScienceProjectDataRefreshObservation,
  ScienceProjectDataRefreshPersistInput,
  ScienceProjectDataRefreshPersistResult,
} from "../../shared/science-project-data-refresh";

const SUPPORTED_FILE_EXTENSIONS = new Set([".csv", ".xlsx", ".xls"]);
const HIDDEN_GENERATED_NAME = /^\.agentlas(?:-|$)/u;

function sha256(value: Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function projectDataErrorCode(error: unknown): string {
  if (error instanceof Error && /^science-project-data-[a-z0-9-]+$/u.test(error.message)) return error.message;
  return "science-project-data-candidate-read-failed";
}

/**
 * Build the same bounded, revalidated refresh input used by the renderer IPC
 * path. The caller owns the document/grant assertion and persistence boundary;
 * this helper is intentionally Main-only so automatic refresh cannot be
 * confused with a renderer-initiated import or analysis.
 */
export function scienceProjectDataRefreshInputFromFilesystem(
  store: ScienceStore,
  input: { requestId: string; projectId: string; mode: ScienceProjectDataRefreshMode },
): ScienceProjectDataRefreshPersistInput {
  const rootIdentity = scienceProjectDataRootIdentity(store, input.projectId);
  const discovery = discoverScienceProjectData(store, input.projectId);
  const observations: ScienceProjectDataRefreshObservation[] = discovery.candidates.map((candidate) => {
    try {
      const resolved = resolveScienceProjectDataCandidate(store, input.projectId, candidate.candidateId, candidate.relativePath);
      const bytes = readResolvedScienceProjectDataCandidate(resolved);
      return {
        candidate,
        hash: { status: "verified", contentSha256: sha256(bytes) },
        identityJson: JSON.stringify(resolved.identity),
      };
    } catch (error) {
      return {
        candidate,
        hash: { status: "unreadable", reason: projectDataErrorCode(error) },
        identityJson: null,
      };
    }
  });
  return {
    requestId: input.requestId,
    projectId: input.projectId,
    mode: input.mode,
    rootIdentity,
    status: discovery.truncated ? "truncated" : "complete",
    skippedCount: discovery.skippedCount,
    observations,
  };
}

export interface ScienceProjectDataAutoRefreshResult {
  scheduled: boolean;
  projectId: string;
  reason: "folder-unavailable" | "scheduled";
}

interface ActiveProject {
  projectId: string;
  dataDirectoryPath: string;
  generation: number;
  timer: NodeJS.Timeout | null;
  running: boolean;
  queued: boolean;
  watchers: fs.FSWatcher[];
}

interface AutoRefreshOptions {
  store: () => ScienceStore;
  debounceMs?: number;
  logger?: Pick<Console, "info" | "warn">;
  notify?: (senderId: number, change: {
    schema: "agentlas.science-data-refresh-notification/v1";
    projectId: string;
    snapshot: ScienceProjectDataRefreshPersistResult["snapshot"];
  }) => void;
}

/**
 * Main-owned activation and filesystem watcher coordinator.
 *
 * It only persists a linked-folder snapshot. It never imports a candidate,
 * starts a run, invokes an LLM, or grants a renderer new filesystem access.
 */
export class ScienceProjectDataAutoRefreshCoordinator {
  private readonly active = new Map<string, ActiveProject>();
  private readonly owners = new Map<string, Set<number>>();
  private readonly senderProjects = new Map<number, string>();
  private readonly senderCleanupAttached = new Set<number>();
  private readonly debounceMs: number;
  private readonly logger: Pick<Console, "info" | "warn">;

  constructor(private readonly options: AutoRefreshOptions) {
    this.debounceMs = options.debounceMs ?? 500;
    this.logger = options.logger ?? console;
  }

  /** Attach a Science view to the active project and schedule its first scan. */
  activate(projectId: string, senderId: number): ScienceProjectDataAutoRefreshResult {
    const store = this.options.store();
    const project = store.getProject(projectId);
    if (!project) throw new Error("science-project-not-found");
    const priorProjectId = this.senderProjects.get(senderId);
    if (priorProjectId && priorProjectId !== projectId) this.detach(priorProjectId, senderId);
    this.senderProjects.set(senderId, projectId);
    this.owners.set(projectId, new Set([...(this.owners.get(projectId) ?? []), senderId]));
    if (!project.folderPath) {
      this.deactivateProjectIfUnowned(projectId);
      return { scheduled: false, projectId, reason: "folder-unavailable" };
    }

    const rootIdentity = scienceProjectDataRootIdentity(store, projectId);
    let state = this.active.get(projectId);
    if (!state || state.dataDirectoryPath !== rootIdentity.dataDirectoryPath) {
      if (state) this.disposeState(state);
      state = {
        projectId,
        dataDirectoryPath: rootIdentity.dataDirectoryPath,
        generation: (state?.generation ?? 0) + 1,
        timer: null,
        running: false,
        queued: false,
        watchers: [],
      };
      this.active.set(projectId, state);
      this.bindWatchers(state);
    }
    this.schedule(state, 0, "activation");
    return { scheduled: true, projectId, reason: "scheduled" };
  }

  /** Stop watching a sender's previous project after its view is destroyed. */
  detachSender(senderId: number): void {
    const projectId = this.senderProjects.get(senderId);
    if (!projectId) return;
    this.senderProjects.delete(senderId);
    this.senderCleanupAttached.delete(senderId);
    this.detach(projectId, senderId);
  }

  /** Register destruction cleanup once for an owning Science WebContents. */
  attachSenderCleanup(sender: { id: number; once: (event: "destroyed", listener: () => void) => void }): void {
    if (this.senderCleanupAttached.has(sender.id)) return;
    this.senderCleanupAttached.add(sender.id);
    sender.once("destroyed", () => this.detachSender(sender.id));
  }

  dispose(): void {
    for (const state of this.active.values()) this.disposeState(state);
    this.active.clear();
    this.owners.clear();
    this.senderProjects.clear();
    this.senderCleanupAttached.clear();
  }

  private detach(projectId: string, senderId: number): void {
    const owners = this.owners.get(projectId);
    owners?.delete(senderId);
    if (owners && owners.size === 0) this.owners.delete(projectId);
    this.deactivateProjectIfUnowned(projectId);
  }

  private deactivateProjectIfUnowned(projectId: string): void {
    if ((this.owners.get(projectId)?.size ?? 0) > 0) return;
    const state = this.active.get(projectId);
    if (!state) return;
    this.disposeState(state);
    this.active.delete(projectId);
  }

  private disposeState(state: ActiveProject): void {
    state.generation += 1;
    if (state.timer) clearTimeout(state.timer);
    state.timer = null;
    for (const watcher of state.watchers) {
      try { watcher.close(); } catch { /* teardown is best effort */ }
    }
    state.watchers = [];
  }

  private schedule(state: ActiveProject, delay: number, reason: string): void {
    if (state.timer) clearTimeout(state.timer);
    const generation = state.generation;
    state.timer = setTimeout(() => {
      state.timer = null;
      if (state.generation !== generation || this.active.get(state.projectId) !== state) return;
      void this.run(state, reason);
    }, Math.max(0, delay));
    state.timer.unref?.();
  }

  private async run(state: ActiveProject, reason: string): Promise<void> {
    if (state.generation !== (this.active.get(state.projectId)?.generation ?? -1)) return;
    if (state.running) {
      state.queued = true;
      return;
    }
    state.running = true;
    const requestId = randomUUID();
    try {
      const store = this.options.store();
      const input = scienceProjectDataRefreshInputFromFilesystem(store, {
        requestId,
        projectId: state.projectId,
        mode: "automatic",
      });
      const result = store.refreshScienceProjectData(input);
      this.logger.info(`[science-project-data] automatic refresh ${state.projectId} ${reason}`, {
        scanId: result.snapshot.scanId,
        revision: result.snapshot.revision,
        status: result.snapshot.status,
        entries: result.snapshot.entries.length,
        replayed: result.replayed,
      });
      const change = {
        schema: "agentlas.science-data-refresh-notification/v1" as const,
        projectId: state.projectId,
        snapshot: result.snapshot,
      };
      for (const senderId of this.owners.get(state.projectId) ?? []) {
        try {
          this.options.notify?.(senderId, change);
        } catch (error) {
          this.logger.warn(`[science-project-data] notification unavailable for ${state.projectId}`, error);
        }
      }
    } catch (error) {
      this.logger.warn(`[science-project-data] automatic refresh unavailable for ${state.projectId}`, error);
    } finally {
      state.running = false;
      if (state.generation === (this.active.get(state.projectId)?.generation ?? -1)) {
        this.bindWatchers(state);
        if (state.queued) {
          state.queued = false;
          this.schedule(state, this.debounceMs, "queued-change");
        }
      }
    }
  }

  private bindWatchers(state: ActiveProject): void {
    for (const watcher of state.watchers) {
      try { watcher.close(); } catch { /* teardown is best effort */ }
    }
    state.watchers = [];
    const onChange = (_eventType: string, filename: string | Buffer | null): void => {
      const name = filename === null ? "" : filename.toString();
      if (name.split(/[\\/]/u).some((part) => HIDDEN_GENERATED_NAME.test(part))) return;
      this.schedule(state, this.debounceMs, "filesystem-change");
    };
    try {
      const watcher = fs.watch(state.dataDirectoryPath, { recursive: true, encoding: "buffer" }, onChange);
      watcher.on("error", (error) => this.logger.warn(`[science-project-data] watcher error for ${state.projectId}`, error));
      state.watchers.push(watcher);
      return;
    } catch {
      // Linux does not support recursive fs.watch. The bounded fallback below
      // watches every discovered directory and candidate file instead.
    }
    for (const target of this.fallbackWatchTargets(state.dataDirectoryPath)) {
      try {
        const watcher = fs.watch(target, { encoding: "buffer" }, onChange);
        watcher.on("error", (error) => this.logger.warn(`[science-project-data] watcher error for ${state.projectId}`, error));
        state.watchers.push(watcher);
      } catch {
        // A file can disappear between discovery and watcher binding; the next
        // directory event or activation will rebuild the bounded set.
      }
    }
  }

  private fallbackWatchTargets(root: string): string[] {
    const targets: string[] = [];
    const queue: Array<{ directory: string; depth: number }> = [{ directory: root, depth: 0 }];
    while (queue.length && targets.length < SCIENCE_PROJECT_DATA_LIMITS.maxEntries * 2) {
      const current = queue.shift()!;
      targets.push(current.directory);
      let entries: fs.Dirent[];
      try { entries = fs.readdirSync(current.directory, { withFileTypes: true }); }
      catch { continue; }
      for (const entry of entries) {
        if (HIDDEN_GENERATED_NAME.test(entry.name)) continue;
        const absolutePath = path.join(current.directory, entry.name);
        if (entry.isDirectory() && current.depth < SCIENCE_PROJECT_DATA_LIMITS.maxDepth) {
          queue.push({ directory: absolutePath, depth: current.depth + 1 });
        } else if (entry.isFile() && SUPPORTED_FILE_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
          targets.push(absolutePath);
        }
        if (targets.length >= SCIENCE_PROJECT_DATA_LIMITS.maxEntries * 2) break;
      }
    }
    return targets;
  }
}
