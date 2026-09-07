import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import type { ScienceProject } from "../../shared/science-contract";
import { validateScienceProjectFolderPath } from "./project-folder-selection";
import type { ScienceStore } from "./store";

const SHA256_RE = /^[a-f0-9]{64}$/;
const CANDIDATE_ID_RE = /^science-data-candidate-v1:[a-f0-9]{64}$/;
const SUPPORTED_EXTENSIONS = new Set([".csv", ".xlsx", ".xls"]);
// Keep the exclusion list limited to the app-owned namespace. Research folders such as
// `raw`, `prepared`, `derived`, or `outputs` can be legitimate user inputs and must remain
// discoverable. The reserved .agentlas directory is the only generated tree we skip here.
const EXCLUDED_DIRECTORY_NAMES = new Set([".agentlas"]);
const EXCLUDED_FILE_PREFIXES = [".agentlas-"];

export const SCIENCE_PROJECT_DATA_LIMITS = Object.freeze({
  maxDepth: 3,
  maxEntries: 2_048,
  maxCandidates: 512,
  maxFileBytes: 8 * 1024 * 1024,
  maxTotalBytes: 64 * 1024 * 1024,
});

export type ScienceProjectDataFormat = "csv" | "xlsx" | "xls";

export interface ScienceProjectDataFileIdentity {
  device: number;
  inode: number;
  byteSize: number;
  modifiedAtMs: number;
  changedAtMs: number;
}

export interface ScienceProjectDataCandidate {
  schema: "agentlas.science-data-candidate/v1";
  candidateId: string;
  relativePath: string;
  extension: ScienceProjectDataFormat;
  mimeType: "text/csv" | "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" | "application/vnd.ms-excel";
  byteSize: number;
  modifiedAt: string;
  fingerprint: string;
}

export interface ScienceProjectDataDiscoveryResult {
  schema: "agentlas.science-data-discovery/v1";
  projectId: string;
  dataDirectory: "data";
  dataDirectoryCreated: boolean;
  candidates: ScienceProjectDataCandidate[];
  skippedCount: number;
  truncated: boolean;
}

export interface ResolvedScienceProjectDataCandidate {
  candidate: ScienceProjectDataCandidate;
  absolutePath: string;
  identity: ScienceProjectDataFileIdentity;
}

export interface ScienceProjectDataRootIdentity {
  schema: "agentlas.science-data-root-identity/v1";
  rootPath: string;
  dataDirectoryPath: string;
  device: number;
  inode: number;
  byteSize: number;
  modifiedAtMs: number;
  changedAtMs: number;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value).sort(([left], [right]) => left.localeCompare(right)).map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function isWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function scienceProject(store: ScienceStore, projectId: string): { project: ScienceProject; root: string } {
  const project = store.getProject(projectId);
  if (!project) throw new Error("science-project-not-found");
  if (!project.folderPath) throw new Error("science-project-folder-not-selected");
  const root = validateScienceProjectFolderPath(project.folderPath);
  if (root !== project.folderPath) throw new Error("science-project-folder-selection-changed");
  return { project, root };
}

function ensureDataDirectory(root: string): { path: string; created: boolean } {
  const dataPath = path.join(root, "data");
  let created = false;
  try {
    const existing = fs.lstatSync(dataPath);
    if (existing.isSymbolicLink()) throw new Error("science-project-data-folder-symlink-forbidden");
    if (!existing.isDirectory()) throw new Error("science-project-data-folder-not-directory");
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("science-project-data-folder-")) throw error;
    if (!(error && typeof error === "object" && "code" in error && (error as { code?: unknown }).code === "ENOENT")) {
      throw new Error("science-project-data-folder-unavailable");
    }
    try {
      fs.mkdirSync(dataPath, { recursive: true, mode: 0o700 });
      created = true;
    } catch {
      throw new Error("science-project-data-folder-create-failed");
    }
  }
  let canonical: string;
  try { canonical = fs.realpathSync(dataPath); }
  catch { throw new Error("science-project-data-folder-unavailable"); }
  if (!isWithin(root, canonical) || canonical !== path.resolve(dataPath)) throw new Error("science-project-data-folder-escape");
  return { path: canonical, created };
}

