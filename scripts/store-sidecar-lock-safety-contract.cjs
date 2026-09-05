#!/usr/bin/env node
/*
 * store-sidecar-lock-safety-contract — the live store's -shm must survive a peer.
 *
 * Background (2026-09-05): crash reports 2026-08-28 ×4, 08-29, 08-30, 09-01, 09-04
 * all died in walIndexAppend/walFindFrame with EXC_BAD_ACCESS/SIGBUS
 * "FS pagein error". Root cause: `scrubLegacyOpenCrabCredentialUrls()` byte-scanned
 * the live store and its -wal/-shm with fs.openSync/closeSync *in-process*. On
 * POSIX, closing any descriptor a process holds on a file drops every fcntl lock
 * that process holds on it — including SQLite's shared dead-man-switch lock on
 * -shm. The next peer connection then believed it was alone, reset/unlinked the
 * wal-index this process still had mapped, and the next wal-index touch was a
 * bus error.
 *
 * Contract (calls the real decision, not source text):
 *   1. Self-check — on this platform, an in-process foreign open/close of -shm
 *      followed by a peer close really does make the sidecar disappear. If the
 *      hazard cannot be shown the gate says so instead of passing blind.
 *   2. Product — after initStore() + scrubLegacyOpenCrabCredentialUrls(), a peer
 *      open/close leaves the live store's -shm in place and this process can
 *      still write and read through the WAL.
 *
 * Run: npx electron scripts/store-sidecar-lock-safety-contract.cjs
 */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

process.env.AGENTLAS_E2E = "1";
const { app } = require("electron");
app.disableHardwareAcceleration();

const ROOT = path.resolve(__dirname, "..");
const BETTER_SQLITE = path.join(ROOT, "node_modules", "better-sqlite3");
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentlas-sidecar-lock-"));
process.env.AGENTLAS_STORE_PATH = path.join(tempDir, "agentlas.sqlite");
app.setPath("userData", path.join(tempDir, "user-data"));

// SQLite's unix VFS keeps two fcntl locks alive for the life of a WAL connection:
//   • a shared read lock on the dead-man-switch byte of -shm (UNIX_SHM_DMS = 128)
//   • a shared read lock on the SHARED range of the main file (0x40000002, 510 bytes)
// A peer that can take an exclusive lock on either byte range believes it is
// alone: on -shm it resets the wal-index this process has mapped (SIGBUS), on
// the main file it deletes -wal/-shm on close. Probe from a child process —
// probing from *this* process would itself drop the locks it is measuring.
const PROBE = `
import fcntl, os, sys
path, off, ln = sys.argv[1], int(sys.argv[2]), int(sys.argv[3])
fd = os.open(path, os.O_RDWR)
try:
    fcntl.lockf(fd, fcntl.LOCK_EX | fcntl.LOCK_NB, ln, off, 0)
    print("free")
except OSError:
    print("held")
`;
function lockState(file, offset, length) {
  const result = spawnSync("python3", ["-c", PROBE, file, String(offset), String(length)], { encoding: "utf8" });
  if (result.status !== 0) throw new Error(`lock probe failed: ${result.stderr}`);
  return result.stdout.trim();
}
const dmsLock = (file) => lockState(`${file}-shm`, 128, 1);
const sharedLock = (file) => lockState(file, 0x40000002, 510);

(async () => {
  let exitCode = 0;
  try {
    if (process.platform === "win32") {
      console.log("skip: Windows locks are per-handle; the POSIX fcntl hazard does not apply");
    } else {
      // ── 1. Self-check: the probes see the hazard the product used to commit ──
      const Database = require(BETTER_SQLITE);
      const hazardFile = path.join(tempDir, "hazard.sqlite");
      const hazard = new Database(hazardFile);
      hazard.pragma("journal_mode = WAL");
      hazard.exec("CREATE TABLE t(v)");
      hazard.prepare("INSERT INTO t VALUES (?)").run("x");
      assert.equal(dmsLock(hazardFile), "held", "self-check: a live WAL connection holds the -shm dead-man lock");
      assert.equal(sharedLock(hazardFile), "held", "self-check: a live WAL connection holds the main-file SHARED lock");
      fs.closeSync(fs.openSync(`${hazardFile}-shm`, "r"));   // the old fault, on -shm
      assert.equal(dmsLock(hazardFile), "free", "self-check: an in-process foreign open/close of -shm must drop the dead-man lock (hazard must be demonstrable)");
      fs.closeSync(fs.openSync(hazardFile, "r"));             // the old fault, on the main file
      assert.equal(sharedLock(hazardFile), "free", "self-check: an in-process foreign open/close of the main file must drop the SHARED lock");
      hazard.close();
      console.log("ok   self-check: foreign in-process open/close drops SQLite's fcntl locks; the probes see it");

      // ── 2. Product: the live store keeps both locks through startup + scrub ──
      const { initStore, getDb } = require("../dist/electron/store/db.js");
      const { scrubLegacyOpenCrabCredentialUrls } = require("../dist/electron/mcp-tools/registry.js");
      initStore();
      const db = getDb();
      const storeFile = db.name;
      assert.equal(fs.existsSync(`${storeFile}-shm`), true, "live store runs in WAL with a mapped -shm");
      assert.deepEqual(scrubLegacyOpenCrabCredentialUrls(), { scrubbed: 0 });
      assert.equal(dmsLock(storeFile), "held",
        "after initStore + the startup credential scrub, the -shm dead-man lock must still be held — a free lock is the SIGBUS precondition (peer resets the mapped wal-index)");
      assert.equal(sharedLock(storeFile), "held",
        "after initStore + the startup credential scrub, the main-file SHARED lock must still be held — a free lock lets a peer delete -wal/-shm under this process");
      // The migration ladder still leaves its safety copies — now written by
      // SQLite (VACUUM INTO) instead of fs.copyFileSync, which is what used to
      // drop the main-file lock above.
      const backups = fs.readdirSync(path.dirname(storeFile)).filter((name) => /\.bak$/.test(name) && name.startsWith(path.basename(storeFile)));
      assert.ok(backups.some((name) => name.includes("v102-seats")) && backups.some((name) => name.includes("v103-seat-session")),
        `ladder safety copies must still be produced, found: ${backups.join(", ") || "none"}`);
      for (const name of backups) {
        const copy = new Database(path.join(path.dirname(storeFile), name), { readonly: true, fileMustExist: true });
        assert.equal(String(copy.pragma("quick_check", { simple: true })).toLowerCase(), "ok", `${name} passes quick_check`);
        copy.close();
      }
      console.log(`ok   ladder safety copies (${backups.length}) written through SQLite and pass quick_check`);
      db.exec("CREATE TABLE IF NOT EXISTS __sidecar_probe(v TEXT)");
      const insert = db.prepare("INSERT INTO __sidecar_probe(v) VALUES (?)");
      db.transaction(() => { for (let i = 0; i < 5_000; i += 1) insert.run("wal-frame"); })();
      assert.equal(db.prepare("SELECT count(*) n FROM __sidecar_probe").get().n, 5_000);
      assert.equal(dmsLock(storeFile), "held", "locks survive a large WAL write");
      db.exec("DROP TABLE __sidecar_probe");
      console.log("ok   product: startup scrub leaves SQLite's -shm and main-file locks intact");
    }
    console.log("store-sidecar-lock-safety-contract: PASS");
  } catch (error) {
    exitCode = 1;
    console.error("store-sidecar-lock-safety-contract: FAIL");
    console.error(error && error.stack ? error.stack : error);
  } finally {
    try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch { /* scratch */ }
    app.exit(exitCode);
  }
})();
