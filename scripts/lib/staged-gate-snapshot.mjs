// Export the immutable index to a private directory, never a Git worktree.
// Only node_modules is shared; source, gate bodies and generated files are not.
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const gateName = /^(test|verify)-.*\.(cjs|mjs)$/;
const generic = new Set(["package.json", "package-lock.json", "tsconfig.json", "README.md", "CHANGELOG.md"]);
const marker = ".agentlas-index-gates.json";
const blobHash = (data) => createHash("sha1").update(`blob ${data.length}\0`).update(data).digest("hex");
const sha256 = (data) => createHash("sha256").update(data).digest("hex");

function git(root, args, options = {}) {
  return execFileSync("git", ["-C", root, ...args], {
    encoding: "utf8", maxBuffer: 256 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"], ...options,
  });
}

export function verifySnapshot(root, receipt) {
  if (fs.realpathSync(root) !== receipt.root || fs.existsSync(path.join(root, ".git"))) {
    throw new Error("INDEX_SNAPSHOT_INVALID_ROOT");
  }
  for (const file of receipt.files) {
    const absolute = path.join(root, file.name);
    const stat = fs.lstatSync(absolute);
    if (!stat.isFile() || blobHash(fs.readFileSync(absolute)) !== file.oid
      || Boolean(stat.mode & 0o111) !== (file.mode === "100755")) {
      throw new Error(`INDEX_SNAPSHOT_CONTENT_MISMATCH: ${file.name}`);
    }
  }
  for (const file of receipt.privateGates || []) {
    const absolute = path.join(root, file.path);
    if (!fs.lstatSync(absolute).isFile() || sha256(fs.readFileSync(absolute)) !== file.sha256) {
      throw new Error(`PRIVATE_GATE_CONTENT_MISMATCH: ${file.path}`);
    }
  }
  for (const name of fs.readdirSync(root).filter((name) => /^\.agentlas-index-build-\d+\.json$/.test(name))) {
    const build = JSON.parse(fs.readFileSync(path.join(root, name), "utf8"));
    if (build.tree !== receipt.tree) throw new Error("INDEX_BUILD_TREE_MISMATCH");
    for (const artifact of build.artifacts) {
      const source = receipt.files.find((file) => file.name === artifact.source);
      if (!source || source.oid !== artifact.sourceBlob || !/^dist\/(electron|shared|plugins)\//.test(artifact.output)
        || artifact.output.split("/").includes("..")
        || sha256(fs.readFileSync(path.join(root, artifact.source))) !== artifact.sourceSha256
        || sha256(fs.readFileSync(path.join(root, artifact.output))) !== artifact.outputSha256) {
        throw new Error(`INDEX_BUILD_CONTENT_MISMATCH: ${artifact.output}`);
      }
    }
  }
}

export function readSnapshot(root, filename) {
  if (path.resolve(filename) !== path.join(root, marker)) throw new Error("INDEX_SNAPSHOT_INVALID_RECEIPT");
  const receipt = JSON.parse(fs.readFileSync(filename, "utf8"));
  verifySnapshot(root, receipt);
  return receipt;
}

