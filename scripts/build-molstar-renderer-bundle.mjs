#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { build } from "vite";

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ENGINE_VERSION = "5.11.0";
const MOLSTAR_ROOT = path.dirname(require.resolve("molstar/package.json"));
const VIRTUAL_ENTRY = "virtual:agentlas-molstar-renderer";
const RESOLVED_ENTRY = `\0${VIRTUAL_ENTRY}`;
const SOURCE_PINS = {
  "lib/apps/viewer/extensions.js": "1f6623321527c5db83ce46051bdfb14acaa373bd6100a6d274b6265504c5087d",
  "lib/mol-util/string.js": "bba2fbeefb0125a2c35f2f0e497dbac88f8a081f758d15bb84b76ba5da37fa66",
  "lib/mol-task/util/scheduler.js": "3932a97d33790cf700bac4e7a63591a598c5e9af495c2183df5c2f3c77464d52",
};
const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const fail = (code) => { throw new Error(`molstar-source-bundle-${code}`); };
const forbiddenModule = (id) => /(?:^|[/\\])(?:h264-mp4-encoder|mp4-export)(?:[/\\]|$)/u.test(id);
const parse = (name, source) => ts.createSourceFile(name, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
const printer = ts.createPrinter({ newLine: ts.NewLineKind.LineFeed, removeComments: false });

function transformPinnedSource(relative, source) {
  if (sha256(source) !== SOURCE_PINS[relative]) fail(`source-pin-mismatch:${relative}`);
  const original = parse(relative, source);
  let importsRemoved = 0;
  let extensionsRemoved = 0;
  let interpolationsReplaced = 0;
  let stringCallbacksRejected = 0;
  const safeInterpolation = parse("safe-interpolation.js", String.raw`function interpolate(str, params) {
    return str.replace(/\$\{([A-Za-z_$][A-Za-z0-9_$]*)\}/g, function (match, name) {
      return Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : match;
    });
  }`).statements[0];
  // These nodes come from a different source file: synthesize their ranges so
  // the printer cannot accidentally reuse text from the pinned input offsets.
  const synthesize = (node) => {
    ts.setTextRange(node, { pos: -1, end: -1 });
    ts.forEachChild(node, synthesize);
  };
  synthesize(safeInterpolation);
  const statements = original.statements.flatMap((statement) => {
    if (relative.endsWith("extensions.js") && ts.isImportDeclaration(statement)
      && statement.moduleSpecifier.text === "../../extensions/mp4-export/index.js") {
      const clause = statement.importClause;
      if (!clause || clause.name || !clause.namedBindings || !ts.isNamedImports(clause.namedBindings)
        || clause.namedBindings.elements.length !== 1 || clause.namedBindings.elements[0].name.text !== "Mp4Export") {
        fail("mp4-import-shape-invalid");
      }
      importsRemoved += 1;
      return [];
    }
    if (relative.endsWith("extensions.js") && ts.isVariableStatement(statement)) {
      const declarations = statement.declarationList.declarations.map((declaration) => {
        if (!ts.isIdentifier(declaration.name) || declaration.name.text !== "ExtensionMap") return declaration;
        if (!declaration.initializer || !ts.isObjectLiteralExpression(declaration.initializer)) fail("extension-map-shape-invalid");
        const properties = declaration.initializer.properties.filter((property) => {
          if (!ts.isPropertyAssignment(property) || !ts.isStringLiteral(property.name) || property.name.text !== "mp4-export") return true;
          const call = property.initializer;
          if (!ts.isCallExpression(call) || call.expression.getText(original) !== "PluginSpec.Behavior"
            || call.arguments.length !== 1 || call.arguments[0].getText(original) !== "Mp4Export") fail("mp4-registration-shape-invalid");
          extensionsRemoved += 1;
          return false;
        });
        return ts.factory.updateVariableDeclaration(declaration, declaration.name, declaration.exclamationToken,
          declaration.type, ts.factory.updateObjectLiteralExpression(declaration.initializer, properties));
      });
      return [ts.factory.updateVariableStatement(statement, statement.modifiers,
        ts.factory.updateVariableDeclarationList(statement.declarationList, declarations))];
    }
    if (relative.endsWith("string.js") && ts.isFunctionDeclaration(statement) && statement.name?.text === "interpolate") {
      if (statement.parameters.map((parameter) => parameter.name.getText(original)).join(",") !== "str,params") fail("interpolation-shape-invalid");
      interpolationsReplaced += 1;
      // Reuse the legacy CSP patch's literal ${identifier} semantics. Expressions remain inert.
      return [ts.factory.updateFunctionDeclaration(statement, statement.modifiers, statement.asteriskToken,
        statement.name, statement.typeParameters, statement.parameters, statement.type, safeInterpolation.body)];
    }
    if (relative.endsWith("scheduler.js") && ts.isFunctionDeclaration(statement) && statement.name?.text === "createImmediateActions") {
      if (!statement.body) fail("scheduler-outer-shape-invalid");
      const outerStatements = statement.body.statements.map((nested) => {
        if (!ts.isFunctionDeclaration(nested) || nested.name?.text !== "setImmediate") return nested;
        if (!nested.body || nested.parameters.length !== 2
          || nested.parameters[0].name.getText(original) !== "callback"
          || nested.parameters[1].name.getText(original) !== "args" || !nested.parameters[1].dotDotDotToken) fail("scheduler-function-shape-invalid");
        const body = nested.body.statements.map((branch) => {
          if (!ts.isIfStatement(branch)) return branch;
          const condition = branch.expression;
          if (!ts.isBinaryExpression(condition) || !ts.isTypeOfExpression(condition.left)
            || condition.left.expression.getText(original) !== "callback"
            || condition.operatorToken.kind !== ts.SyntaxKind.ExclamationEqualsEqualsToken
            || !ts.isStringLiteral(condition.right) || condition.right.text !== "function"
            || branch.elseStatement || !ts.isBlock(branch.thenStatement) || branch.thenStatement.statements.length !== 1) fail("scheduler-condition-shape-invalid");
          const assignment = branch.thenStatement.statements[0];
          if (!ts.isExpressionStatement(assignment) || !ts.isBinaryExpression(assignment.expression)
            || assignment.expression.left.getText(original) !== "callback"
            || assignment.expression.operatorToken.kind !== ts.SyntaxKind.EqualsToken) fail("scheduler-assignment-shape-invalid");
          const constructor = assignment.expression.right;
          if (!ts.isNewExpression(constructor) || constructor.expression.getText(original) !== "Function"
            || constructor.arguments?.length !== 1 || constructor.arguments[0].getText(original) !== "'' + callback") fail("scheduler-constructor-shape-invalid");
          stringCallbacksRejected += 1;
          return ts.factory.updateIfStatement(branch, condition, ts.factory.createBlock([
            ts.factory.createThrowStatement(ts.factory.createNewExpression(ts.factory.createIdentifier("TypeError"), undefined,
              [ts.factory.createStringLiteral("callback must be a function")]))
          ], true), undefined);
        });
        return ts.factory.updateFunctionDeclaration(nested, nested.modifiers, nested.asteriskToken, nested.name,
          nested.typeParameters, nested.parameters, nested.type, ts.factory.updateBlock(nested.body, body));
      });
      return [ts.factory.updateFunctionDeclaration(statement, statement.modifiers, statement.asteriskToken, statement.name,
        statement.typeParameters, statement.parameters, statement.type, ts.factory.updateBlock(statement.body, outerStatements))];
    }
    return [statement];
  });
  const expected = relative.endsWith("extensions.js") ? [1, 1, 0, 0]
    : relative.endsWith("string.js") ? [0, 0, 1, 0] : [0, 0, 0, 1];
  if ([importsRemoved, extensionsRemoved, interpolationsReplaced, stringCallbacksRejected].some((count, index) => count !== expected[index])) fail(`transform-cardinality:${relative}`);
  const code = printer.printFile(ts.factory.updateSourceFile(original, statements));
  return { code, receipt: { path: relative, inputSha256: sha256(source), outputSha256: sha256(code), importsRemoved, extensionsRemoved, interpolationsReplaced, stringCallbacksRejected } };
}

function privateOutputDirectory(raw) {
  if (!raw || !path.isAbsolute(raw)) fail("absolute-private-out-dir-required");
  const temporaryRoots = [...new Set([os.tmpdir(), "/tmp"].filter((candidate) => fs.existsSync(candidate))
    .map((candidate) => fs.realpathSync(candidate)))];
  const target = path.resolve(raw);
  const parent = fs.realpathSync(path.dirname(target));
  const resolved = path.join(parent, path.basename(target));
  if (!temporaryRoots.some((root) => resolved.startsWith(`${root}${path.sep}`))) fail("out-dir-outside-private-temp");
  if (fs.existsSync(target)) {
    const stat = fs.lstatSync(target);
    if (!stat.isDirectory() || stat.isSymbolicLink() || fs.readdirSync(target).length) fail("out-dir-must-be-empty-real-directory");
  } else fs.mkdirSync(resolved, { mode: 0o700 });
  fs.chmodSync(resolved, 0o700);
  return resolved;
}

function packageForFile(filename) {
  let directory = path.dirname(filename);
  while (directory !== path.dirname(directory)) {
    const manifest = path.join(directory, "package.json");
    if (fs.existsSync(manifest)) {
      const value = JSON.parse(fs.readFileSync(manifest, "utf8"));
      if (value.name && value.version) return { directory, manifest, value };
    }
    directory = path.dirname(directory);
  }
  fail(`dependency-package-missing:${filename}`);
}

export async function buildMolstarRendererBundle(rawOutputDirectory) {
  const installed = JSON.parse(fs.readFileSync(path.join(MOLSTAR_ROOT, "package.json"), "utf8"));
  if (installed.version !== ENGINE_VERSION) fail(`engine-version-mismatch:${installed.version}`);
  const transforms = Object.entries(SOURCE_PINS).map(([relative]) => transformPinnedSource(relative,
    fs.readFileSync(path.join(MOLSTAR_ROOT, relative), "utf8")));
  const outputDir = privateOutputDirectory(rawOutputDirectory);
  const entry = `export { Viewer, version } from ${JSON.stringify(path.join(MOLSTAR_ROOT, "lib/apps/viewer/app.js"))};
import * as structure from ${JSON.stringify(path.join(MOLSTAR_ROOT, "lib/mol-model/structure.js"))};
export const lib = { structure };`;
  const transformApplications = new Map();
  let graph = [];
  let emittedModules = [];
  const warnings = [];
  const result = await build({
    configFile: false,
    root: ROOT,
    publicDir: false,
    logLevel: "silent",
    define: { "process.env.NODE_ENV": JSON.stringify("production") },
    plugins: [{
      name: "agentlas-pinned-molstar-without-mp4",
      enforce: "pre",
      resolveId(id) {
        if (forbiddenModule(id)) fail(`mp4-dependency-forbidden:${id}`);
        if (id === VIRTUAL_ENTRY) return RESOLVED_ENTRY;
      },
      load(id) {
        if (id === RESOLVED_ENTRY) return entry;
        for (const [index, relative] of Object.keys(SOURCE_PINS).entries()) {
          if (id !== path.join(MOLSTAR_ROOT, relative)) continue;
          transformApplications.set(relative, (transformApplications.get(relative) ?? 0) + 1);
          return transforms[index].code;
        }
      },
      generateBundle(_options, bundle) {
        graph = [...this.getModuleIds()].sort();
        if (graph.some(forbiddenModule)) fail("mp4-module-in-graph");
        emittedModules = [...new Set(Object.values(bundle).filter((item) => item.type === "chunk")
          .flatMap((item) => Object.keys(item.modules)))].sort();
      },
    }],
    build: {
      outDir: outputDir,
      emptyOutDir: false,
      copyPublicDir: false,
      write: false,
      minify: false,
      sourcemap: false,
      lib: { entry: VIRTUAL_ENTRY, name: "molstar", formats: ["iife"], fileName: () => "molstar.js" },
      rolldownOptions: {
        input: VIRTUAL_ENTRY,
        onwarn(warning) { warnings.push({ code: warning.code, message: warning.message }); },
        output: { codeSplitting: false, comments: true },
      },
    },
  });
  for (const relative of Object.keys(SOURCE_PINS)) {
    if (transformApplications.get(relative) !== 1) fail(`source-load-cardinality:${relative}`);
  }
  const builds = Array.isArray(result) ? result : [result];
  const outputs = builds.flatMap((item) => item.output ?? []);
  if (outputs.length !== 1 || outputs[0].type !== "chunk" || outputs[0].fileName !== "molstar.js"
    || outputs[0].imports.length || outputs[0].dynamicImports.length) fail("single-offline-iife-required");
  const output = outputs[0];
  if (!output.exports.includes("Viewer") || !output.exports.includes("version") || !output.exports.includes("lib")) fail("viewer-api-missing");
  if (output.code.includes("_embind_register_void") || output.code.includes("createH264MP4Encoder")) fail("mp4-code-in-output");
  // This is a direct-constructor check, not a claim to detect arbitrary aliases.
  let directDynamicFunctionCalls = 0;
  const inspectOutput = (node) => {
    if ((ts.isNewExpression(node) || ts.isCallExpression(node))
      && ts.isIdentifier(node.expression) && node.expression.text === "Function") directDynamicFunctionCalls += 1;
    ts.forEachChild(node, inspectOutput);
  };
  inspectOutput(parse("molstar.js", output.code));
  if (directDynamicFunctionCalls) fail("direct-dynamic-function-in-output");
  const dependencies = new Map();
  const sources = [];
  for (const id of graph) {
    if (!path.isAbsolute(id) || !fs.existsSync(id) || !fs.statSync(id).isFile()) continue;
    const pkg = packageForFile(id);
    const relative = path.relative(pkg.directory, id).split(path.sep).join("/");
    sources.push({ package: pkg.value.name, version: pkg.value.version, path: relative, sha256: sha256(fs.readFileSync(id)), rendered: emittedModules.includes(id) });
    dependencies.set(pkg.directory, pkg);
  }
  sources.sort((a, b) => `${a.package}/${a.path}`.localeCompare(`${b.package}/${b.path}`));
  const dependencyReceipts = [];
  const notices = ["Agentlas Mol* renderer bundle — third-party notices", "Original source copyright comments are retained in molstar.js."];
  for (const pkg of [...dependencies.values()].sort((a, b) => a.value.name.localeCompare(b.value.name))) {
    const noticeFiles = fs.readdirSync(pkg.directory).filter((name) => /^(?:licen[cs]e|copying|notice)(?:[.-]|$)/iu.test(name)
      && fs.lstatSync(path.join(pkg.directory, name)).isFile()).sort();
    notices.push(`\n${pkg.value.name}@${pkg.value.version}\nLicense: ${JSON.stringify(pkg.value.license ?? pkg.value.licenses ?? "See retained source notices")}`);
    const licenseFiles = noticeFiles.map((name) => {
      const bytes = fs.readFileSync(path.join(pkg.directory, name));
      notices.push(`\n--- ${name} ---\n${bytes.toString("utf8")}`);
      return { path: name, sha256: sha256(bytes) };
    });
    dependencyReceipts.push({ name: pkg.value.name, version: pkg.value.version,
      license: pkg.value.license ?? pkg.value.licenses ?? null, manifestSha256: sha256(fs.readFileSync(pkg.manifest)), licenseFiles });
  }
  const files = {
    "molstar.js": Buffer.from(output.code),
    "molstar.css": fs.readFileSync(require.resolve("molstar/build/viewer/molstar.css")),
    "MIT.txt": fs.readFileSync(path.join(MOLSTAR_ROOT, "LICENSE")),
    "THIRD-PARTY-NOTICES.txt": Buffer.from(`${notices.join("\n")}\n`),
  };
  const artifacts = Object.entries(files).map(([name, bytes]) => ({ name, sha256: sha256(bytes), bytes: bytes.length }));
  const sourceReceipt = { engineVersion: ENGINE_VERSION, virtualEntry: entry.replaceAll(MOLSTAR_ROOT, "<molstar>"),
    transforms: transforms.map((item) => item.receipt), sources, dependencies: dependencyReceipts };
  const receipt = {
    schema: "agentlas.molstar-source-bundle/v1",
    version: ENGINE_VERSION,
    engineVersion: ENGINE_VERSION,
    inputSha256: sha256(JSON.stringify(sourceReceipt)),
    outputSha256: artifacts.find((item) => item.name === "molstar.js").sha256,
    recipeSha256: sha256(fs.readFileSync(fileURLToPath(import.meta.url))),
    outputDir,
    bundlePath: path.join(outputDir, "molstar.js"),
    cssPath: path.join(outputDir, "molstar.css"),
    licensePath: path.join(outputDir, "MIT.txt"),
    noticesPath: path.join(outputDir, "THIRD-PARTY-NOTICES.txt"),
    receiptPath: path.join(outputDir, "build-receipt.json"),
    bundler: { vite: require("vite/package.json").version, rolldown: require("rolldown/package.json").version,
      typescript: ts.version, format: "iife", globalName: "molstar", minify: false, sourceMaps: false, legalComments: "all" },
    transforms: sourceReceipt.transforms,
    moduleCount: graph.length,
    renderedModuleCount: emittedModules.length,
    forbiddenMp4Modules: [],
    directDynamicFunctionCalls,
    modules: graph.map((id) => path.isAbsolute(id) ? path.relative(ROOT, id).split(path.sep).join("/") : id),
    sources,
    dependencies: dependencyReceipts,
    artifacts,
    warnings,
  };
  for (const [name, bytes] of Object.entries(files)) fs.writeFileSync(path.join(outputDir, name), bytes, { mode: 0o600, flag: "wx" });
  fs.writeFileSync(receipt.receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600, flag: "wx" });
  return receipt;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.length !== 2 || args[0] !== "--out-dir") fail("usage:--out-dir-absolute-private-directory");
  buildMolstarRendererBundle(args[1]).then((receipt) => process.stdout.write(`${JSON.stringify(receipt)}\n`)).catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
    process.exitCode = 1;
  });
}