/** Main-only identity for the persisted project data root; paths never enter the renderer snapshot. */
export function scienceProjectDataRootIdentity(store: ScienceStore, projectId: string): ScienceProjectDataRootIdentity {
  const { root } = scienceProject(store, projectId);
  const dataDirectory = ensureDataDirectory(root);
  let stat: fs.Stats;
  try { stat = fs.lstatSync(dataDirectory.path); }
  catch { throw new Error("science-project-data-folder-unavailable"); }
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error("science-project-data-folder-unavailable");
  const identity = identityFromStat(stat);
  return {
    schema: "agentlas.science-data-root-identity/v1",
    rootPath: root,
    dataDirectoryPath: dataDirectory.path,
    ...identity,
  };
}

function identityFromStat(stat: fs.Stats): ScienceProjectDataFileIdentity {
  return {
    device: Number(stat.dev),
    inode: Number(stat.ino),
    byteSize: Number(stat.size),
    modifiedAtMs: Number(stat.mtimeMs),
    changedAtMs: Number(stat.ctimeMs),
  };
}

function sameIdentity(left: ScienceProjectDataFileIdentity, right: ScienceProjectDataFileIdentity): boolean {
  return left.device === right.device && left.inode === right.inode && left.byteSize === right.byteSize
    && left.modifiedAtMs === right.modifiedAtMs && left.changedAtMs === right.changedAtMs;
}

function relativeProjectPath(root: string, absolutePath: string): string {
  const relative = path.relative(root, absolutePath).split(path.sep).join("/");
  if (!relative || relative.startsWith("../") || relative === ".." || path.isAbsolute(relative)) throw new Error("science-project-data-path-escape");
  return relative;
}

function extensionFor(filePath: string): ScienceProjectDataFormat | null {
  const extension = path.extname(filePath).toLowerCase();
  if (!SUPPORTED_EXTENSIONS.has(extension)) return null;
  return extension.slice(1) as ScienceProjectDataFormat;
}

function mimeTypeFor(extension: ScienceProjectDataFormat): ScienceProjectDataCandidate["mimeType"] {
  if (extension === "csv") return "text/csv";
  if (extension === "xls") return "application/vnd.ms-excel";
  return "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
}

function excludedDirectory(name: string): boolean {
  return EXCLUDED_DIRECTORY_NAMES.has(name.toLocaleLowerCase("en-US"));
}

function excludedFile(name: string): boolean {
  return EXCLUDED_FILE_PREFIXES.some((prefix) => name.toLocaleLowerCase("en-US").startsWith(prefix));
}

function candidateFromStat(projectId: string, root: string, absolutePath: string, stat: fs.Stats): {
  candidate: ScienceProjectDataCandidate;
  identity: ScienceProjectDataFileIdentity;
} {
  const extension = extensionFor(absolutePath);
  if (!extension) throw new Error("science-project-data-format-invalid");
  const identity = identityFromStat(stat);
  const relativePath = relativeProjectPath(root, absolutePath);
  const fingerprint = sha256(canonicalJson({ schema: "agentlas.science-data-file-identity/v1", relativePath, identity }));
  const candidateId = `science-data-candidate-v1:${sha256(canonicalJson({ schema: "agentlas.science-data-candidate/v1", projectId, relativePath, fingerprint }))}`;
  return {
    identity,
    candidate: {
      schema: "agentlas.science-data-candidate/v1",
      candidateId,
      relativePath,
      extension,
      mimeType: mimeTypeFor(extension),
      byteSize: identity.byteSize,
      modifiedAt: new Date(identity.modifiedAtMs).toISOString(),
      fingerprint,
    },
  };
}

