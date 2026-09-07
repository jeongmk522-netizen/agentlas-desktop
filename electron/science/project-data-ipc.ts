import type { IpcMain, IpcMainInvokeEvent } from "electron";
import { createHash } from "node:crypto";
import type { ProductExtensionPermission } from "../../shared/product-extension";
import type { ScienceStore } from "./store";
import type { ScienceDatasetIngestionService } from "./dataset-ingestion";
import { createScienceDatasetIngestionService } from "./lazy-services";
import {
  discoverScienceProjectData,
  revalidateResolvedScienceProjectDataCandidate,
  readResolvedScienceProjectDataCandidate,
  resolveScienceProjectDataCandidate,
  type ScienceProjectDataCandidate,
} from "./project-data-discovery";
import {
  persistPreparedScienceWorkbook,
  type ScienceWorkbookImportInput,
} from "./workbook-intake-ipc";
import { prepareScienceWorkbook } from "./workbook-ingestion";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

type IpcBoundary = Pick<IpcMain, "handle">;
type ScienceSenderAssertion = (event: IpcMainInvokeEvent, input: unknown, permission?: ProductExtensionPermission) => unknown;
type ScienceProjectDocumentAssertion = (event: IpcMainInvokeEvent, input: unknown) => string;
type DatasetServiceFactory = (store: ScienceStore) => ScienceDatasetIngestionService;

function inputRecord(envelope: unknown): Record<string, unknown> {
  if (!envelope || typeof envelope !== "object" || Array.isArray(envelope)) throw new Error("science-project-data-input-invalid");
  const input = "input" in envelope ? (envelope as { input?: unknown }).input : null;
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("science-project-data-input-invalid");
  return input as Record<string, unknown>;
}

function uuid(value: unknown, code: string): string {
  if (typeof value !== "string" || !UUID_RE.test(value)) throw new Error(code);
  return value;
}

function optionalTitle(value: unknown, fallback: string): string | undefined {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== "string") throw new Error("science-project-data-title-invalid");
  const title = value.replace(/\r\n/g, "\n").trim();
  if (!title || title.length > 1_000) throw new Error("science-project-data-title-invalid");
  return title;
}

function assertOrigin(store: ScienceStore, projectId: string, conversationId: string, originMessageId: string): void {
  if (!store.getProject(projectId)) throw new Error("science-project-not-found");
  if (!store.getMessageForProject(projectId, conversationId, originMessageId)) throw new Error("science-project-data-origin-not-found");
}

