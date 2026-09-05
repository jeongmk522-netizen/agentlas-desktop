// Private snapshot-only, demand-driven TypeScript emit. Never consult live dist.
// This is transpilation for runtime gates, not a substitute for type checking.
const fs = require("node:fs");
const path = require("node:path");
const Module = require("node:module");
const { fileURLToPath } = require("node:url");
const { createHash } = require("node:crypto");
const root = path.resolve(__dirname, "../..");
const receipt = JSON.parse(fs.readFileSync(path.join(root, ".agentlas-index-gates.json"), "utf8"));
if (fs.realpathSync(root) !== receipt.root || fs.existsSync(path.join(root, ".git"))) throw new Error("COMPILE_REQUIRES_INDEX_SNAPSHOT");
// Reject accidental absolute-path fallbacks into the live checkout. Dependencies
// are the sole declared exception and may only be read, never installed/rebuilt.
// These guards catch common synchronous mistakes; this is not an OS sandbox.
// Only trusted, hash-pinned verifiers may run here.
const realpath = fs.realpathSync;
const exists = fs.existsSync;
function guard(filename, write = false) {
  if (filename instanceof URL) filename = fileURLToPath(filename);
  if (typeof filename !== "string" && !Buffer.isBuffer(filename)) return;
  const requested = path.resolve(String(filename));
  let parent = requested;
  while (!exists(parent) && path.dirname(parent) !== parent) parent = path.dirname(parent);
  // Resolve the nearest existing parent too: a new file beneath node_modules
  // must not bypass the check merely because the leaf does not exist yet.
  const absolute = path.resolve(realpath(parent), path.relative(parent, requested));
  const live = absolute === receipt.sourceRoot || absolute.startsWith(`${receipt.sourceRoot}${path.sep}`);
  const dependency = receipt.dependencies.some((item) => [item.source, path.join(root, item.path)]
    .some((base) => absolute === base || absolute.startsWith(`${base}${path.sep}`)));
  if ((live && !dependency) || (write && dependency)) throw new Error(`LIVE_REPOSITORY_ACCESS_FORBIDDEN: ${absolute}`);
}
const open = fs.openSync;
fs.openSync = function (filename, flags, ...args) {
  const writes = typeof flags === "string" ? /[wa+]/.test(flags)
    : Boolean(flags & (fs.constants.O_WRONLY | fs.constants.O_RDWR | fs.constants.O_CREAT | fs.constants.O_TRUNC | fs.constants.O_APPEND));
  guard(filename, writes);
  return open.call(this, filename, flags, ...args);
};
for (const name of ["readFileSync", "existsSync", "statSync", "lstatSync", "readdirSync", "realpathSync"]) {
  const original = fs[name];
  const wrapped = function (filename, ...args) { guard(filename); return original.call(this, filename, ...args); };
  Object.assign(wrapped, original);
  fs[name] = wrapped;
}
for (const name of ["writeFileSync", "appendFileSync", "mkdirSync", "rmSync", "unlinkSync", "chmodSync", "truncateSync"]) {
  const original = fs[name];
  fs[name] = function (filename, ...args) { guard(filename, true); return original.call(this, filename, ...args); };
}
const indexed = new Map(receipt.files.map((file) => [file.name, file]));
const dist = path.join(root, "dist");
const artifacts = [];
let ts;
let options;
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const blob = (bytes) => createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
function readIndexed(name) {
  const file = indexed.get(name);
  if (!file) throw new Error(`COMPILE_SOURCE_NOT_INDEXED: ${name}`);
  const data = fs.readFileSync(path.join(root, name));
  if (blob(data) !== file.oid) throw new Error(`COMPILE_SOURCE_CHANGED: ${name}`);
  return data;
}
function compile(target) {
  if (!target.startsWith(`${dist}${path.sep}`)) return false;
  const relative = path.relative(dist, target).split(path.sep).join("/");
  if (!/^(electron|shared|plugins)\//.test(relative)) return false;
  const candidates = /\.(?:js|json|cjs|mjs)$/.test(relative)
    ? [relative.replace(/\.js$/, ".ts"), relative] : [`${relative}.ts`, `${relative}/index.ts`, `${relative}.json`];
  const source = candidates.find((name) => indexed.has(name));
  if (!source) return false;
  const bytes = readIndexed(source);
  let output = bytes;
  const destination = path.join(dist, source.replace(/\.ts$/, ".js"));
  if (source.endsWith(".ts")) {
    ts ||= require("typescript");
    if (!options) {
      const config = ts.parseConfigFileTextToJson("electron/tsconfig.json", readIndexed("electron/tsconfig.json").toString());
      if (config.error || config.config.extends || config.config.references) throw new Error("UNSUPPORTED_INDEXED_TSCONFIG");
      const converted = ts.convertCompilerOptionsFromJson(config.config.compilerOptions, root);
      if (converted.errors.length || converted.options.module !== ts.ModuleKind.CommonJS) throw new Error("UNSUPPORTED_INDEXED_TSCONFIG");
      options = { ...converted.options, sourceMap: false, declaration: false, incremental: false };
    }
    const result = ts.transpileModule(bytes.toString(), { compilerOptions: options, fileName: source, reportDiagnostics: true });
    if (result.diagnostics?.some((item) => item.category === ts.DiagnosticCategory.Error)) throw new Error(`INDEXED_TS_EMIT_FAILED: ${source}`);
    output = Buffer.from(result.outputText);
  }
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.writeFileSync(destination, output);
  artifacts.push({ source, sourceBlob: indexed.get(source).oid, sourceSha256: hash(bytes), output: path.relative(root, destination), outputSha256: hash(output) });
  return true;
}
// Gates that test existsSync before require need their explicit roots up front.
// Unknown/dynamic roots are not silently skipped: unresolved dependencies fail.
const earlyRoots = {
  "scripts/test-final-display-hygiene.cjs": ["electron/mcp/final-display-backstop.js", "electron/runtime/runtime-refusal.js"],
};
const gate = path.relative(root, path.resolve(process.argv[1])).split(path.sep).join("/");
for (const name of earlyRoots[gate] || []) {
  if (!compile(path.join(dist, name))) throw new Error(`INDEX_BUILD_ROOT_MISSING: ${name}`);
}
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, ...rest) {
  if (request.startsWith(".") || path.isAbsolute(request)) guard(path.resolve(parent?.filename ? path.dirname(parent.filename) : root, request));
  try {
    const resolved = originalResolve.call(this, request, parent, ...rest);
    if (path.isAbsolute(resolved)) guard(resolved);
    return resolved;
  }
  catch (error) {
    if (error.code !== "MODULE_NOT_FOUND" || !(request.startsWith(".") || path.isAbsolute(request))) throw error;
    const candidate = path.resolve(parent?.filename ? path.dirname(parent.filename) : root, request);
    if (!compile(candidate)) throw error;
    return originalResolve.call(this, request, parent, ...rest);
  }
};
process.on("exit", () => {
  fs.writeFileSync(path.join(root, `.agentlas-index-build-${process.pid}.json`), JSON.stringify({
    tree: receipt.tree, gate, command: process.argv, compiler: ts?.version ?? null,
    operation: "TypeScript.transpileModule; indexed CommonJS options; demand-driven dist only", artifacts,
  }));
});
