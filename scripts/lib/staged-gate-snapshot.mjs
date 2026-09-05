// Export the immutable index to a private directory, never a Git worktree.
// Only explicitly hash-frozen dependencies are copied or shared; source, gate
// bodies and generated files are not.
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
const externalTargetPattern = /^\.\.\/(?:agentlas_terminal|docs)(?:\/[A-Za-z0-9_.-]+)+$/;

function validateExternalTarget(target) {
  const parts = typeof target === "string" ? target.split("/") : [];
  if (typeof target !== "string" || !externalTargetPattern.test(target)
    || path.posix.normalize(target) !== target || parts[0] !== ".." || parts.slice(1).includes("..")) {
    throw new Error(`INVALID_PRIVATE_EXTERNAL_ENTRY: ${target}`);
  }
}

function externalTargetPath(root, target) {
  validateExternalTarget(target);
  const parent = path.dirname(root);
  const resolved = path.resolve(root, target);
  if (resolved === root || !(resolved === parent || resolved.startsWith(`${parent}${path.sep}`))) {
    throw new Error(`INVALID_PRIVATE_EXTERNAL_TARGET: ${target}`);
  }
  return resolved;
}

function externalFiles(source) {
  const files = [];
  const visit = (directory, relative = "") => {
    for (const name of fs.readdirSync(directory).sort()) {
      const absolute = path.join(directory, name);
      const stat = fs.lstatSync(absolute);
      if (stat.isSymbolicLink()) throw new Error(`PRIVATE_EXTERNAL_SYMLINK: ${absolute}`);
      const next = relative ? path.join(relative, name) : name;
      if (stat.isDirectory()) visit(absolute, next);
      else if (stat.isFile()) files.push({ absolute, relative: next.split(path.sep).join("/"), mode: stat.mode & 0o777 });
      else throw new Error(`PRIVATE_EXTERNAL_NOT_REGULAR: ${absolute}`);
    }
  };
  visit(source);
  return files;
}

function externalDigest(source) {
  const rows = externalFiles(source).map(({ absolute, relative }) =>
    `${relative}\0${sha256(fs.readFileSync(absolute))}\n`).join("");
  return sha256(Buffer.from(rows));
}

function validateExternalSource(root, entry) {
  const kind = entry?.kind || "file";
  if (!entry || !["file", "directory"].includes(kind) || !path.isAbsolute(entry.source)) {
    throw new Error(`INVALID_PRIVATE_EXTERNAL_ENTRY: ${entry?.target || "unknown"}`);
  }
  externalTargetPath(root, entry.target);
  const source = path.resolve(entry.source);
  if (source === root || source.startsWith(`${root}${path.sep}`)) {
    throw new Error(`PRIVATE_EXTERNAL_SOURCE_IN_SNAPSHOT: ${entry.source}`);
  }
  const stat = fs.lstatSync(source);
  if (fs.realpathSync(source) !== source || (kind === "file" ? !stat.isFile() : !stat.isDirectory())) {
    throw new Error(`PRIVATE_EXTERNAL_NOT_REGULAR: ${entry.source}`);
  }
  if (kind === "file" && !/^[a-f0-9]{64}$/.test(entry.sha256)) {
    throw new Error(`INVALID_PRIVATE_EXTERNAL_HASH: ${entry.target}`);
  }
  if (kind === "directory" && !/^[a-f0-9]{64}$/.test(entry.digest)) {
    throw new Error(`INVALID_PRIVATE_EXTERNAL_DIGEST: ${entry.target}`);
  }
  const observed = kind === "file" ? sha256(fs.readFileSync(source)) : externalDigest(source);
  const expected = kind === "file" ? entry.sha256 : entry.digest;
  if (observed !== expected) throw new Error(`PRIVATE_EXTERNAL_HASH_MISMATCH: ${entry.source}`);
}

function readExternalAllowlist(root) {
  const filename = process.env.AGENTLAS_PRIVATE_EXTERNAL_ALLOWLIST;
  if (!filename) return [];
  const absolute = path.resolve(filename);
  const stat = fs.lstatSync(absolute);
  if (!stat.isFile() || fs.realpathSync(absolute) !== absolute) throw new Error("INVALID_PRIVATE_EXTERNAL_ALLOWLIST");
  const manifest = JSON.parse(fs.readFileSync(absolute, "utf8"));
  const entries = manifest?.protocol === 1 && manifest?.scope === "private-frozen-external-dependencies"
    ? manifest.dependencies : null;
  if (!Array.isArray(entries) || entries.length > 128) throw new Error("INVALID_PRIVATE_EXTERNAL_ALLOWLIST");
  const seen = new Set();
  for (const entry of entries) {
    validateExternalSource(root, entry);
    if (seen.has(entry.target)) throw new Error(`INVALID_PRIVATE_EXTERNAL_ENTRY: ${entry.target}`);
    seen.add(entry.target);
  }
  return entries;
}

