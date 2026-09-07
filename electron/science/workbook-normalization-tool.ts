import { createHash } from "node:crypto";
import type { ScienceStore } from "./store";
import type { ScienceResearchRun, ScienceResearchRunResourceInput } from "../../shared/science-contract";
import {
  readPersistedScienceWorkbook,
} from "./workbook-intake-ipc";
import {
  normalizeScienceWorkbook,
  scienceWorkbookNormalizationPlanSha256,
  validateScienceWorkbookNormalizationPlan,
  type ScienceWorkbookNormalizationResult,
} from "./workbook-normalization";
import { canonicalWorkbookJson } from "../../shared/science-workbook";
import { scienceWorkbookNormalizationTable } from "../../shared/science-table";
import type { MaterializeScienceDatasetTableResult } from "../../shared/science-contract";

const MAX_NORMALIZED_PAGE_BYTES = 256 * 1024;

export const SCIENCE_WORKBOOK_NORMALIZATION_TOOL_ID = "agentlas.workbook-normalize" as const;
export const SCIENCE_WORKBOOK_NORMALIZATION_TOOL_VERSION = "1.0.0" as const;
export const SCIENCE_WORKBOOK_NORMALIZATION_PLAN_MIME = "application/vnd.agentlas.science.workbook-normalization-plan+json" as const;
export const SCIENCE_WORKBOOK_NORMALIZATION_OUTPUT_MIME = "application/vnd.agentlas.science.workbook-normalization+json" as const;
export const SCIENCE_WORKBOOK_NORMALIZATION_TABLE_MIME = "application/vnd.agentlas.science.table+json" as const;

type NormalizationRun = Pick<ScienceResearchRun, "id" | "status" | "toolId" | "toolVersion" | "parentRunId" | "outputs" | "inputManifestSha256" | "outputManifestSha256">;

export interface ScienceArtifactSummary {
  id: string;
  kind: string;
  title: string;
  version: number;
  currentVersion: number;
  contentSha256: string;
}

export function scienceArtifactSummary(artifact: MaterializeScienceDatasetTableResult["artifact"]): ScienceArtifactSummary {
  return {
    id: artifact.id,
    kind: artifact.kind,
    title: artifact.title,
    version: artifact.version.version,
    currentVersion: artifact.currentVersion,
    contentSha256: artifact.version.contentSha256,
  };
}

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function record(value: unknown, code: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(code);
  return value as Record<string, unknown>;
}

function resource(role: string, mimeType: string, receipt: { blobRef: string; sha256: string; byteSize: number }): ScienceResearchRunResourceInput {
  return { role, mimeType, ...receipt, artifactId: null, artifactVersion: null };
}

function canonicalResources(resources: readonly ScienceResearchRunResourceInput[]): string {
  return canonicalWorkbookJson(resources);
}

function normalizedResultFromBlob(store: ScienceStore, run: NormalizationRun): ScienceWorkbookNormalizationResult {
  if (run.status !== "succeeded" || run.toolId !== SCIENCE_WORKBOOK_NORMALIZATION_TOOL_ID
    || run.toolVersion !== SCIENCE_WORKBOOK_NORMALIZATION_TOOL_VERSION || run.outputs.length !== 2) {
    throw new Error("science-workbook-normalization-run-invalid");
  }
  const output = run.outputs[0]!;
  const tableOutput = run.outputs[1];
  if (output.role !== "normalized-workbook" || output.mimeType !== SCIENCE_WORKBOOK_NORMALIZATION_OUTPUT_MIME
    || output.artifactId !== null || output.artifactVersion !== null
    || !tableOutput || tableOutput.role !== "normalized-table" || tableOutput.mimeType !== SCIENCE_WORKBOOK_NORMALIZATION_TABLE_MIME
    || tableOutput.artifactId !== null || tableOutput.artifactVersion !== null) {
    throw new Error("science-workbook-normalization-output-invalid");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(store.readRunBlob(output).toString("utf8"));
  } catch {
    throw new Error("science-workbook-normalization-output-invalid");
  }
  const outputRecord = record(parsed, "science-workbook-normalization-output-invalid");
  if (outputRecord.schema !== "agentlas.science-workbook-normalization/v1"
    || typeof outputRecord.normalizedSha256 !== "string") {
    throw new Error("science-workbook-normalization-output-invalid");
  }
  return parsed as ScienceWorkbookNormalizationResult;
}

