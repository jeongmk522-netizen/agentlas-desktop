import { createHash } from "node:crypto";
import type { ScienceDatasetCell } from "../../shared/science-contract";
import { canonicalWorkbookJson, verifyScienceWorkbook } from "../../shared/science-workbook";

/**
 * A workbook is deliberately kept as a grid by the ingestion worker. This module is the
 * bounded, deterministic second step: an LLM may propose this plan after inspecting that grid,
 * but only these typed operations can execute. The raw workbook is never rewritten.
 */
export const SCIENCE_WORKBOOK_NORMALIZATION_SCHEMA = "agentlas.science-workbook-normalization/v1" as const;
export const SCIENCE_WORKBOOK_NORMALIZATION_MAX_PLAN_BYTES = 256 * 1024;
export const SCIENCE_WORKBOOK_NORMALIZATION_MAX_RANGES = 128;
export const SCIENCE_WORKBOOK_NORMALIZATION_MAX_ROWS = 100_000;
export const SCIENCE_WORKBOOK_NORMALIZATION_MAX_COLUMNS = 1_000;
export const SCIENCE_WORKBOOK_NORMALIZATION_MAX_CELLS = 250_000;
export const SCIENCE_WORKBOOK_NORMALIZATION_MAX_OUTPUT_BYTES = 64 * 1024 * 1024;

const SHA256_RE = /^[a-f0-9]{64}$/u;
const COLUMN_RE = /^[A-Z]{1,3}$/u;
const OPERATION_ID_RE = /^[a-z][a-z0-9._-]{0,63}$/u;
const CONTROL_RE = /[\u0000-\u001f\u007f]/u;
const NUMBER_RE = /^[+-]?(?:(?:\d+(?:\.\d*)?)|(?:\.\d+))(?:[eE][+-]?\d+)?$/u;

type WorkbookCellWarning = "formula-cache-missing" | "cell-error" | "unsupported-cell-type" | null;

interface WorkbookCell {
  address: string;
  type: string;
  value: ScienceDatasetCell;
  formula: string | null;
  numberFormat: string | null;
  warning: WorkbookCellWarning;
}

interface WorkbookSheet {
  ordinal: number;
  name: string;
  hidden: number;
  range: string | null;
  merges: string[];
  cells: WorkbookCell[];
  sheetSha256: string;
}

interface ScienceWorkbookEnvelope {
  schema: "agentlas.science-workbook-cells/v1";
  format: "xls" | "xlsx";
  rawSha256: string;
  parser: { id: "styled-exceljs"; version: "0.21.1" };
  date1904: boolean;
  sheets: WorkbookSheet[];
  workbookSha256: string;
}

export type ScienceWorkbookNormalizationLogicalType = "integer" | "number" | "boolean" | "string";

export interface ScienceWorkbookNormalizationSource {
  rawSha256: string;
  workbookSha256: string;
}

export interface ScienceWorkbookNormalizationRange {
  id: string;
  firstRow: number;
  lastRow: number;
}

export interface ScienceWorkbookNormalizationDictionaryEvidence {
  sheetOrdinal: number;
  sourceColumnAddress: string;
  canonicalNameAddress: string;
}

export interface ScienceWorkbookNormalizationDictionaryEntry {
  id: string;
  sourceColumn: string;
  canonicalName: string;
  aliases: readonly string[];
  evidence: ScienceWorkbookNormalizationDictionaryEvidence;
}

export interface ScienceWorkbookNormalizationInferenceEvidence {
  id: string;
  sheetOrdinal: number;
  address: string;
  observedValue: ScienceDatasetCell;
  note: string;
}

export interface ScienceWorkbookNormalizationInference {
  mode: "headerless";
  rationale: string;
  evidence: readonly ScienceWorkbookNormalizationInferenceEvidence[];
}

export type ScienceWorkbookNormalizationColumnOperation =
  | { id: string; kind: "trim-text" }
  | { id: string; kind: "coerce-number"; integer: boolean }
  | { id: string; kind: "coerce-string" };

export interface ScienceWorkbookNormalizationColumn {
  sourceColumn: string;
  outputName: string;
  expectedHeader: string | null;
  logicalType: ScienceWorkbookNormalizationLogicalType;
  nullable: boolean;
  dictionaryId: string | null;
  inferenceEvidenceIds: readonly string[];
  operations: readonly ScienceWorkbookNormalizationColumnOperation[];
}