export function runIndexGates(root) {
  const tree = git(root, ["write-tree"]).trim(); // Conflict/missing object is a failure, never an empty change list.
  const base = git(root, ["rev-parse", "HEAD^{tree}"]).trim();
  const changed = git(root, ["diff-tree", "--no-commit-id", "--no-renames", "--name-only", "-r", "-z", base, tree])
    .split("\0").filter(Boolean);
  const files = git(root, ["ls-tree", "-r", "-z", tree]).split("\0").filter(Boolean).map((row) => {
    const tab = row.indexOf("\t");
    const [mode, type, oid] = row.slice(0, tab).split(" ");
    const name = row.slice(tab + 1);
    if (!["100644", "100755"].includes(mode) || type !== "blob" || !/^[a-f0-9]{40}$/.test(oid)
      || path.isAbsolute(name) || name.split("/").some((part) => ["..", ".git", "node_modules"].includes(part))
      || name === marker) throw new Error(`INDEX_SNAPSHOT_UNSUPPORTED_ENTRY: ${name}`);
    return { name, mode, oid };
  });
  const names = new Set(files.map((file) => file.name));
  // Private verifiers are tools, not product source. Freeze only explicitly
  // allowlisted bytes; neither discover them implicitly nor call them INDEX-owned.
  const privateGates = process.env.AGENTLAS_PRIVATE_GATE_ALLOWLIST
    ? JSON.parse(fs.readFileSync(process.env.AGENTLAS_PRIVATE_GATE_ALLOWLIST, "utf8")) : [];
  if (!Array.isArray(privateGates)) throw new Error("INVALID_PRIVATE_GATE_ALLOWLIST");
  const privateBytes = new Map();
  for (const entry of privateGates) {
    if (!/^scripts\/(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_.-]+\.(?:cjs|mjs|json)$/.test(entry.path)
      || !/^[a-f0-9]{64}$/.test(entry.sha256) || names.has(entry.path) || privateBytes.has(entry.path)) {
      throw new Error(`INVALID_PRIVATE_GATE_ENTRY: ${entry.path}`);
    }
    const source = path.join(root, entry.path);
    if (!fs.lstatSync(source).isFile() || fs.realpathSync(source) !== source) {
      throw new Error(`PRIVATE_GATE_NOT_REGULAR: ${entry.path}`);
    }
    const bytes = fs.readFileSync(source);
    if (sha256(bytes) !== entry.sha256) throw new Error(`PRIVATE_GATE_HASH_MISMATCH: ${entry.path}`);
    privateBytes.set(entry.path, bytes);
  }
  const missing = [];
  for (const entry of fs.readdirSync(path.join(root, "scripts"))) {
    if (!gateName.test(entry) || names.has(`scripts/${entry}`) || privateBytes.has(`scripts/${entry}`)) continue;
    const body = fs.readFileSync(path.join(root, "scripts", entry), "utf8");
    if (changed.some((file) => !generic.has(file) && (file === `scripts/${entry}` || body.includes(file)))) {
      missing.push(`scripts/${entry}`);
    }
  }
  if (missing.length) throw new Error(`INDEX_GATE_MISSING: ${missing.join(", ")}`);
  const temp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "agentlas-index-gates-")));
  try {
    const archive = git(root, ["archive", "--format=tar", tree], { encoding: null });
    execFileSync("tar", ["-xf", "-", "-C", temp], { input: archive, stdio: ["pipe", "pipe", "pipe"] });
    const receipt = { version: 1, root: fs.realpathSync(temp), sourceRoot: fs.realpathSync(root), tree, changed, files, privateGates: [], dependencies: [] };
    // Verification also rejects export-ignore omissions/export-subst transformations.
    verifySnapshot(temp, receipt);
    for (const entry of privateGates) {
      fs.mkdirSync(path.dirname(path.join(temp, entry.path)), { recursive: true });
      fs.writeFileSync(path.join(temp, entry.path), privateBytes.get(entry.path));
      receipt.privateGates.push(entry);
    }
    if (!fs.readFileSync(path.join(temp, "scripts/run-bound-gates.mjs"), "utf8")
      .includes("// index-snapshot-protocol: 1")) throw new Error("INDEX_RUNNER_PROTOCOL_UNSUPPORTED");
    const gatePaths = fs.readdirSync(path.join(temp, "scripts"))
      .filter((name) => gateName.test(name)).map((name) => `scripts/${name}`);
    receipt.expectedGates = gatePaths.filter((gate) => {
      const body = fs.readFileSync(path.join(temp, gate), "utf8");
      return changed.some((file) => !generic.has(file) && (file === gate || body.includes(file)));
    }).sort();
    const dependencies = path.join(root, "node_modules");
    if (fs.existsSync(dependencies)) {
      const resolved = fs.realpathSync(dependencies);
      fs.symlinkSync(resolved, path.join(temp, "node_modules"), "dir");
      receipt.dependencies.push({ path: "node_modules", source: resolved, policy: "read-only; no install or rebuild" });
    }
    fs.writeFileSync(path.join(temp, marker), `${JSON.stringify(receipt)}\n`);
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
      !key.startsWith("GIT_") && !["NODE_PATH", "NODE_OPTIONS", "INIT_CWD", "PWD"].includes(key)));
    console.log(`run-bound-gates: INDEX ${tree}; private non-Git snapshot; dependencies ${JSON.stringify(receipt.dependencies)}`);
    console.log(`run-bound-gates: frozen private verifier allowlist (NOT index source): ${JSON.stringify(privateGates)}`);
    const result = spawnSync(process.execPath, [path.join(temp, "scripts/run-bound-gates.mjs"), "--snapshot", path.join(temp, marker)], {
      cwd: temp, env, stdio: "inherit",
    });
    const execution = JSON.parse(fs.readFileSync(path.join(temp, ".agentlas-index-gate-results.json"), "utf8"));
    if (execution.protocol !== 1 || execution.tree !== tree || execution.complete !== true
      || JSON.stringify(execution.gates) !== JSON.stringify(receipt.expectedGates)
      || execution.results.length !== receipt.expectedGates.length
      || execution.results.some((row, i) => row.gate !== receipt.expectedGates[i] || !["PASS", "SELFTEST", "SKIP", "FAIL"].includes(row.status))
      || execution.exitStatus !== result.status) throw new Error("INDEX_RUNNER_RECEIPT_INVALID");
    verifySnapshot(temp, receipt);
    for (const entry of privateGates) {
      if (sha256(fs.readFileSync(path.join(root, entry.path))) !== entry.sha256) {
        throw new Error(`PRIVATE_GATE_CHANGED_DURING_RUN: ${entry.path}`);
      }
    }
    if (process.env.AGENTLAS_GATE_EVIDENCE_DIR) {
      const evidence = path.resolve(process.env.AGENTLAS_GATE_EVIDENCE_DIR);
      if (evidence === root || evidence.startsWith(`${root}${path.sep}`)) throw new Error("EVIDENCE_MUST_BE_OUTSIDE_REPOSITORY");
      fs.mkdirSync(evidence, { recursive: true });
      const builds = fs.readdirSync(temp).filter((name) => /^\.agentlas-index-build-\d+\.json$/.test(name))
        .map((name) => JSON.parse(fs.readFileSync(path.join(temp, name), "utf8")));
      fs.writeFileSync(path.join(evidence, `${tree}.json`), `${JSON.stringify({ ...receipt, execution, builds, exitStatus: result.status }, null, 2)}\n`);
    }
    if (git(root, ["write-tree"]).trim() !== tree) throw new Error("INDEX_CHANGED_DURING_GATES");
    if (result.error) throw result.error;
    return result.status ?? 1;
  } finally {
    // Only the exact directory created above; unlinking node_modules never follows it.
    fs.rmSync(temp, { recursive: true, force: true });
  }
}