function inspectCandidate(projectId: string, root: string, dataPath: string, relativePath: string): ResolvedScienceProjectDataCandidate {
  if (typeof relativePath !== "string" || !relativePath || relativePath.length > 1_024 || relativePath.includes("\\")) throw new Error("science-project-data-candidate-invalid");
  const normalized = relativePath.split("/").filter(Boolean).join("/");
  if (normalized !== relativePath || normalized.split("/").some((part) => part === "." || part === "..")) throw new Error("science-project-data-candidate-invalid");
  const absolutePath = path.resolve(root, relativePath);
  if (!isWithin(dataPath, absolutePath)) throw new Error("science-project-data-candidate-path-escape");
  let stat: fs.Stats;
  try { stat = fs.lstatSync(absolutePath); }
  catch { throw new Error("science-project-data-candidate-not-found"); }
  if (stat.isSymbolicLink()) throw new Error("science-project-data-candidate-symlink-forbidden");
  if (!stat.isFile()) throw new Error("science-project-data-candidate-not-file");
  const extension = extensionFor(absolutePath);
  if (!extension || excludedFile(path.basename(absolutePath))) throw new Error("science-project-data-candidate-not-supported");
  if (stat.size < 1 || stat.size > SCIENCE_PROJECT_DATA_LIMITS.maxFileBytes) throw new Error("science-project-data-candidate-size-invalid");
  let canonical: string;
  try { canonical = fs.realpathSync(absolutePath); }
  catch { throw new Error("science-project-data-candidate-unavailable"); }
  if (canonical !== absolutePath || !isWithin(dataPath, canonical)) throw new Error("science-project-data-candidate-path-escape");
  const result = candidateFromStat(projectId, root, absolutePath, stat);
  return { ...result, absolutePath };
}

export function discoverScienceProjectData(store: ScienceStore, projectId: string): ScienceProjectDataDiscoveryResult {
  const { root } = scienceProject(store, projectId);
  const dataDirectory = ensureDataDirectory(root);
  const candidates: ScienceProjectDataCandidate[] = [];
  const stack: Array<{ absolutePath: string; depth: number }> = [{ absolutePath: dataDirectory.path, depth: 0 }];
  const visited = new Set<string>();
  let entries = 0;
  let skippedCount = 0;
  let totalBytes = 0;
  let truncated = false;
  while (stack.length && !truncated) {
    const current = stack.pop()!;
    let currentStat: fs.Stats;
    try { currentStat = fs.lstatSync(current.absolutePath); }
    catch { skippedCount += 1; continue; }
    // lstat before realpath prevents a directory replaced by a symlink from being followed.
    if (currentStat.isSymbolicLink() || !currentStat.isDirectory()) { skippedCount += 1; continue; }
    let currentCanonical: string;
    try { currentCanonical = fs.realpathSync(current.absolutePath); }
    catch { skippedCount += 1; continue; }
    if (!isWithin(dataDirectory.path, currentCanonical) || visited.has(currentCanonical)) { skippedCount += 1; continue; }
    visited.add(currentCanonical);
    let directory: fs.Dir | null = null;
    try {
      directory = fs.opendirSync(currentCanonical);
      // Re-check after opening: a replacement between lstat and opendir must not redirect the walk.
      if (fs.realpathSync(currentCanonical) !== currentCanonical) {
        directory.closeSync();
        directory = null;
        skippedCount += 1;
        continue;
      }
    } catch {
      if (directory) try { directory.closeSync(); } catch { /* best effort */ }
      skippedCount += 1;
      continue;
    }
    try {
      if (!directory) { skippedCount += 1; continue; }
      for (;;) {
        const entry = directory.readSync();
        if (!entry) break;
        entries += 1;
        if (entries > SCIENCE_PROJECT_DATA_LIMITS.maxEntries) { truncated = true; break; }
        const entryPath = path.join(currentCanonical, entry.name);
        if (!entry.name || (entry.isDirectory() && excludedDirectory(entry.name))) { skippedCount += 1; continue; }
        if (entry.isSymbolicLink()) { skippedCount += 1; continue; }
        let stat: fs.Stats;
        try { stat = fs.lstatSync(entryPath); }
        catch { skippedCount += 1; continue; }
        if (stat.isSymbolicLink()) { skippedCount += 1; continue; }
        if (stat.isDirectory()) {
          if (current.depth >= SCIENCE_PROJECT_DATA_LIMITS.maxDepth) { skippedCount += 1; continue; }
          stack.push({ absolutePath: entryPath, depth: current.depth + 1 });
          continue;
        }
        if (!stat.isFile() || excludedFile(entry.name)) { skippedCount += 1; continue; }
        const extension = extensionFor(entry.name);
        if (!extension || stat.size < 1 || stat.size > SCIENCE_PROJECT_DATA_LIMITS.maxFileBytes) { skippedCount += 1; continue; }
        if (candidates.length >= SCIENCE_PROJECT_DATA_LIMITS.maxCandidates || totalBytes + stat.size > SCIENCE_PROJECT_DATA_LIMITS.maxTotalBytes) {
          truncated = true;
          break;
        }
        let canonical: string;
        try { canonical = fs.realpathSync(entryPath); }
        catch { skippedCount += 1; continue; }
        if (canonical !== entryPath || !isWithin(dataDirectory.path, canonical)) { skippedCount += 1; continue; }
        const result = candidateFromStat(projectId, root, canonical, stat);
        candidates.push(result.candidate);
        totalBytes += stat.size;
      }
    } finally {
      if (directory) try { directory.closeSync(); } catch { /* best effort */ }
    }
  }
  candidates.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
  return {
    schema: "agentlas.science-data-discovery/v1",
    projectId,
    dataDirectory: "data",
    dataDirectoryCreated: dataDirectory.created,
    candidates,
    skippedCount,
    truncated,
  };
}