export type ScienceWorkbookNormalizationRowRule =
  | { id: string; kind: "drop-if-all-selected-empty"; columns: readonly string[] }
  | { id: string; kind: "drop-if-cell-equals"; column: string; value: string | number | boolean };

export interface ScienceWorkbookNormalizationPlan {
  schema: typeof SCIENCE_WORKBOOK_NORMALIZATION_SCHEMA;
  source: ScienceWorkbookNormalizationSource;
  sheetOrdinal: number;
  headerRow: number | null;
  inference: ScienceWorkbookNormalizationInference | null;
  ranges: readonly ScienceWorkbookNormalizationRange[];
  dictionary: readonly ScienceWorkbookNormalizationDictionaryEntry[];
  columns: readonly ScienceWorkbookNormalizationColumn[];
  rowRules: readonly ScienceWorkbookNormalizationRowRule[];
}

export interface ScienceWorkbookNormalizationCellProvenance {
  sourceAddresses: readonly string[];
  operationIds: readonly string[];
  sourceFormula: string | null;
  sourceWarning: WorkbookCellWarning;
}

export interface ScienceWorkbookNormalizationRowProvenance {
  outputRowIndex: number;
  sourceSheetOrdinal: number;
  sourceRow: number;
  rangeId: string;
  cells: Readonly<Record<string, ScienceWorkbookNormalizationCellProvenance>>;
}

export interface ScienceWorkbookNormalizationDroppedRow {
  sourceSheetOrdinal: number;
  sourceRow: number;
  rangeId: string;
  ruleId: string;
  reason: "all-selected-empty" | "cell-equals";
}

export interface ScienceWorkbookNormalizationResult {
  schema: typeof SCIENCE_WORKBOOK_NORMALIZATION_SCHEMA;
  source: ScienceWorkbookNormalizationSource;
  planSha256: string;
  inference: ScienceWorkbookNormalizationInference | null;
  columns: Array<{
    name: string;
    logicalType: ScienceWorkbookNormalizationLogicalType;
    nullable: boolean;
    dictionaryId: string | null;
  }>;
  rows: Array<Record<string, ScienceDatasetCell>>;
  profile: {
    rowCount: number;
    columnCount: number;
    nullCount: number;
    formulaLikeCellCount: number;
    droppedRowCount: number;
  };
  provenance: {
    rows: ScienceWorkbookNormalizationRowProvenance[];
    droppedRows: ScienceWorkbookNormalizationDroppedRow[];
  };
  normalizedSha256: string;
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort((left, right) => left.localeCompare(right));
  const expected = [...keys].sort((left, right) => left.localeCompare(right));
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function fail(code: string): never {
  throw new Error(code);
}

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function assertText(value: unknown, code: string, maximum = 512, allowEmpty = false): string {
  if (typeof value !== "string") fail(code);
  const normalized = value.normalize("NFC");
  if ((!allowEmpty && !normalized.trim()) || normalized.length > maximum || CONTROL_RE.test(normalized)) fail(code);
  return normalized;
}

function assertHash(value: unknown, code: string): string {
  if (typeof value !== "string" || !SHA256_RE.test(value)) fail(code);
  return value;
}

function assertPositiveInteger(value: unknown, code: string, maximum: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > maximum) fail(code);
  return value as number;
}

function assertOrdinal(value: unknown, code: string, maximum: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > maximum) fail(code);
  return value as number;
}

function assertCellValue(value: unknown, code: string): ScienceDatasetCell {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  fail(code);
}

function canonicalPlan(plan: ScienceWorkbookNormalizationPlan): string {
  return canonicalWorkbookJson(plan);
}

export function scienceWorkbookNormalizationPlanSha256(plan: ScienceWorkbookNormalizationPlan): string {
  return sha256(canonicalPlan(plan));
}

function columnNumber(column: string): number {
  let result = 0;
  for (const character of column) result = result * 26 + character.charCodeAt(0) - 64;
  return result;
}

function parseAddress(address: string): { column: string; row: number } {
  const match = /^([A-Z]{1,3})([1-9][0-9]*)$/u.exec(address);
  if (!match || columnNumber(match[1]!) > 16_384) fail("science-workbook-normalization-address-invalid");
  const row = Number(match[2]);
  if (!Number.isSafeInteger(row) || row > 1_048_576) fail("science-workbook-normalization-address-invalid");
  return { column: match[1]!, row };
}

function cellAddress(column: string, row: number): string {
  return `${column}${row}`;
}

function sheetFor(book: ScienceWorkbookEnvelope, ordinal: number, code: string): WorkbookSheet {
  const sheet = book.sheets[ordinal];
  if (!sheet || sheet.ordinal !== ordinal) fail(code);
  return sheet;
}