function assertStoredResultMatches(
  stored: ScienceWorkbookNormalizationResult,
  expected: ScienceWorkbookNormalizationResult,
): void {
  if (canonicalWorkbookJson(stored) !== canonicalWorkbookJson(expected)
    || stored.normalizedSha256 !== expected.normalizedSha256) {
    throw new Error("science-workbook-normalization-replay-integrity-failed");
  }
}

export interface NormalizePersistedScienceWorkbookInput {
  createRequestId: string;
  completeRequestId: string;
  materializeRequestId: string;
  projectId: string;
  conversationId: string;
  originMessageId: string;
  parentRunId: string;
  plan: unknown;
  title: string;
  environmentSha256: string;
}

export interface NormalizePersistedScienceWorkbookResult {
  run: ScienceResearchRun;
  parentRunId: string;
  source: {
    id: string;
    versionId: string;
    rawSha256: string;
    mimeType: string | null;
  };
  planSha256: string;
  result: ScienceWorkbookNormalizationResult;
  artifact: MaterializeScienceDatasetTableResult["artifact"];
  replayed: boolean;
}

export interface ScienceWorkbookNormalizationPage {
  run: ScienceResearchRun;
  parentRunId: string;
  source: ScienceWorkbookNormalizationResult["source"];
  planSha256: string;
  normalizedSha256: string;
  artifact: ScienceArtifactSummary;
  columns: ScienceWorkbookNormalizationResult["columns"];
  profile: ScienceWorkbookNormalizationResult["profile"];
  page: {
    startRow: number;
    rowCount: number;
    rows: Array<Record<string, string | number | boolean | null>>;
    provenance: ScienceWorkbookNormalizationResult["provenance"]["rows"];
    truncated: boolean;
    next: { startRow: number; rowCount: number } | null;
  };
}

/**
 * Read one immutable workbook-ingestion run, execute a validated model proposal, and persist the
 * deterministic result as a child ResearchRun. No file path, provider call, or arbitrary code is
 * accepted here; the parent run and its exact source binding are the only input authority.
 */
export function normalizePersistedScienceWorkbook(
  store: ScienceStore,
  input: NormalizePersistedScienceWorkbookInput,
): NormalizePersistedScienceWorkbookResult {
  const persisted = readPersistedScienceWorkbook(store, input.projectId, input.parentRunId);
  const plan = validateScienceWorkbookNormalizationPlan(persisted.workbook, input.plan);
  const result = normalizeScienceWorkbook(persisted.workbook, plan);
  const planBytes = Buffer.from(canonicalWorkbookJson(plan), "utf8");
  const resultBytes = Buffer.from(canonicalWorkbookJson(result), "utf8");
  const planReceipt = store.putRunBlob(planBytes);
  const resultReceipt = store.putRunBlob(resultBytes);
  const table = scienceWorkbookNormalizationTable({
    source: { rawSha256: result.source.rawSha256 },
    columns: result.columns,
    rows: result.rows,
    profile: result.profile,
  });
  const tableBytes = Buffer.from(canonicalWorkbookJson(table), "utf8");
  const tableReceipt = store.putRunBlob(tableBytes);
  const planInput = resource("workbook-normalization-plan", SCIENCE_WORKBOOK_NORMALIZATION_PLAN_MIME, planReceipt);
  const normalizedOutput = resource("normalized-workbook", SCIENCE_WORKBOOK_NORMALIZATION_OUTPUT_MIME, resultReceipt);
  const tableOutput = resource("normalized-table", SCIENCE_WORKBOOK_NORMALIZATION_TABLE_MIME, tableReceipt);
  const inputManifestSha256 = sha256(canonicalResources([planInput]));
  const outputManifestSha256 = sha256(canonicalResources([normalizedOutput, tableOutput]));
  const created = store.createResearchRun({
    requestId: input.createRequestId,
    projectId: input.projectId,
    conversationId: input.conversationId,
    originMessageId: input.originMessageId,
    parentRunId: input.parentRunId,
    toolId: SCIENCE_WORKBOOK_NORMALIZATION_TOOL_ID,
    toolVersion: SCIENCE_WORKBOOK_NORMALIZATION_TOOL_VERSION,
    runtime: "native-sidecar",
    inputManifestSha256,
    environmentSha256: input.environmentSha256,
    inputs: [planInput],
  });

  if (created.run.status === "succeeded") {
    const stored = normalizedResultFromBlob(store, created.run);
    assertStoredResultMatches(stored, result);
    const artifact = store.materializeDatasetTable({ requestId: input.materializeRequestId, projectId: input.projectId, runId: created.run.id, title: input.title }).artifact;
    return {
      run: created.run,
      parentRunId: input.parentRunId,
      source: {
        id: persisted.source.id,
        versionId: persisted.source.version.id,
        rawSha256: persisted.workbook.rawSha256,
        mimeType: persisted.source.version.mimeType,
      },
      planSha256: scienceWorkbookNormalizationPlanSha256(plan),
      result: stored,
      artifact,
      replayed: true,
    };
  }
  if (created.run.status !== "running") throw new Error("science-workbook-normalization-replay-terminal");

  const completed = store.completeResearchRun({
    requestId: input.completeRequestId,
    projectId: input.projectId,
    runId: created.run.id,
    status: "succeeded",
    outputManifestSha256,
    summary: `${input.title}: ${result.profile.rowCount} normalized row(s), ${result.profile.columnCount} typed column(s), ${result.profile.droppedRowCount} dropped row(s).`,
    outputs: [normalizedOutput, tableOutput],
  });
  const stored = normalizedResultFromBlob(store, completed.run);
  assertStoredResultMatches(stored, result);
  const artifact = store.materializeDatasetTable({ requestId: input.materializeRequestId, projectId: input.projectId, runId: completed.run.id, title: input.title }).artifact;
  return {
    run: completed.run,
    parentRunId: input.parentRunId,
    source: {
      id: persisted.source.id,
      versionId: persisted.source.version.id,
      rawSha256: persisted.workbook.rawSha256,
      mimeType: persisted.source.version.mimeType,
    },
    planSha256: scienceWorkbookNormalizationPlanSha256(plan),
    result: stored,
    artifact,
    replayed: created.replayed || completed.replayed,
  };
}

