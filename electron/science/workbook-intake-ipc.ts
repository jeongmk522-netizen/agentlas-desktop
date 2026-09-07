import { BrowserWindow, dialog } from "electron";
import type { IpcMain, IpcMainInvokeEvent } from "electron";
import path from "node:path";
import type { ProductExtensionPermission } from "../../shared/product-extension";
import { verifyScienceWorkbook } from "../../shared/science-workbook";
import type { ScienceResearchRun, ScienceSource } from "../../shared/science-contract";
import type { ScienceStore } from "./store";
import { prepareScienceWorkbook } from "./workbook-ingestion";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256_RE = /^[a-f0-9]{64}$/;
const MAX_PREVIEW_CELLS = 64;
const MAX_PREVIEW_MERGES = 100;

type IpcBoundary = Pick<IpcMain, "handle">;
type ScienceSenderAssertion = (event: IpcMainInvokeEvent, input: unknown, permission?: ProductExtensionPermission) => unknown;
type ScienceProjectDocumentAssertion = (event: IpcMainInvokeEvent, input: unknown) => string;
type WorkbookCellValue = string | number | boolean | null;
type WorkbookCell = {
  address: string;
  type: string;
  value: WorkbookCellValue;
  formula: string | null;
  numberFormat: string | null;
  warning: "formula-cache-missing" | "cell-error" | "unsupported-cell-type" | null;
};
type WorkbookSheet = {
  ordinal: number;
  name: string;
  hidden: number;
  range: string | null;
  merges: string[];
  cells: WorkbookCell[];
  sheetSha256: string;
};
type WorkbookEnvelope = {
  schema: "agentlas.science-workbook-cells/v1";
  format: "xls" | "xlsx";
  rawSha256: string;
  parser: { id: "styled-exceljs"; version: "0.21.1" };
  date1904: boolean;
  sheets: WorkbookSheet[];
  workbookSha256: string;
};

export interface ScienceWorkbookPreviewCell {
  address: string;
  type: string;
  value: WorkbookCellValue;
  formula: string | null;
  numberFormat: string | null;
  warning: WorkbookCell["warning"];
}

export interface ScienceWorkbookSheetPreview {
  ordinal: number;
  name: string;
  hidden: number;
  range: string | null;
  mergeCount: number;
  merges: string[];
  cellCount: number;
  sheetSha256: string;
  previewCells: ScienceWorkbookPreviewCell[];
}

export interface ScienceWorkbookReadback {
  schema: "agentlas.science-workbook-readback/v1";
  runId: string;
  source: {
    id: string;
    versionId: string;
    rawSha256: string;
    mimeType: string | null;
  };
  format: WorkbookEnvelope["format"];
  parser: WorkbookEnvelope["parser"];
  date1904: boolean;
  workbookSha256: string;
  sheets: ScienceWorkbookSheetPreview[];
}

export interface ScienceWorkbookImportInput {
  requestId: string;
  projectId: string;
  conversationId: string;
  originMessageId: string;
  title?: string;
}

export type PreparedScienceWorkbook = Awaited<ReturnType<typeof prepareScienceWorkbook>>;

function inputRecord(envelope: unknown): Record<string, unknown> {
  if (!envelope || typeof envelope !== "object" || Array.isArray(envelope)) throw new Error("science-workbook-input-invalid");
  const input = "input" in envelope ? (envelope as { input?: unknown }).input : null;
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("science-workbook-input-invalid");
  return input as Record<string, unknown>;
}

function uuid(value: unknown, code: string): string {
  if (typeof value !== "string" || !UUID_RE.test(value)) throw new Error(code);
  return value;
}

function optionalTitle(value: unknown, fallback: string): string {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== "string") throw new Error("science-workbook-title-invalid");
  const title = value.replace(/\r\n/g, "\n").trim();
  if (!title || title.length > 1_000) throw new Error("science-workbook-title-invalid");
  return title;
}

function optionalSheetOrdinal(value: unknown): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) >= 100) throw new Error("science-workbook-sheet-invalid");
  return value as number;
}

