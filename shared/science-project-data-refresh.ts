/**
 * Pure contracts and classification for linked-project data refreshes.
 *
 * The Electron discovery walker owns filesystem identity and hashing. This module
 * deliberately has no Node or store dependency so the same deterministic rules can
 * be used by the persistence layer, private tests, and a future snapshot projection.
 */

export const SCIENCE_PROJECT_DATA_REFRESH_SCHEMA = "agentlas.science-data-refresh/v1" as const;
export const SCIENCE_PROJECT_DATA_CANDIDATE_SCHEMA = "agentlas.science-data-candidate/v1" as const;

export const SCIENCE_PROJECT_DATA_ENTRY_STATES = Object.freeze([
  "new",
  "unchanged",
  "changed",
  "missing",
  "unreadable",
] as const);

export type ScienceProjectDataEntryState = (typeof SCIENCE_PROJECT_DATA_ENTRY_STATES)[number];
export type ScienceProjectDataRefreshMode = "manual" | "automatic";
export type ScienceProjectDataFormat = "csv" | "xlsx" | "xls";

export interface ScienceProjectDataRefreshCandidate {
  schema: typeof SCIENCE_PROJECT_DATA_CANDIDATE_SCHEMA;
  candidateId: string;
  relativePath: string;
  extension: ScienceProjectDataFormat;
  mimeType:
    | "text/csv"
    | "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    | "application/vnd.ms-excel";
  byteSize: number;
  modifiedAt: string;
  fingerprint: string;
}

export interface ScienceProjectDataRefreshPreviousEntry {
  entryId: string;
  candidateId: string;
  relativePath: string;
  fingerprint: string;
  contentSha256: string | null;
  /** Main-only stat identity retained as JSON; never projected to the renderer. */
  identityJson: string | null;
  candidate: ScienceProjectDataRefreshCandidate | null;
  state: ScienceProjectDataEntryState;
  observed: boolean;
  duplicateOfRelativePath: string | null;
  unreadableReason: string | null;
}

export type ScienceProjectDataRefreshHashOutcome =
  | { status: "verified"; contentSha256: string }
  | { status: "unreadable"; reason: string };

export interface ScienceProjectDataRefreshObservation {
  candidate: ScienceProjectDataRefreshCandidate;
  hash: ScienceProjectDataRefreshHashOutcome;
  /** Canonical JSON for the internally revalidated stat identity. */
  identityJson: string | null;
}

export interface ScienceProjectDataRefreshInput {
  previousEntries: readonly ScienceProjectDataRefreshPreviousEntry[];
  observations: readonly ScienceProjectDataRefreshObservation[];
  /** A truncated enumeration must never infer missing files. */
  truncated: boolean;
}

export interface ScienceProjectDataRefreshClassifiedEntry {
  /** Candidate ID for a live file, or a stable tombstone key for a missing file. */
  entryKey: string;
  candidateId: string;
  candidate: ScienceProjectDataRefreshCandidate | null;
  relativePath: string;
  fingerprint: string | null;
  contentSha256: string | null;
  identityJson: string | null;
  state: ScienceProjectDataEntryState;
  previousEntryId: string | null;
  /** False means this row was carried forward from a truncated/failed scan. */
  observed: boolean;
  /** Resolved to a scan entry ID by the store after all live rows are inserted. */
  duplicateOfRelativePath: string | null;
  unreadableReason: string | null;
}

export interface ScienceProjectDataRefreshChanges {
  new: number;
  changed: number;
  unchanged: number;
  missing: number;
  /** Duplicate is an association overlay; it does not replace the base state. */
  duplicate: number;
  unreadable: number;
}

export interface ScienceProjectDataRefreshClassification {
  entries: ScienceProjectDataRefreshClassifiedEntry[];
  changes: ScienceProjectDataRefreshChanges;
}

export interface ScienceProjectDataRefreshPersistInput {
  requestId: string;
  projectId: string;
  mode: ScienceProjectDataRefreshMode;
  rootIdentity: unknown;
  status: "complete" | "truncated" | "failed";
  skippedCount: number;
  observations: readonly ScienceProjectDataRefreshObservation[];
}

export interface ScienceProjectDataRefreshPersistResult {
  snapshot: ScienceProjectDataSnapshot;
  replayed: boolean;
}

export interface ScienceProjectDataEntryImportInput {
  requestId: string;
  projectId: string;
  entryId: string;
  sourceId: string;
  sourceVersionId: string;
  importRunId: string;
  contentSha256: string;
}

export interface ScienceProjectDataEntryImportResult {
  association: ScienceProjectDataEntryImportAssociation;
  replayed: boolean;
}

export interface ScienceProjectDataEntryImportAssociation {
  id: string;
  projectId: string;
  entryId: string;
  sourceId: string;
  sourceVersionId: string;
  importRunId: string;
  contentSha256: string;
  createdAt: string;
}