/** Read a bounded page from a persisted normalization run without returning the full CAS blob. */
export function readPersistedScienceWorkbookNormalizationPage(
  store: ScienceStore,
  projectId: string,
  runId: string,
  startRow: number,
  rowCount: number,
): ScienceWorkbookNormalizationPage {
  if (!Number.isSafeInteger(startRow) || startRow < 0 || !Number.isSafeInteger(rowCount) || rowCount < 1 || rowCount > 256) {
    throw new Error("science-workbook-normalization-page-invalid");
  }
  const run = store.getResearchRunForProject(projectId, runId);
  if (!run || run.status !== "succeeded" || run.toolId !== SCIENCE_WORKBOOK_NORMALIZATION_TOOL_ID
    || run.toolVersion !== SCIENCE_WORKBOOK_NORMALIZATION_TOOL_VERSION || !run.parentRunId) {
    throw new Error("science-workbook-normalization-run-invalid");
  }
  const result = normalizedResultFromBlob(store, run);
  if (!Array.isArray(result.rows) || !Array.isArray(result.provenance?.rows)
    || result.rows.length !== result.provenance.rows.length || startRow >= result.rows.length) {
    throw new Error("science-workbook-normalization-output-invalid");
  }
  const artifact = store.getArtifactForSourceRun(projectId, run.id, "data-table");
  if (!artifact) throw new Error("science-workbook-normalization-artifact-missing");
  const base = {
    run,
    parentRunId: run.parentRunId,
    source: result.source,
    planSha256: result.planSha256,
    normalizedSha256: result.normalizedSha256,
    artifact: scienceArtifactSummary(artifact),
    columns: result.columns,
    profile: result.profile,
  };
  const available = result.rows.length - startRow;
  let included = Math.min(rowCount, available);
  const outputBytes = (count: number, truncated: boolean): number => Buffer.byteLength(JSON.stringify({
    ...base,
    page: {
      startRow,
      rowCount: count,
      rows: result.rows.slice(startRow, startRow + count),
      provenance: result.provenance.rows.slice(startRow, startRow + count),
      truncated,
      next: truncated ? { startRow: startRow + count, rowCount: Math.min(256, available - count) } : null,
    },
  }), "utf8");
  while (included > 0 && outputBytes(included, included < available) > MAX_NORMALIZED_PAGE_BYTES) included = Math.floor(included / 2);
  if (included < 1 || outputBytes(included, included < available) > MAX_NORMALIZED_PAGE_BYTES) {
    throw new Error("science-workbook-normalization-page-size-limit");
  }
  const truncated = included < available;
  return {
    ...base,
    page: {
      startRow,
      rowCount: included,
      rows: result.rows.slice(startRow, startRow + included),
      provenance: result.provenance.rows.slice(startRow, startRow + included),
      truncated,
      next: truncated ? { startRow: startRow + included, rowCount: Math.min(256, available - included) } : null,
    },
  };
}