function cellMap(sheet: WorkbookSheet): Map<string, WorkbookCell> {
  return new Map(sheet.cells.map((cell) => [cell.address, cell]));
}

function cellAt(sheet: WorkbookSheet, cells: Map<string, WorkbookCell>, address: string): WorkbookCell {
  parseAddress(address);
  return cells.get(address) ?? {
    address,
    type: "z",
    value: null,
    formula: null,
    numberFormat: null,
    warning: null,
  };
}

function compareCellValue(left: ScienceDatasetCell, right: ScienceDatasetCell): boolean {
  return left === right;
}

function isEmpty(value: ScienceDatasetCell): boolean {
  return value === null || (typeof value === "string" && value.trim() === "");
}

function ensureNoDuplicate(values: readonly string[], code: string): void {
  if (new Set(values).size !== values.length) fail(code);
}

function validateOperation(value: unknown, logicalType: ScienceWorkbookNormalizationLogicalType, seen: Set<string>): ScienceWorkbookNormalizationColumnOperation {
  const operation = record(value);
  if (!operation || typeof operation.id !== "string" || !OPERATION_ID_RE.test(operation.id) || seen.has(operation.id)) {
    fail("science-workbook-normalization-operation-invalid");
  }
  seen.add(operation.id);
  if (operation.kind === "trim-text") {
    if (!exactKeys(operation, ["id", "kind"])) fail("science-workbook-normalization-operation-invalid");
    return { id: operation.id, kind: "trim-text" };
  }
  if (operation.kind === "coerce-string") {
    if (!exactKeys(operation, ["id", "kind"])) fail("science-workbook-normalization-operation-invalid");
    return { id: operation.id, kind: "coerce-string" };
  }
  if (operation.kind === "coerce-number") {
    if (!exactKeys(operation, ["id", "kind", "integer"]) || typeof operation.integer !== "boolean") {
      fail("science-workbook-normalization-operation-invalid");
    }
    if (logicalType !== "number" && logicalType !== "integer") fail("science-workbook-normalization-operation-type-invalid");
    if (logicalType === "integer" && operation.integer !== true) fail("science-workbook-normalization-operation-type-invalid");
    return { id: operation.id, kind: "coerce-number", integer: operation.integer };
  }
  fail("science-workbook-normalization-operation-invalid");
}