function parsePersistedWorkbook(store: ScienceStore, projectId: string, runId: string): {
  run: ScienceResearchRun;
  source: ScienceSource;
  workbook: WorkbookEnvelope;
} {
  const run = store.getResearchRunForProject(projectId, runId);
  if (!run || run.status !== "succeeded" || run.toolId !== "agentlas.workbook-ingest"
    || run.toolVersion !== "1.0.0" || run.outputs.length !== 2) throw new Error("science-workbook-run-not-found");
  const workbookOutput = run.outputs.find((output) => output.role === "workbook-grid");
  if (!workbookOutput || workbookOutput.mimeType !== "application/vnd.agentlas.science.workbook+json"
    || workbookOutput.artifactId !== null || workbookOutput.artifactVersion !== null) throw new Error("science-workbook-output-invalid");
  const bindings = store.getResearchRunSourceBindings(projectId, run.id);
  if (bindings.length !== 1 || bindings[0]?.role !== "raw-workbook") throw new Error("science-workbook-source-binding-invalid");
  const binding = bindings[0];
  const source = store.getSourceVersionForProject(projectId, binding.sourceId, binding.sourceVersionId);
  const rawSha256 = source?.version.contentSha256;
  if (!source || !rawSha256 || !SHA256_RE.test(rawSha256) || rawSha256 !== binding.contentSha256) throw new Error("science-workbook-source-invalid");
  let workbook: unknown;
  try { workbook = JSON.parse(store.readRunBlob(workbookOutput).toString("utf8")); }
  catch { throw new Error("science-workbook-output-invalid"); }
  verifyScienceWorkbook(workbook, rawSha256);
  if ((workbook as WorkbookEnvelope).rawSha256 !== rawSha256) throw new Error("science-workbook-source-invalid");
  return { run, source, workbook: workbook as WorkbookEnvelope };
}

export function summarizeScienceWorkbook(
  workbook: unknown,
  runId: string,
  source: { id: string; versionId: string; rawSha256: string; mimeType: string | null },
  sheetOrdinal?: number,
): ScienceWorkbookReadback {
  verifyScienceWorkbook(workbook, source.rawSha256);
  const book = workbook as WorkbookEnvelope;
  const selectedSheets = sheetOrdinal === undefined ? book.sheets : book.sheets.filter((sheet) => sheet.ordinal === sheetOrdinal);
  if (sheetOrdinal !== undefined && selectedSheets.length !== 1) throw new Error("science-workbook-sheet-invalid");
  let remaining = MAX_PREVIEW_CELLS;
  const sheets = selectedSheets.map((sheet): ScienceWorkbookSheetPreview => {
    const previewCells = remaining > 0
      ? sheet.cells.slice(0, Math.min(remaining, MAX_PREVIEW_CELLS)).map((cell) => ({
        address: cell.address,
        type: cell.type,
        value: cell.value,
        formula: cell.formula,
        numberFormat: cell.numberFormat,
        warning: cell.warning,
      }))
      : [];
    remaining -= previewCells.length;
    return {
      ordinal: sheet.ordinal,
      name: sheet.name,
      hidden: sheet.hidden,
      range: sheet.range,
      mergeCount: sheet.merges.length,
      merges: sheet.merges.slice(0, MAX_PREVIEW_MERGES),
      cellCount: sheet.cells.length,
      sheetSha256: sheet.sheetSha256,
      previewCells,
    };
  });
  return {
    schema: "agentlas.science-workbook-readback/v1",
    runId,
    source,
    format: book.format,
    parser: book.parser,
    date1904: book.date1904,
    workbookSha256: book.workbookSha256,
    sheets,
  };
}

function persistedWorkbookReadback(store: ScienceStore, projectId: string, runId: string, sheetOrdinal?: number): ScienceWorkbookReadback {
  const { run, source, workbook } = parsePersistedWorkbook(store, projectId, runId);
  return summarizeScienceWorkbook(workbook, run.id, {
    id: source.id,
    versionId: source.version.id,
    rawSha256: workbook.rawSha256,
    mimeType: source.version.mimeType,
  }, sheetOrdinal);
}

export function persistPreparedScienceWorkbook(
  store: ScienceStore,
  selectedPath: string,
  input: ScienceWorkbookImportInput,
  prepared: PreparedScienceWorkbook,
): { source: ScienceSource; run: ScienceResearchRun; workbook: ScienceWorkbookReadback; replayed: boolean } {
  const extension = path.extname(selectedPath).toLowerCase();
  if (extension !== ".xlsx" && extension !== ".xls") throw new Error("science-workbook-format-invalid");
  const title = optionalTitle(input.title, path.basename(selectedPath, extension));
  const imported = store.commitWorkbookIngestion({
    requestId: input.requestId,
    projectId: input.projectId,
    conversationId: input.conversationId,
    originMessageId: input.originMessageId,
    title,
    rawBytes: prepared.rawBytes,
    workbook: prepared.workbook,
    workerSha256: prepared.workerSha256,
    environmentSha256: prepared.environmentSha256,
  });
  const workbook = persistedWorkbookReadback(store, input.projectId, imported.run.id);
  return { source: imported.source, run: imported.run, workbook, replayed: imported.replayed };
}

function assertWorkbookOrigin(store: ScienceStore, projectId: string, conversationId: string, originMessageId: string): void {
  if (!store.getProject(projectId)) throw new Error("science-project-not-found");
  if (!store.getMessageForProject(projectId, conversationId, originMessageId)) throw new Error("science-workbook-origin-not-found");
}

