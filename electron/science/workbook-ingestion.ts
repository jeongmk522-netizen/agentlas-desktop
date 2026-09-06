import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import type { workbookToCells } from "./workers/workbook-to-cells";
import { verifyScienceWorkbook } from "../../shared/science-workbook";

type Workbook = ReturnType<typeof workbookToCells>;
const MAX_RAW = 8 * 1024 * 1024;
const MAX_OUTPUT = 4 * 1024 * 1024;
function hash(bytes: Buffer): string { return createHash("sha256").update(bytes).digest("hex"); }

/** Main-owned file capability only. The renderer must never supply an unchecked path. */
export async function prepareScienceWorkbook(
  filePath: string,
  workerPath = path.join(__dirname, "workers", "workbook-to-cells.js"),
): Promise<{ rawBytes: Buffer; outputBytes: Buffer; workbook: Workbook; workerSha256: string; outputSha256: string }> {
  const fd = fs.openSync(filePath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
  let rawBytes: Buffer;
  try {
    const before = fs.fstatSync(fd);
    if (!before.isFile() || before.size < 8 || before.size > MAX_RAW) throw new Error("science-workbook-raw-size-invalid");
    rawBytes = Buffer.alloc(before.size);
    let offset = 0;
    while (offset < rawBytes.length) {
      const read = fs.readSync(fd, rawBytes, offset, rawBytes.length - offset, null);
      if (!read) break;
      offset += read;
    }
    const after = fs.fstatSync(fd);
    if (offset !== before.size || before.dev !== after.dev || before.ino !== after.ino
      || before.size !== after.size || before.mtimeMs !== after.mtimeMs) throw new Error("science-workbook-file-changed");
  } finally { fs.closeSync(fd); }
  const workerStat = fs.lstatSync(workerPath);
  if (!workerStat.isFile() || workerStat.isSymbolicLink()) throw new Error("science-workbook-worker-invalid");
  const workerSha256 = hash(fs.readFileSync(workerPath));
  const job = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "agentlas-workbook-")));
  if (process.platform !== "win32") fs.chmodSync(job, 0o700);
  try {
    const input = path.join(job, "input.workbook"), output = path.join(job, "output.json");
    fs.writeFileSync(input, rawBytes, { flag: "wx", mode: 0o600 });
    await new Promise<void>((resolve, reject) => {
      const child = spawn(process.execPath, ["--max-old-space-size=256", workerPath, input, output], {
        cwd: job, stdio: ["ignore", "ignore", "pipe"], windowsHide: true,
        env: { ELECTRON_RUN_AS_NODE: "1", LANG: "C.UTF-8", TMPDIR: job },
      });
      let stderr = "";
      child.stderr.on("data", (chunk) => { stderr += String(chunk).slice(0, Math.max(0, 1024 - stderr.length)); });
      const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error("science-workbook-worker-timeout")); }, 30_000);
      child.once("error", () => { clearTimeout(timer); reject(new Error("science-workbook-worker-spawn-failed")); });
      child.once("exit", (code) => {
        clearTimeout(timer);
        if (code === 0) resolve();
        else reject(new Error(/^science-workbook-[a-z-]+$/.test(stderr.trim()) ? stderr.trim() : "science-workbook-worker-failed"));
      });
    });
    const stat = fs.lstatSync(output);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 2 || stat.size > MAX_OUTPUT) throw new Error("science-workbook-output-size-limit");
    const outputBytes = fs.readFileSync(output);
    let workbook: Workbook;
    try { workbook = JSON.parse(outputBytes.toString("utf8")) as Workbook; }
    catch { throw new Error("science-workbook-output-invalid"); }
    verifyScienceWorkbook(workbook, hash(rawBytes));
    return { rawBytes, outputBytes, workbook, workerSha256, outputSha256: hash(outputBytes) };
  } finally { fs.rmSync(job, { recursive: true, force: true }); }
}