function validatePlanShape(book: ScienceWorkbookEnvelope, value: unknown): ScienceWorkbookNormalizationPlan {
  const plan = record(value);
  if (!plan || !exactKeys(plan, ["schema", "source", "sheetOrdinal", "headerRow", "inference", "ranges", "dictionary", "columns", "rowRules"])) {
    fail("science-workbook-normalization-plan-invalid");
  }
  if (plan.schema !== SCIENCE_WORKBOOK_NORMALIZATION_SCHEMA) fail("science-workbook-normalization-plan-invalid");
  if (Buffer.byteLength(canonicalWorkbookJson(plan), "utf8") > SCIENCE_WORKBOOK_NORMALIZATION_MAX_PLAN_BYTES) {
    fail("science-workbook-normalization-plan-size-limit");
  }

  const source = record(plan.source);
  if (!source || !exactKeys(source, ["rawSha256", "workbookSha256"])) fail("science-workbook-normalization-source-invalid");
  const rawSha256 = assertHash(source.rawSha256, "science-workbook-normalization-raw-hash-invalid");
  const workbookSha256 = assertHash(source.workbookSha256, "science-workbook-normalization-workbook-hash-invalid");
  if (rawSha256 !== book.rawSha256 || workbookSha256 !== book.workbookSha256) fail("science-workbook-normalization-source-mismatch");

  const sheetOrdinal = assertOrdinal(plan.sheetOrdinal, "science-workbook-normalization-sheet-invalid", book.sheets.length - 1);
  const headerRow = plan.headerRow === null
    ? null
    : assertPositiveInteger(plan.headerRow, "science-workbook-normalization-header-invalid", 1_048_576);
  const selectedSheet = sheetFor(book, sheetOrdinal, "science-workbook-normalization-sheet-invalid");
  const selectedCells = cellMap(selectedSheet);

  let inference: ScienceWorkbookNormalizationInference | null = null;
  if (headerRow === null) {
    const rawInference = record(plan.inference);
    if (!rawInference || !exactKeys(rawInference, ["mode", "rationale", "evidence"]) || rawInference.mode !== "headerless") {
      fail("science-workbook-normalization-inference-invalid");
    }
    const rationale = assertText(rawInference.rationale, "science-workbook-normalization-inference-invalid", 4_000);
    if (!Array.isArray(rawInference.evidence) || rawInference.evidence.length < 1 || rawInference.evidence.length > 128) {
      fail("science-workbook-normalization-inference-evidence-invalid");
    }
    const evidenceIds = new Set<string>();
    const evidence = (rawInference.evidence as unknown[]).map((rawEvidence): ScienceWorkbookNormalizationInferenceEvidence => {
      const evidenceRecord = record(rawEvidence);
      if (!evidenceRecord || !exactKeys(evidenceRecord, ["id", "sheetOrdinal", "address", "observedValue", "note"])) {
        fail("science-workbook-normalization-inference-evidence-invalid");
      }
      const id = assertText(evidenceRecord.id, "science-workbook-normalization-inference-evidence-invalid", 120);
      if (!OPERATION_ID_RE.test(id) || evidenceIds.has(id)) fail("science-workbook-normalization-inference-evidence-invalid");
      evidenceIds.add(id);
      const evidenceSheetOrdinal = assertOrdinal(evidenceRecord.sheetOrdinal, "science-workbook-normalization-inference-evidence-invalid", book.sheets.length - 1);
      const evidenceSheet = sheetFor(book, evidenceSheetOrdinal, "science-workbook-normalization-inference-evidence-invalid");
      const evidenceCells = cellMap(evidenceSheet);
      const address = assertText(evidenceRecord.address, "science-workbook-normalization-inference-evidence-invalid", 12);
      parseAddress(address);
      const observedValue = assertCellValue(evidenceRecord.observedValue, "science-workbook-normalization-inference-evidence-invalid");
      const observedCell = cellAt(evidenceSheet, evidenceCells, address);
      if (!evidenceCells.has(address) || !compareCellValue(observedCell.value, observedValue) || observedCell.warning !== null) {
        fail("science-workbook-normalization-inference-evidence-mismatch");
      }
      const note = assertText(evidenceRecord.note, "science-workbook-normalization-inference-evidence-invalid", 512);
      return { id, sheetOrdinal: evidenceSheetOrdinal, address, observedValue, note };
    });
    inference = { mode: "headerless", rationale, evidence };
  } else if (plan.inference !== null) {
    fail("science-workbook-normalization-inference-invalid");
  }

  if (!Array.isArray(plan.ranges) || plan.ranges.length < 1 || plan.ranges.length > SCIENCE_WORKBOOK_NORMALIZATION_MAX_RANGES) {
    fail("science-workbook-normalization-ranges-invalid");
  }
  const rangeIds = new Set<string>();
  const ranges = (plan.ranges as unknown[]).map((value, index): ScienceWorkbookNormalizationRange => {
    const range = record(value);
    if (!range || !exactKeys(range, ["id", "firstRow", "lastRow"])) fail("science-workbook-normalization-range-invalid");
    const id = assertText(range.id, "science-workbook-normalization-range-invalid", 64);
    if (!OPERATION_ID_RE.test(id) || rangeIds.has(id)) fail("science-workbook-normalization-range-invalid");
    rangeIds.add(id);
    const firstRow = assertPositiveInteger(range.firstRow, "science-workbook-normalization-range-invalid", 1_048_576);
    const lastRow = assertPositiveInteger(range.lastRow, "science-workbook-normalization-range-invalid", 1_048_576);
    if (lastRow < firstRow || (headerRow !== null && firstRow <= headerRow && headerRow <= lastRow)) fail("science-workbook-normalization-range-invalid");
    if (index > 0) {
      const prior = record((plan.ranges as unknown[])[index - 1]);
      if (!prior || firstRow <= Number(prior.lastRow)) fail("science-workbook-normalization-range-overlap");
    }
    return { id, firstRow, lastRow };
  });
  const selectedRowCount = ranges.reduce((total, range) => total + range.lastRow - range.firstRow + 1, 0);
  if (selectedRowCount > SCIENCE_WORKBOOK_NORMALIZATION_MAX_ROWS) fail("science-workbook-normalization-row-limit");

  if (!Array.isArray(plan.dictionary) || plan.dictionary.length > SCIENCE_WORKBOOK_NORMALIZATION_MAX_COLUMNS) {
    fail("science-workbook-normalization-dictionary-invalid");
  }
  const dictionaryIds = new Set<string>();
  const dictionaries = (plan.dictionary as unknown[]).map((value): ScienceWorkbookNormalizationDictionaryEntry => {
    const entry = record(value);
    if (!entry || !exactKeys(entry, ["id", "sourceColumn", "canonicalName", "aliases", "evidence"])) {
      fail("science-workbook-normalization-dictionary-invalid");
    }
    const id = assertText(entry.id, "science-workbook-normalization-dictionary-invalid", 120);
    if (!OPERATION_ID_RE.test(id) || dictionaryIds.has(id)) fail("science-workbook-normalization-dictionary-invalid");
    dictionaryIds.add(id);
    const sourceColumn = assertText(entry.sourceColumn, "science-workbook-normalization-dictionary-invalid", 3);
    if (!COLUMN_RE.test(sourceColumn) || columnNumber(sourceColumn) > 16_384) fail("science-workbook-normalization-dictionary-invalid");
    const canonicalName = assertText(entry.canonicalName, "science-workbook-normalization-dictionary-invalid", 240);
    if (!Array.isArray(entry.aliases) || entry.aliases.length < 1 || entry.aliases.length > 32) fail("science-workbook-normalization-dictionary-invalid");
    const aliases = (entry.aliases as unknown[]).map((alias) => assertText(alias, "science-workbook-normalization-dictionary-invalid", 240));
    ensureNoDuplicate(aliases, "science-workbook-normalization-dictionary-invalid");
    if (!aliases.includes(canonicalName)) fail("science-workbook-normalization-dictionary-invalid");
    const evidence = record(entry.evidence);
    if (!evidence || !exactKeys(evidence, ["sheetOrdinal", "sourceColumnAddress", "canonicalNameAddress"])) {
      fail("science-workbook-normalization-dictionary-evidence-invalid");
    }
    const evidenceSheetOrdinal = assertOrdinal(evidence.sheetOrdinal, "science-workbook-normalization-dictionary-evidence-invalid", book.sheets.length - 1);
    const evidenceSheet = sheetFor(book, evidenceSheetOrdinal, "science-workbook-normalization-dictionary-evidence-invalid");
    const evidenceCells = cellMap(evidenceSheet);
    const sourceColumnAddress = assertText(evidence.sourceColumnAddress, "science-workbook-normalization-dictionary-evidence-invalid", 8);
    const canonicalNameAddress = assertText(evidence.canonicalNameAddress, "science-workbook-normalization-dictionary-evidence-invalid", 8);
    const sourceColumnCell = cellAt(evidenceSheet, evidenceCells, sourceColumnAddress);
    const canonicalNameCell = cellAt(evidenceSheet, evidenceCells, canonicalNameAddress);
    if (sourceColumnCell.value !== sourceColumn || canonicalNameCell.value !== canonicalName
      || sourceColumnCell.warning !== null || canonicalNameCell.warning !== null) {
      fail("science-workbook-normalization-dictionary-evidence-mismatch");
    }
    return { id, sourceColumn, canonicalName, aliases, evidence: { sheetOrdinal: evidenceSheetOrdinal, sourceColumnAddress, canonicalNameAddress } };
  });

  if (!Array.isArray(plan.columns) || plan.columns.length < 1 || plan.columns.length > SCIENCE_WORKBOOK_NORMALIZATION_MAX_COLUMNS) {
    fail("science-workbook-normalization-columns-invalid");
  }
  const sourceColumns = new Set<string>();
  const outputNames = new Set<string>();
  const columns = (plan.columns as unknown[]).map((value): ScienceWorkbookNormalizationColumn => {
    const column = record(value);
    if (!column || !exactKeys(column, ["sourceColumn", "outputName", "expectedHeader", "logicalType", "nullable", "dictionaryId", "inferenceEvidenceIds", "operations"])) {
      fail("science-workbook-normalization-column-invalid");
    }
    const sourceColumn = assertText(column.sourceColumn, "science-workbook-normalization-column-invalid", 3);
    if (!COLUMN_RE.test(sourceColumn) || columnNumber(sourceColumn) > 16_384 || sourceColumns.has(sourceColumn)) fail("science-workbook-normalization-column-invalid");
    sourceColumns.add(sourceColumn);
    const outputName = assertText(column.outputName, "science-workbook-normalization-column-invalid", 240);
    const outputKey = outputName.toLocaleLowerCase("en-US");
    if (outputNames.has(outputKey)) fail("science-workbook-normalization-column-duplicate");
    outputNames.add(outputKey);
    const expectedHeader = column.expectedHeader === null
      ? null
      : assertText(column.expectedHeader, "science-workbook-normalization-column-invalid", 240);
    if (headerRow === null ? expectedHeader !== null : expectedHeader === null) {
      fail("science-workbook-normalization-column-header-invalid");
    }
    if (!(["integer", "number", "boolean", "string"] as readonly string[]).includes(String(column.logicalType))) {
      fail("science-workbook-normalization-column-type-invalid");
    }
    const logicalType = column.logicalType as ScienceWorkbookNormalizationLogicalType;
    if (typeof column.nullable !== "boolean") fail("science-workbook-normalization-column-invalid");
    if (column.dictionaryId !== null && typeof column.dictionaryId !== "string") fail("science-workbook-normalization-column-dictionary-invalid");
    const dictionaryId = column.dictionaryId as string | null;
    const dictionaryEntry = dictionaryId === null ? null : dictionaries.find((entry) => entry.id === dictionaryId);
    if (dictionaryId !== null && !dictionaryEntry) fail("science-workbook-normalization-column-dictionary-invalid");
    if (dictionaryEntry && (dictionaryEntry.sourceColumn !== sourceColumn
      || dictionaryEntry.canonicalName !== outputName
      || (expectedHeader !== null && !dictionaryEntry.aliases.includes(expectedHeader)))) {
      fail("science-workbook-normalization-column-dictionary-mismatch");
    }
    if (headerRow !== null) {
      const header = cellAt(selectedSheet, selectedCells, cellAddress(sourceColumn, headerRow));
      if (typeof header.value !== "string" || header.warning !== null || header.value.normalize("NFC").trim() !== expectedHeader) {
        fail("science-workbook-normalization-header-mismatch");
      }
    }
    if (!Array.isArray(column.inferenceEvidenceIds) || column.inferenceEvidenceIds.length > 16) {
      fail("science-workbook-normalization-column-inference-invalid");
    }
    const inferenceEvidenceIds = (column.inferenceEvidenceIds as unknown[]).map((evidenceId) => {
      const id = assertText(evidenceId, "science-workbook-normalization-column-inference-invalid", 120);
      if (!inference || !inference.evidence.some((evidence) => evidence.id === id)) {
        fail("science-workbook-normalization-column-inference-invalid");
      }
      return id;
    });
    if (headerRow === null && inferenceEvidenceIds.length < 1) {
      fail("science-workbook-normalization-column-inference-invalid");
    }
    if (headerRow !== null && inferenceEvidenceIds.length > 0) {
      fail("science-workbook-normalization-column-inference-invalid");
    }
    if (!Array.isArray(column.operations) || column.operations.length > 4) fail("science-workbook-normalization-operations-invalid");
    const operationIds = new Set<string>();
    const operations = (column.operations as unknown[]).map((operation) => validateOperation(operation, logicalType, operationIds));
    if (logicalType === "integer" && !operations.some((operation) => operation.kind === "coerce-number" && operation.integer)) {
      fail("science-workbook-normalization-integer-coercion-required");
    }
    return { sourceColumn, outputName, expectedHeader, logicalType, nullable: column.nullable, dictionaryId, inferenceEvidenceIds, operations };
  });
  const duplicateHeaders = new Map<string, number>();
  columns.forEach((column) => {
    if (column.expectedHeader !== null) duplicateHeaders.set(column.expectedHeader, (duplicateHeaders.get(column.expectedHeader) ?? 0) + 1);
  });
  if (headerRow !== null && [...duplicateHeaders.entries()].some(([header, count]) => count > 1 && columns.filter((column) => column.expectedHeader === header).some((column) => column.dictionaryId === null))) {
    fail("science-workbook-normalization-duplicate-header-unresolved");
  }
  if (selectedRowCount * columns.length > SCIENCE_WORKBOOK_NORMALIZATION_MAX_CELLS) {
    fail("science-workbook-normalization-cell-limit");
  }

  if (!Array.isArray(plan.rowRules) || plan.rowRules.length > 64) fail("science-workbook-normalization-row-rules-invalid");
  const ruleIds = new Set<string>();
  const rowRules = (plan.rowRules as unknown[]).map((value): ScienceWorkbookNormalizationRowRule => {
    const rule = record(value);
    if (!rule || typeof rule.id !== "string" || !OPERATION_ID_RE.test(rule.id) || ruleIds.has(rule.id)) fail("science-workbook-normalization-row-rule-invalid");
    ruleIds.add(rule.id);
    if (rule.kind === "drop-if-all-selected-empty") {
      if (!exactKeys(rule, ["id", "kind", "columns"]) || !Array.isArray(rule.columns) || rule.columns.length < 1 || rule.columns.length > columns.length) {
        fail("science-workbook-normalization-row-rule-invalid");
      }
      const ruleColumns = (rule.columns as unknown[]).map((column) => assertText(column, "science-workbook-normalization-row-rule-invalid", 3));
      ensureNoDuplicate(ruleColumns, "science-workbook-normalization-row-rule-invalid");
      if (ruleColumns.some((column) => !sourceColumns.has(column))) fail("science-workbook-normalization-row-rule-column-invalid");
      return { id: rule.id, kind: "drop-if-all-selected-empty", columns: ruleColumns };
    }
    if (rule.kind === "drop-if-cell-equals") {
      if (!exactKeys(rule, ["id", "kind", "column", "value"])) fail("science-workbook-normalization-row-rule-invalid");
      const column = assertText(rule.column, "science-workbook-normalization-row-rule-invalid", 3);
      if (!sourceColumns.has(column)) fail("science-workbook-normalization-row-rule-column-invalid");
      const valueToMatch = assertCellValue(rule.value, "science-workbook-normalization-row-rule-value-invalid");
      if (valueToMatch === null) fail("science-workbook-normalization-row-rule-value-invalid");
      return { id: rule.id, kind: "drop-if-cell-equals", column, value: valueToMatch };
    }
    fail("science-workbook-normalization-row-rule-invalid");
  });

  return { schema: SCIENCE_WORKBOOK_NORMALIZATION_SCHEMA, source: { rawSha256, workbookSha256 }, sheetOrdinal, headerRow, inference, ranges, dictionary: dictionaries, columns, rowRules };
}