export interface ScienceProjectDataSnapshotEntry {
  id: string;
  projectId: string;
  scanId: string;
  previousEntryId: string | null;
  candidateId: string;
  candidate: ScienceProjectDataRefreshCandidate | null;
  relativePath: string;
  fingerprint: string;
  contentSha256: string | null;
  state: ScienceProjectDataEntryState;
  observed: boolean;
  duplicateOfEntryId: string | null;
  import: ScienceProjectDataEntryImportAssociation | null;
}

export interface ScienceProjectDataSnapshot {
  schema: typeof SCIENCE_PROJECT_DATA_REFRESH_SCHEMA;
  projectId: string;
  scanId: string;
  revision: number;
  status: "complete" | "truncated" | "failed";
  entries: ScienceProjectDataSnapshotEntry[];
  changes: ScienceProjectDataRefreshChanges;
}

const SHA256_RE = /^[a-f0-9]{64}$/;

function assertRelativePath(relativePath: string): void {
  if (!relativePath || relativePath.includes("\\") || relativePath.startsWith("/")) {
    throw new Error("science-project-data-refresh-relative-path-invalid");
  }
  const parts = relativePath.split("/");
  if (parts.some((part) => !part || part === "." || part === "..")) {
    throw new Error("science-project-data-refresh-relative-path-invalid");
  }
}

function assertSha256(value: string, code: string): void {
  if (!SHA256_RE.test(value)) throw new Error(code);
}

function validateCandidate(candidate: ScienceProjectDataRefreshCandidate): void {
  if (candidate.schema !== SCIENCE_PROJECT_DATA_CANDIDATE_SCHEMA || !candidate.candidateId) {
    throw new Error("science-project-data-refresh-candidate-invalid");
  }
  assertRelativePath(candidate.relativePath);
  if (!Number.isSafeInteger(candidate.byteSize) || candidate.byteSize < 1) {
    throw new Error("science-project-data-refresh-candidate-invalid");
  }
  assertSha256(candidate.fingerprint, "science-project-data-refresh-fingerprint-invalid");
}

function validatePreviousEntry(entry: ScienceProjectDataRefreshPreviousEntry): void {
  if (!entry.entryId || !entry.candidateId) throw new Error("science-project-data-refresh-previous-entry-invalid");
  assertRelativePath(entry.relativePath);
  assertSha256(entry.fingerprint, "science-project-data-refresh-fingerprint-invalid");
  if (entry.contentSha256 !== null) assertSha256(entry.contentSha256, "science-project-data-refresh-content-hash-invalid");
  if (entry.candidate !== null) {
    validateCandidate(entry.candidate);
    if (entry.candidate.candidateId !== entry.candidateId || entry.candidate.relativePath !== entry.relativePath || entry.candidate.fingerprint !== entry.fingerprint) {
      throw new Error("science-project-data-refresh-previous-entry-candidate-mismatch");
    }
  }
  if (!SCIENCE_PROJECT_DATA_ENTRY_STATES.includes(entry.state)) throw new Error("science-project-data-refresh-state-invalid");
  if (typeof entry.observed !== "boolean") throw new Error("science-project-data-refresh-observed-invalid");
  if (entry.duplicateOfRelativePath !== null) assertRelativePath(entry.duplicateOfRelativePath);
  if (entry.unreadableReason !== null && !entry.unreadableReason.trim()) throw new Error("science-project-data-refresh-unreadable-reason-invalid");
}

function validateHashOutcome(hash: ScienceProjectDataRefreshHashOutcome): void {
  if (hash.status === "verified") {
    assertSha256(hash.contentSha256, "science-project-data-refresh-content-hash-invalid");
    return;
  }
  if (hash.status !== "unreadable" || !hash.reason.trim()) throw new Error("science-project-data-refresh-hash-outcome-invalid");
}

function emptyChanges(): ScienceProjectDataRefreshChanges {
  return { new: 0, changed: 0, unchanged: 0, missing: 0, duplicate: 0, unreadable: 0 };
}

/**
 * Classify one bounded scan against the current snapshot head.
 *
 * `duplicateOfRelativePath` is intentionally path based here: the persistence
 * layer can insert all live rows first and resolve it to an immutable entry ID
 * without making the classifier depend on database-generated IDs.
 */
