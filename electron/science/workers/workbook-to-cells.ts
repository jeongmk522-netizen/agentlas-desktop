import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import * as XLSX from "styled-exceljs";
import { SCIENCE_WORKBOOK_MAX_OUTPUT_BYTES } from "../../../shared/science-workbook";

const LIMITS = { rawBytes: 8 * 1024 * 1024, outputBytes: SCIENCE_WORKBOOK_MAX_OUTPUT_BYTES, sheets: 100, cells: 250_000 };
type CellValue = string | number | boolean | null;
export interface WorkbookCell {
  address: string;
  type: string;
  value: CellValue;
  formula: string | null;
  numberFormat: string | null;
  warning: "formula-cache-missing" | "cell-error" | "unsupported-cell-type" | null;
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
  return JSON.stringify(value);
}
function hash(value: Buffer | string): string { return createHash("sha256").update(value).digest("hex"); }

/** Preserve the worksheet grid; header inference and cleaning belong to a later, recorded run. */
export function workbookToCells(bytes: Buffer) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 8 || bytes.length > LIMITS.rawBytes) throw new Error("science-workbook-raw-size-invalid");
  const format = bytes.subarray(0, 8).equals(Buffer.from("d0cf11e0a1b11ae1", "hex")) ? "xls"
    : bytes.subarray(0, 4).equals(Buffer.from("504b0304", "hex")) ? "xlsx" : null;
  if (!format) throw new Error("science-workbook-format-invalid");
  const book = XLSX.read(bytes, { type: "buffer", cellFormula: true, cellNF: true, cellDates: false, sheetStubs: true, bookVBA: false });
  if (!book.SheetNames.length || book.SheetNames.length > LIMITS.sheets) throw new Error("science-workbook-sheet-limit");
  let cellCount = 0;
  const sheets = book.SheetNames.map((name, ordinal) => {
    const sheet = book.Sheets[name];
    if (!sheet) throw new Error("science-workbook-sheet-missing");
    const addresses = Object.keys(sheet).filter((key) => /^[A-Z]+[1-9][0-9]*$/.test(key));
    cellCount += addresses.length;
    if (cellCount > LIMITS.cells) throw new Error("science-workbook-cell-limit");
    addresses.sort((a, b) => { const x = XLSX.utils.decode_cell(a), y = XLSX.utils.decode_cell(b); return x.r - y.r || x.c - y.c; });
    const cells: WorkbookCell[] = addresses.map((address) => {
      const cell = sheet[address] as XLSX.CellObject;
      const formula = typeof cell.f === "string" ? cell.f : null;
      let value: CellValue = null;
      let warning: WorkbookCell["warning"] = null;
      if (cell.t === "n" && typeof cell.v === "number" && Number.isFinite(cell.v)) value = cell.v;
      else if (cell.t === "b" && typeof cell.v === "boolean") value = cell.v;
      else if (cell.t === "s" && typeof cell.v === "string") value = cell.v;
      else if (cell.t === "e") warning = "cell-error";
      else if (cell.t !== "z" && cell.v != null) warning = "unsupported-cell-type";
      // OOXML missing caches can be represented as a stub with v=0; BIFF as an empty string.
      if (formula && (cell.t === "z" || cell.v == null || value === "")) {
        value = null;
        warning = "formula-cache-missing";
      }
      return { address, type: cell.t, value, formula, numberFormat: typeof cell.z === "string" ? cell.z : null, warning };
    });
    const grid = {
      ordinal, name, hidden: book.Workbook?.Sheets?.[ordinal]?.Hidden ?? 0,
      range: typeof sheet["!ref"] === "string" ? sheet["!ref"] : null,
      merges: (sheet["!merges"] ?? []).map((range) => XLSX.utils.encode_range(range)), cells,
    };
    return { ...grid, sheetSha256: hash(canonical(grid)) };
  });
  const core = {
    schema: "agentlas.science-workbook-cells/v1", format, rawSha256: hash(bytes),
    parser: { id: "styled-exceljs", version: "0.21.1" },
    date1904: Boolean(book.Workbook?.WBProps?.date1904), sheets,
  };
  const result = { ...core, workbookSha256: hash(canonical(core)) };
  if (Buffer.byteLength(canonical(result)) > LIMITS.outputBytes) throw new Error("science-workbook-output-size-limit");
  return result;
}

if (require.main === module) {
  try {
    const [input, output] = process.argv.slice(2);
    if (!input || !output || path.dirname(input) !== process.cwd() || path.dirname(output) !== process.cwd()
      || path.basename(input) !== "input.workbook" || path.basename(output) !== "output.json") throw new Error("science-workbook-worker-path-invalid");
    const stat = fs.lstatSync(input);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > LIMITS.rawBytes) throw new Error("science-workbook-input-invalid");
    fs.writeFileSync(output, canonical(workbookToCells(fs.readFileSync(input))), { flag: "wx", mode: 0o600 });
  } catch (error) {
    const code = error instanceof Error && /^science-workbook-[a-z-]+$/.test(error.message) ? error.message : "science-workbook-parse-failed";
    process.stderr.write(`${code}\n`);
    process.exitCode = 1;
  }
}