/** Validate both shape and all workbook references before executing an LLM proposal. */
export function validateScienceWorkbookNormalizationPlan(workbook: unknown, plan: unknown): ScienceWorkbookNormalizationPlan {
  const bookRecord = record(workbook);
  if (!bookRecord || typeof bookRecord.rawSha256 !== "string") fail("science-workbook-normalization-workbook-invalid");
  verifyScienceWorkbook(workbook, bookRecord.rawSha256);
  return validatePlanShape(workbook as ScienceWorkbookEnvelope, plan);
}

function applyColumnOperations(raw: ScienceDatasetCell, column: ScienceWorkbookNormalizationColumn): { value: ScienceDatasetCell; operationIds: string[] } {
  let value = raw;
  const operationIds = [`column-map:${column.outputName}`];
  for (const operation of column.operations) {
    if (operation.kind === "trim-text") {
      if (value !== null && typeof value !== "string") fail("science-workbook-normalization-trim-type-invalid");
      if (typeof value === "string") value = value.normalize("NFC").trim();
    } else if (operation.kind === "coerce-string") {
      if (value !== null) value = typeof value === "string" ? value : String(value);
    } else if (operation.kind === "coerce-number") {
      if (value !== null) {
        if (typeof value === "number") {
          if (!Number.isFinite(value)) fail("science-workbook-normalization-number-invalid");
        } else if (typeof value === "string" && NUMBER_RE.test(value.trim())) {
          value = Number(value.trim());
        } else {
          fail("science-workbook-normalization-number-invalid");
        }
        if (typeof value !== "number" || !Number.isFinite(value)) {
          fail("science-workbook-normalization-number-invalid");
        }
        if (Number.isInteger(value) && !Number.isSafeInteger(value)) fail("science-workbook-normalization-number-precision-loss");
        if (operation.integer && !Number.isSafeInteger(value)) fail("science-workbook-normalization-number-invalid");
      }
    }
    operationIds.push(operation.id);
  }
  return { value, operationIds };
}