export function classifyScienceProjectDataRefresh(
  input: ScienceProjectDataRefreshInput,
): ScienceProjectDataRefreshClassification {
  const previousByPath = new Map<string, ScienceProjectDataRefreshPreviousEntry>();
  for (const entry of input.previousEntries) {
    validatePreviousEntry(entry);
    if (previousByPath.has(entry.relativePath)) throw new Error("science-project-data-refresh-previous-path-conflict");
    previousByPath.set(entry.relativePath, entry);
  }

  const observations = [...input.observations].sort((left, right) => left.candidate.relativePath.localeCompare(right.candidate.relativePath));
  const seenPaths = new Set<string>();
  const entries: ScienceProjectDataRefreshClassifiedEntry[] = [];
  for (const observation of observations) {
    validateCandidate(observation.candidate);
    validateHashOutcome(observation.hash);
    const { candidate } = observation;
    if (seenPaths.has(candidate.relativePath)) throw new Error("science-project-data-refresh-observation-path-conflict");
    seenPaths.add(candidate.relativePath);
    const previous = previousByPath.get(candidate.relativePath) || null;
    const isReadable = observation.hash.status === "verified";
    const observedContentSha256 = observation.hash.status === "verified" ? observation.hash.contentSha256 : null;
    const unreadableReason = observation.hash.status === "unreadable" ? observation.hash.reason : null;
    const sameVersion = Boolean(
      previous
      && previous.state !== "missing"
      && previous.state !== "unreadable"
      && previous.fingerprint === candidate.fingerprint
      && previous.contentSha256 === observedContentSha256,
    );
    const state: ScienceProjectDataEntryState = !isReadable
      ? "unreadable"
      : !previous
        ? "new"
        : sameVersion
          ? "unchanged"
          : "changed";
    entries.push({
      entryKey: candidate.candidateId,
      candidateId: candidate.candidateId,
      candidate,
      relativePath: candidate.relativePath,
      fingerprint: candidate.fingerprint,
      contentSha256: observedContentSha256,
      identityJson: observation.identityJson,
      state,
      previousEntryId: previous?.entryId || null,
      observed: true,
      duplicateOfRelativePath: null,
      unreadableReason,
    });
  }

  for (const previous of previousByPath.values()) {
    if (seenPaths.has(previous.relativePath)) continue;
    if (input.truncated) {
      entries.push({
        entryKey: `unobserved:${previous.entryId}`,
        candidateId: previous.candidateId,
        candidate: previous.candidate,
        relativePath: previous.relativePath,
        fingerprint: previous.fingerprint,
        contentSha256: previous.contentSha256,
        identityJson: previous.identityJson,
        state: previous.state,
        previousEntryId: previous.entryId,
        observed: false,
        duplicateOfRelativePath: previous.duplicateOfRelativePath,
        unreadableReason: previous.unreadableReason,
      });
      continue;
    }
    entries.push({
      entryKey: `missing:${previous.entryId}`,
      candidateId: previous.candidateId,
      candidate: null,
      relativePath: previous.relativePath,
      fingerprint: previous.fingerprint,
      contentSha256: previous.contentSha256,
      identityJson: previous.identityJson,
      state: "missing",
      previousEntryId: previous.entryId,
      observed: true,
      duplicateOfRelativePath: null,
      unreadableReason: null,
    });
  }

  const readableByHash = new Map<string, ScienceProjectDataRefreshClassifiedEntry[]>();
  for (const entry of entries) {
    // Carry-forward rows retain their previous entry identity, but duplicate
    // is a relationship in the current effective snapshot.  Clear it before
    // regrouping so a truncated scan cannot leave a stale A/B duplicate link
    // after the observed file at A changes content.
    entry.duplicateOfRelativePath = null;
    if (!entry.candidate || !entry.contentSha256) continue;
    const group = readableByHash.get(entry.contentSha256) || [];
    group.push(entry);
    readableByHash.set(entry.contentSha256, group);
  }
  let duplicate = 0;
  for (const group of readableByHash.values()) {
    group.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
    const canonical = group[0];
    for (const entry of group.slice(1)) {
      entry.duplicateOfRelativePath = canonical.relativePath;
      if (entry.observed) duplicate += 1;
    }
  }

  entries.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
  const changes = emptyChanges();
  for (const entry of entries) {
    if (entry.observed) changes[entry.state] += 1;
  }
  changes.duplicate = duplicate;
  return { entries, changes };
}

/** Stable, hash-ready material for the store's scan fingerprint calculation. */
export function scienceProjectDataRefreshFingerprintMaterial(
  rootIdentity: unknown,
  input: ScienceProjectDataRefreshInput,
  classification: ScienceProjectDataRefreshClassification,
): Record<string, unknown> {
  return {
    schema: SCIENCE_PROJECT_DATA_REFRESH_SCHEMA,
    rootIdentity,
    truncated: input.truncated,
    entries: classification.entries.map((entry) => ({
      relativePath: entry.relativePath,
      candidateId: entry.candidate?.candidateId || null,
      fingerprint: entry.fingerprint,
      contentSha256: entry.contentSha256,
      observed: entry.observed,
      duplicateOfRelativePath: entry.duplicateOfRelativePath,
      unreadableReason: entry.unreadableReason,
    })),
  };
}