/** Register the Main-owned workbook picker, bounded workbook readback, and recorded sheet projection. */
export function registerScienceWorkbookIntakeHandlers(options: {
  ipcMain: IpcBoundary;
  assertScienceSender: ScienceSenderAssertion;
  assertScienceProjectDocument: ScienceProjectDocumentAssertion;
  scienceStore: () => ScienceStore;
}): void {
  const pickerBusy = new Set<number>();
  options.ipcMain.handle("science:datasets:importWorkbook", async (event, envelope: unknown) => {
    options.assertScienceSender(event, envelope, "science:artifacts");
    const documentId = options.assertScienceProjectDocument(event, envelope);
    const input = inputRecord(envelope);
    const requestId = uuid(input.requestId, "science-request-id-invalid");
    const projectId = uuid(input.projectId, "science-workbook-origin-invalid");
    const conversationId = uuid(input.conversationId, "science-workbook-origin-invalid");
    const originMessageId = uuid(input.originMessageId, "science-workbook-origin-invalid");
    const store = options.scienceStore();
    assertWorkbookOrigin(store, projectId, conversationId, originMessageId);
    const senderId = event.sender.id;
    if (pickerBusy.has(senderId)) throw new Error("science-workbook-picker-busy");
    pickerBusy.add(senderId);
    try {
      const active = await event.sender.executeJavaScriptInIsolatedWorld(1007, [{ code: "navigator.userActivation.isActive === true" }]);
      if (active !== true) throw new Error("science-workbook-user-gesture-required");
      if (options.assertScienceProjectDocument(event, envelope) !== documentId) throw new Error("science-workbook-document-changed");
      const owner = BrowserWindow.fromWebContents(event.sender);
      if (!owner || owner.isDestroyed()) throw new Error("science-owner-window-missing");
      const selected = await dialog.showOpenDialog(owner, {
        title: "Import Excel workbook",
        properties: ["openFile"],
        filters: [{ name: "Excel workbooks", extensions: ["xlsx", "xls"] }],
      });
      if (options.assertScienceProjectDocument(event, envelope) !== documentId) throw new Error("science-workbook-document-changed");
      if (selected.canceled) return { canceled: true as const };
      if (selected.filePaths.length !== 1) throw new Error("science-workbook-selection-invalid");
      const selectedPath = selected.filePaths[0]!;
      const extension = path.extname(selectedPath).toLowerCase();
      if (extension !== ".xlsx" && extension !== ".xls") throw new Error("science-workbook-format-invalid");
      const prepared = await prepareScienceWorkbook(selectedPath);
      if (options.assertScienceProjectDocument(event, envelope) !== documentId) throw new Error("science-workbook-document-changed");
      assertWorkbookOrigin(store, projectId, conversationId, originMessageId);
      const imported = persistPreparedScienceWorkbook(store, selectedPath, {
        requestId,
        projectId,
        conversationId,
        originMessageId,
        title: typeof input.title === "string" ? input.title : undefined,
      }, prepared);
      return { canceled: false as const, ...imported };
    } finally {
      pickerBusy.delete(senderId);
    }
  });

  options.ipcMain.handle("science:datasets:workbook", (event, envelope: unknown) => {
    options.assertScienceSender(event, envelope, "science:artifacts");
    const input = inputRecord(envelope);
    const projectId = uuid(input.projectId, "science-project-id-invalid");
    const runId = uuid(input.runId, "science-workbook-run-invalid");
    const sheetOrdinal = optionalSheetOrdinal(input.sheetOrdinal);
    const store = options.scienceStore();
    if (!store.getProject(projectId)) throw new Error("science-project-not-found");
    return persistedWorkbookReadback(store, projectId, runId, sheetOrdinal);
  });

  options.ipcMain.handle("science:datasets:projectWorkbook", (event, envelope: unknown) => {
    options.assertScienceSender(event, envelope, "science:artifacts");
    const input = inputRecord(envelope);
    const requestId = uuid(input.requestId, "science-request-id-invalid");
    const projectId = uuid(input.projectId, "science-workbook-projection-input-invalid");
    const parentRunId = uuid(input.parentRunId, "science-workbook-projection-input-invalid");
    if (!input.selection || typeof input.selection !== "object" || Array.isArray(input.selection)) throw new Error("science-workbook-selection-invalid");
    const store = options.scienceStore();
    if (!store.getProject(projectId)) throw new Error("science-project-not-found");
    const parent = store.getResearchRunForProject(projectId, parentRunId);
    if (!parent || parent.toolId !== "agentlas.workbook-ingest" || parent.status !== "succeeded") throw new Error("science-workbook-projection-parent-invalid");
    const title = optionalTitle(input.title, `Workbook sheet ${Number((input.selection as { sheetOrdinal?: unknown }).sheetOrdinal ?? 0) + 1}`);
    const result = store.projectWorkbookDatasetTable({
      requestId,
      projectId,
      parentRunId,
      title,
      selection: input.selection as Parameters<ScienceStore["projectWorkbookDatasetTable"]>[0]["selection"],
    });
    return { ...result, parentRunId };
  });
}