function assertLogicalType(value: ScienceDatasetCell, column: ScienceWorkbookNormalizationColumn): void {
  if (value === null) {
    if (!column.nullable) fail("science-workbook-normalization-null-not-allowed");
    return;
  }
  if (column.logicalType === "string" && typeof value !== "string") fail("science-workbook-normalization-cell-type-invalid");
  if (column.logicalType === "boolean" && typeof value !== "boolean") fail("science-workbook-normalization-cell-type-invalid");
  if (column.logicalType === "number" && (typeof value !== "number" || !Number.isFinite(value))) fail("science-workbook-normalization-cell-type-invalid");
  if (column.logicalType === "integer" && (typeof value !== "number" || !Number.isSafeInteger(value))) fail("science-workbook-normalization-cell-type-invalid");
}

function formulaLike(value: ScienceDatasetCell): boolean {
  if (typeof value !== "string") return false;
  const trimmed = value.trimStart();
  return /^[=+@]/u.test(trimmed) || /^-(?!\d+(?:\.\d+)?(?:[eE][+-]?\d+)?$)/u.test(trimmed);
}

/** Execute a validated proposal without evaluating expressions or contacting a provider. */
export function normalizeScienceWorkbook(workbook: unknown, plan: unknown): ScienceWorkbookNormalizationResult {
  const validated = validateScienceWorkbookNormalizationPlan(workbook, plan);
  const book = workbook as ScienceWorkbookEnvelope;
  const sourceSheet = sheetFor(book, validated.sheetOrdinal, "science-workbook-normalization-sheet-invalid");
  const sourceCells = cellMap(sourceSheet);
  const rows: Array<Record<string, ScienceDatasetCell>> = [];
  const provenanceRows: ScienceWorkbookNormalizationRowProvenance[] = [];
  const droppedRows: ScienceWorkbookNormalizationDroppedRow[] = [];
  let nullCount = 0;
  let formulaLikeCellCount = 0;

  for (const range of validated.ranges) {
    for (let sourceRow = range.firstRow; sourceRow <= range.lastRow; sourceRow += 1) {
      const rawByColumn = new Map(validated.columns.map((column) => {
        const address = cellAddress(column.sourceColumn, sourceRow);
        return [column.sourceColumn, cellAt(sourceSheet, sourceCells, address)] as const;
      }));
      const matchingRule = validated.rowRules.find((rule) => {
        if (rule.kind === "drop-if-all-selected-empty") return rule.columns.every((column) => isEmpty(rawByColumn.get(column)?.value ?? null));
        return compareCellValue(rawByColumn.get(rule.column)?.value ?? null, rule.value);
      });
      if (matchingRule) {
        droppedRows.push({
          sourceSheetOrdinal: validated.sheetOrdinal,
          sourceRow,
          rangeId: range.id,
          ruleId: matchingRule.id,
          reason: matchingRule.kind === "drop-if-all-selected-empty" ? "all-selected-empty" : "cell-equals",
        });
        continue;
      }

      const outputRow: Record<string, ScienceDatasetCell> = {};
      const rowCells: Record<string, ScienceWorkbookNormalizationCellProvenance> = {};
      for (const column of validated.columns) {
        const sourceCell = rawByColumn.get(column.sourceColumn)!;
        const transformed = applyColumnOperations(sourceCell.value, column);
        assertLogicalType(transformed.value, column);
        outputRow[column.outputName] = transformed.value;
        if (transformed.value === null) nullCount += 1;
        if (formulaLike(transformed.value)) formulaLikeCellCount += 1;
        rowCells[column.outputName] = {
          sourceAddresses: [sourceCell.address],
          operationIds: transformed.operationIds,
          sourceFormula: sourceCell.formula,
          sourceWarning: sourceCell.warning,
        };
      }
      rows.push(outputRow);
      provenanceRows.push({
        outputRowIndex: rows.length - 1,
        sourceSheetOrdinal: validated.sheetOrdinal,
        sourceRow,
        rangeId: range.id,
        cells: rowCells,
      });
    }
  }
  if (rows.length < 1) fail("science-workbook-normalization-no-rows");
  if (rows.length * validated.columns.length > SCIENCE_WORKBOOK_NORMALIZATION_MAX_CELLS) fail("science-workbook-normalization-cell-limit");

  const core = {
    schema: SCIENCE_WORKBOOK_NORMALIZATION_SCHEMA,
    source: validated.source,
    planSha256: scienceWorkbookNormalizationPlanSha256(validated),
    inference: validated.inference,
    columns: validated.columns.map((column) => ({
      name: column.outputName,
      logicalType: column.logicalType,
      nullable: column.nullable,
      dictionaryId: column.dictionaryId,
    })),
    rows,
    profile: {
      rowCount: rows.length,
      columnCount: validated.columns.length,
      nullCount,
      formulaLikeCellCount,
      droppedRowCount: droppedRows.length,
    },
    provenance: { rows: provenanceRows, droppedRows },
  };
  const normalizedSha256 = sha256(canonicalWorkbookJson(core));
  const result: ScienceWorkbookNormalizationResult = { ...core, normalizedSha256 };
  if (Buffer.byteLength(canonicalWorkbookJson(result), "utf8") > SCIENCE_WORKBOOK_NORMALIZATION_MAX_OUTPUT_BYTES) {
    fail("science-workbook-normalization-output-size-limit");
  }
  return result;
}