function sha256(value: Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function candidateRef(input: Record<string, unknown>): { candidateId: string; relativePath: string } {
  if (typeof input.candidateId !== "string" || typeof input.relativePath !== "string") throw new Error("science-project-data-candidate-invalid");
  return { candidateId: input.candidateId, relativePath: input.relativePath };
}

function candidateResult(candidate: ScienceProjectDataCandidate, contentSha256?: string): Record<string, unknown> {
  return {
    schema: "agentlas.science-data-candidate-read/v1",
    candidate,
    ...(contentSha256 ? { contentSha256 } : {}),
  };
}

/** Main-owned linked-project data discovery and candidate import boundary. */
export function registerScienceProjectDataHandlers(options: {
  ipcMain: IpcBoundary;
  assertScienceSender: ScienceSenderAssertion;
  assertScienceProjectDocument: ScienceProjectDocumentAssertion;
  scienceStore: () => ScienceStore;
  datasetIngestionService?: DatasetServiceFactory;
}): void {
  const datasetService = options.datasetIngestionService ?? ((store: ScienceStore) => createScienceDatasetIngestionService(store));

  options.ipcMain.handle("science:projects:discoverData", (event, envelope: unknown) => {
    options.assertScienceSender(event, envelope, "science:artifacts");
    options.assertScienceProjectDocument(event, envelope);
    const input = inputRecord(envelope);
    uuid(input.requestId, "science-request-id-invalid");
    const projectId = uuid(input.projectId, "science-project-id-invalid");
    return discoverScienceProjectData(options.scienceStore(), projectId);
  });

  options.ipcMain.handle("science:datasets:readCandidate", (event, envelope: unknown) => {
    options.assertScienceSender(event, envelope, "science:artifacts");
    const documentId = options.assertScienceProjectDocument(event, envelope);
    const input = inputRecord(envelope);
    uuid(input.requestId, "science-request-id-invalid");
    const projectId = uuid(input.projectId, "science-project-id-invalid");
    const ref = candidateRef(input);
    const resolved = resolveScienceProjectDataCandidate(options.scienceStore(), projectId, ref.candidateId, ref.relativePath);
    if (options.assertScienceProjectDocument(event, envelope) !== documentId) throw new Error("science-project-data-document-changed");
    const bytes = readResolvedScienceProjectDataCandidate(resolved);
    return candidateResult(resolved.candidate, sha256(bytes));
  });

  options.ipcMain.handle("science:datasets:importCandidate", async (event, envelope: unknown) => {
    options.assertScienceSender(event, envelope, "science:artifacts");
    const documentId = options.assertScienceProjectDocument(event, envelope);
    const input = inputRecord(envelope);
    const requestId = uuid(input.requestId, "science-request-id-invalid");
    const projectId = uuid(input.projectId, "science-project-id-invalid");
    const conversationId = uuid(input.conversationId, "science-project-data-origin-invalid");
    const originMessageId = uuid(input.originMessageId, "science-project-data-origin-invalid");
    const ref = candidateRef(input);
    const store = options.scienceStore();
    assertOrigin(store, projectId, conversationId, originMessageId);
    const resolved = resolveScienceProjectDataCandidate(store, projectId, ref.candidateId, ref.relativePath);
    if (options.assertScienceProjectDocument(event, envelope) !== documentId) throw new Error("science-project-data-document-changed");
    revalidateResolvedScienceProjectDataCandidate(resolved);
    const title = optionalTitle(input.title, resolved.candidate.relativePath);
    if (resolved.candidate.extension === "csv") {
      const artifactRequestId = uuid(input.artifactRequestId, "science-artifact-request-id-invalid");
      const imported = await datasetService(store).importFile(resolved.absolutePath, {
        requestId,
        projectId,
        conversationId,
        originMessageId,
        title,
      }, resolved.identity, () => {
        if (options.assertScienceProjectDocument(event, envelope) !== documentId) throw new Error("science-project-data-document-changed");
        assertOrigin(store, projectId, conversationId, originMessageId);
        revalidateResolvedScienceProjectDataCandidate(resolved);
      });
      const materialized = store.materializeDatasetTable({
        requestId: artifactRequestId,
        projectId,
        runId: imported.run.id,
        title,
      });
      return {
        schema: "agentlas.science-data-import/v1",
        candidate: resolved.candidate,
        format: "csv" as const,
        ...imported,
        artifact: materialized.artifact,
        artifactReplayed: materialized.replayed,
      };
    }
    revalidateResolvedScienceProjectDataCandidate(resolved);
    const prepared = await prepareScienceWorkbook(resolved.absolutePath, undefined, resolved.identity);
    if (options.assertScienceProjectDocument(event, envelope) !== documentId) throw new Error("science-project-data-document-changed");
    assertOrigin(store, projectId, conversationId, originMessageId);
    const current = resolveScienceProjectDataCandidate(store, projectId, ref.candidateId, ref.relativePath);
    if (current.candidate.candidateId !== resolved.candidate.candidateId) throw new Error("science-project-data-candidate-stale");
    revalidateResolvedScienceProjectDataCandidate(current);
    const imported = persistPreparedScienceWorkbook(store, resolved.absolutePath, {
      requestId,
      projectId,
      conversationId,
      originMessageId,
      title,
    } satisfies ScienceWorkbookImportInput, prepared);
    return {
      schema: "agentlas.science-data-import/v1",
      candidate: resolved.candidate,
      format: resolved.candidate.extension,
      ...imported,
    };
  });
}