function verifyExternalTarget(root, entry) {
  const target = externalTargetPath(root, entry.target);
  const stat = fs.lstatSync(target);
  if (fs.realpathSync(target) !== target) throw new Error(`PRIVATE_EXTERNAL_TARGET_SYMLINK: ${entry.target}`);
  if ((entry.kind || "file") === "file") {
    if (!stat.isFile() || sha256(fs.readFileSync(target)) !== entry.sha256) {
      throw new Error(`PRIVATE_EXTERNAL_CONTENT_MISMATCH: ${entry.target}`);
    }
  } else if (!stat.isDirectory() || externalDigest(target) !== entry.digest) {
    throw new Error(`PRIVATE_EXTERNAL_CONTENT_MISMATCH: ${entry.target}`);
  }
}

function copyExternal(root, entry, createdRoots) {
  const target = externalTargetPath(root, entry.target);
  const targetRoot = path.resolve(root, "..", entry.target.split("/")[1]);
  if (!createdRoots.has(targetRoot)) {
    if (fs.existsSync(targetRoot)) throw new Error(`PRIVATE_EXTERNAL_TARGET_EXISTS: ${targetRoot}`);
    fs.mkdirSync(targetRoot, { mode: 0o700 });
    createdRoots.add(targetRoot);
  }
  let existingParent = path.dirname(target);
  while (!fs.existsSync(existingParent) && existingParent !== targetRoot) existingParent = path.dirname(existingParent);
  if (fs.existsSync(target) || fs.lstatSync(existingParent).isSymbolicLink()) {
    throw new Error(`PRIVATE_EXTERNAL_TARGET_EXISTS: ${entry.target}`);
  }
  if ((entry.kind || "file") === "file") {
    fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
    const sourceStat = fs.statSync(entry.source);
    fs.writeFileSync(target, fs.readFileSync(entry.source), { mode: sourceStat.mode & 0o777 });
    return;
  }
  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  fs.mkdirSync(target, { mode: 0o700 });
  for (const file of externalFiles(entry.source)) {
    const destination = path.join(target, file.relative);
    fs.mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 });
    fs.writeFileSync(destination, fs.readFileSync(file.absolute), { mode: file.mode });
  }
}

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
  for (const dependency of receipt.externalDependencies || []) verifyExternalTarget(root, dependency);
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
    // Hash-pinned text fixtures may be supplied only below scripts/fixtures;
    // arbitrary text files are not executable verifier inputs.  Keep the
    // verifier extensions unchanged and retain the regular-file/symlink check
    // below for both classes of private dependency.
    const validPrivatePath = /^scripts\/(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_.-]+\.(?:cjs|mjs|json)$/.test(entry.path)
      || /^scripts\/fixtures\/(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_.-]+\.txt$/.test(entry.path);
    if (!validPrivatePath
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
  const externalDependencies = readExternalAllowlist(root);
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
  const externalRoots = new Set();
  try {
    const archive = git(root, ["archive", "--format=tar", tree], { encoding: null });
    execFileSync("tar", ["-xf", "-", "-C", temp], { input: archive, stdio: ["pipe", "pipe", "pipe"] });
    const receipt = {
      version: 1, root: fs.realpathSync(temp), sourceRoot: fs.realpathSync(root), tree, changed, files,
      privateGates: [], dependencies: [], externalDependencies: [],
    };
    // Verification also rejects export-ignore omissions/export-subst transformations.
    verifySnapshot(temp, receipt);
    for (const entry of privateGates) {
      fs.mkdirSync(path.dirname(path.join(temp, entry.path)), { recursive: true });
      fs.writeFileSync(path.join(temp, entry.path), privateBytes.get(entry.path));
      receipt.privateGates.push(entry);
    }
    for (const entry of externalDependencies) copyExternal(temp, entry, externalRoots);
    receipt.externalDependencies = externalDependencies;
    for (const entry of externalDependencies) verifyExternalTarget(temp, entry);
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
    console.log(`run-bound-gates: frozen external dependency allowlist (NOT index source): ${JSON.stringify(externalDependencies)}`);
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
    for (const entry of externalDependencies) validateExternalSource(root, entry);
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
    // External roots are sibling directories created exclusively for this snapshot.
    for (const externalRoot of externalRoots || []) fs.rmSync(externalRoot, { recursive: true, force: true });
    fs.rmSync(temp, { recursive: true, force: true });
  }
}
