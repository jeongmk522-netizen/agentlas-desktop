import { createHash } from "node:crypto";

export function canonicalWorkbookJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalWorkbookJson).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([k, v]) => `${JSON.stringify(k)}:${canonicalWorkbookJson(v)}`).join(",")}}`;
  return JSON.stringify(value);
}

/** Verify the worker envelope before it can become a persisted research input. */
export function verifyScienceWorkbook(value: unknown, rawSha256: string): void {
  const fail = (): never => { throw new Error("science-workbook-output-invalid"); };
  const record = (v: unknown): Record<string, unknown> => v && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : fail();
  const exact = (v: Record<string, unknown>, keys: string[]) => {
    if (Object.keys(v).length !== keys.length || keys.some((key) => !Object.hasOwn(v, key))) fail();
  };
  const hash = (v: unknown) => createHash("sha256").update(canonicalWorkbookJson(v)).digest("hex");
  const book = record(value);
  exact(book, ["schema", "format", "rawSha256", "parser", "date1904", "sheets", "workbookSha256"]);
  if (book.schema !== "agentlas.science-workbook-cells/v1" || !["xls", "xlsx"].includes(String(book.format))
    || !/^[a-f0-9]{64}$/.test(rawSha256) || book.rawSha256 !== rawSha256 || typeof book.date1904 !== "boolean") fail();
  const parser = record(book.parser);
  exact(parser, ["id", "version"]);
  if (parser.id !== "styled-exceljs" || parser.version !== "0.21.1") fail();
  if (!Array.isArray(book.sheets) || !book.sheets.length || book.sheets.length > 100) fail();
  let count = 0;
  const names = new Set<string>();
  for (const [ordinal, candidate] of (book.sheets as unknown[]).entries()) {
    const sheet = record(candidate);
    exact(sheet, ["ordinal", "name", "hidden", "range", "merges", "cells", "sheetSha256"]);
    if (sheet.ordinal !== ordinal || typeof sheet.name !== "string" || !sheet.name
      || names.has(sheet.name) || ![0, 1, 2].includes(Number(sheet.hidden)) || typeof sheet.hidden !== "number"
      || (sheet.range !== null && typeof sheet.range !== "string") || !Array.isArray(sheet.merges)
      || sheet.merges.some((v) => typeof v !== "string") || !Array.isArray(sheet.cells)) fail();
    names.add(sheet.name as string);
    const addresses = new Set<string>();
    for (const candidateCell of sheet.cells as unknown[]) {
      if (++count > 250_000) fail();
      const cell = record(candidateCell);
      exact(cell, ["address", "type", "value", "formula", "numberFormat", "warning"]);
      if (typeof cell.address !== "string" || !/^[A-Z]+[1-9][0-9]*$/.test(cell.address) || addresses.has(cell.address)
        || typeof cell.type !== "string" || (cell.formula !== null && typeof cell.formula !== "string")
        || (cell.numberFormat !== null && typeof cell.numberFormat !== "string")
        || ![null, "formula-cache-missing", "cell-error", "unsupported-cell-type"].includes(cell.warning as null | string)
        || (cell.value !== null && typeof cell.value !== "string" && typeof cell.value !== "boolean"
          && (typeof cell.value !== "number" || !Number.isFinite(cell.value)))) fail();
      addresses.add(cell.address as string);
      if (cell.warning !== null && cell.value !== null) fail();
    }
    const { sheetSha256, ...grid } = sheet;
    if (sheetSha256 !== hash(grid)) fail();
  }
  const { workbookSha256, ...core } = book;
  if (workbookSha256 !== hash(core)) fail();
}
