import { createHash } from "node:crypto";
import type { ScienceDatasetCell, ScienceDatasetTablePayload } from "./science-contract";
import { canonicalWorkbookJson, verifyScienceWorkbook } from "./science-workbook";
import { SCIENCE_TABLE_LIMITS } from "./science-table";

export interface ScienceWorkbookTableSelection {
  sheetOrdinal: number;
  firstRow: number;
  lastRow: number;
  columns: Array<{ sourceColumn: string; name: string }>;
}

/** A recorded range/column mapping, never an implicit guess at headers or missing values. */
export function projectScienceWorkbookTable(workbook: unknown, selection: ScienceWorkbookTableSelection): ScienceDatasetTablePayload {
  const book = workbook as { rawSha256: string; sheets: Array<{ cells: Array<{ address: string; value: ScienceDatasetCell; formula: string | null }> }> };
  verifyScienceWorkbook(workbook, book?.rawSha256);
  if (!selection || !Number.isSafeInteger(selection.sheetOrdinal) || selection.sheetOrdinal < 0
    || selection.sheetOrdinal >= book.sheets.length || !Number.isSafeInteger(selection.firstRow)
    || !Number.isSafeInteger(selection.lastRow) || selection.firstRow < 1 || selection.lastRow < selection.firstRow
    || selection.lastRow > 1_048_576 || selection.lastRow - selection.firstRow + 1 > SCIENCE_TABLE_LIMITS.maxRows
    || !Array.isArray(selection.columns) || !selection.columns.length || selection.columns.length > 1000
    || selection.columns.length * (selection.lastRow - selection.firstRow + 1) > 250_000) throw new Error("science-workbook-selection-invalid");
  const names = new Set<string>(), addresses = new Set<string>();
  for (const column of selection.columns) {
    if (!column || typeof column.sourceColumn !== "string" || !/^[A-Z]{1,3}$/.test(column.sourceColumn)
      || typeof column.name !== "string" || !column.name.trim() || column.name !== column.name.normalize("NFC").trim()
      || column.name.length > 240 || /[\u0000-\u001f]/.test(column.name)
      || names.has(column.name.toLowerCase()) || addresses.has(column.sourceColumn)) throw new Error("science-workbook-selection-invalid");
    names.add(column.name.toLowerCase()); addresses.add(column.sourceColumn);
    const columnIndex = [...column.sourceColumn].reduce((n, char) => n * 26 + char.charCodeAt(0) - 64, 0);
    if (columnIndex > 16_384) throw new Error("science-workbook-selection-invalid");
  }
  const cells = new Map(book.sheets[selection.sheetOrdinal].cells.map((cell) => [cell.address, cell]));
  let nullCount = 0, formulaLikeCellCount = 0;
  const matrix: ScienceDatasetCell[][] = [];
  for (let row = selection.firstRow; row <= selection.lastRow; row++) {
    matrix.push(selection.columns.map((column) => {
      const cell = cells.get(`${column.sourceColumn}${row}`), value = cell?.value ?? null;
      if (value === null) nullCount++;
      if (typeof value === "string" && /^[=+@]/.test(value.trimStart())) formulaLikeCellCount++;
      return value;
    }));
  }
  const columns: ScienceDatasetTablePayload["columns"] = selection.columns.map((column, i) => {
    const values = matrix.map((row) => row[i]).filter((v) => v !== null);
    const logicalType = values.length && values.every((v) => typeof v === "number")
      ? values.every((v) => Number.isSafeInteger(v)) ? "integer" : "number"
      : values.length && values.every((v) => typeof v === "boolean") ? "boolean" : "string";
    return { name: column.name, logicalType, nullable: matrix.some((row) => row[i] === null) };
  });
  const rows = matrix.map((row) => Object.fromEntries(columns.map((column, i) => [column.name,
    row[i] !== null && column.logicalType === "string" ? String(row[i]) : row[i]])));
  const core = { schema: "agentlas.science-table/v1" as const, columns, rows,
    profile: { rowCount: rows.length, columnCount: columns.length, nullCount, formulaLikeCellCount } };
  const hash = (v: unknown) => createHash("sha256").update(canonicalWorkbookJson(v)).digest("hex");
  const result: ScienceDatasetTablePayload = { ...core, receipts: {
    parserId: "agentlas.workbook-sheet-projection", parserVersion: "1.0.0", rawSha256: book.rawSha256,
    headerSha256: hash(columns.map((column) => column.name)), rowsSha256: hash(rows), tableSha256: hash(core),
  } };
  if (Buffer.byteLength(canonicalWorkbookJson(result)) > 4 * 1024 * 1024) throw new Error("science-workbook-output-size-limit");
  return result;
}