export function resolveScienceProjectDataCandidate(
  store: ScienceStore,
  projectId: string,
  candidateId: string,
  relativePath: string,
): ResolvedScienceProjectDataCandidate {
  if (!CANDIDATE_ID_RE.test(candidateId) || !SHA256_RE.test(candidateId.slice("science-data-candidate-v1:".length))) throw new Error("science-project-data-candidate-invalid");
  const { root } = scienceProject(store, projectId);
  const dataDirectory = ensureDataDirectory(root);
  const resolved = inspectCandidate(projectId, root, dataDirectory.path, relativePath);
  if (resolved.candidate.candidateId !== candidateId) throw new Error("science-project-data-candidate-stale");
  return resolved;
}

/** Re-check the path and identity immediately before a parser or reader opens it. */
export function revalidateResolvedScienceProjectDataCandidate(resolved: ResolvedScienceProjectDataCandidate): void {
  let stat: fs.Stats;
  try { stat = fs.lstatSync(resolved.absolutePath); }
  catch { throw new Error("science-project-data-candidate-stale"); }
  if (stat.isSymbolicLink() || !stat.isFile()) throw new Error("science-project-data-candidate-stale");
  let canonical: string;
  try { canonical = fs.realpathSync(resolved.absolutePath); }
  catch { throw new Error("science-project-data-candidate-stale"); }
  if (canonical !== resolved.absolutePath || !sameIdentity(resolved.identity, identityFromStat(stat))) {
    throw new Error("science-project-data-candidate-stale");
  }
}

export function readResolvedScienceProjectDataCandidate(resolved: ResolvedScienceProjectDataCandidate): Buffer {
  let fd: number | null = null;
  try {
    revalidateResolvedScienceProjectDataCandidate(resolved);
    const noFollow = typeof fs.constants.O_NOFOLLOW === "number" ? fs.constants.O_NOFOLLOW : 0;
    fd = fs.openSync(resolved.absolutePath, fs.constants.O_RDONLY | noFollow);
    const before = fs.fstatSync(fd);
    if (!sameIdentity(resolved.identity, identityFromStat(before))) throw new Error("science-project-data-candidate-stale");
    if (!before.isFile() || before.size < 1 || before.size > SCIENCE_PROJECT_DATA_LIMITS.maxFileBytes) throw new Error("science-project-data-candidate-size-invalid");
    const bytes = Buffer.alloc(before.size);
    let offset = 0;
    while (offset < bytes.length) {
      const count = fs.readSync(fd, bytes, offset, bytes.length - offset, null);
      if (!count) break;
      offset += count;
    }
    const after = fs.fstatSync(fd);
    if (offset !== before.size || !sameIdentity(resolved.identity, identityFromStat(after))) throw new Error("science-project-data-candidate-stale");
    return bytes;
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("science-project-data-")) throw error;
    throw new Error("science-project-data-candidate-read-failed");
  } finally {
    if (fd !== null) try { fs.closeSync(fd); } catch { /* best effort */ }
  }
}
