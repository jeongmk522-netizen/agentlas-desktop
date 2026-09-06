#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { buildMolstarRendererBundle } from "./build-molstar-renderer-bundle.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SOURCE_ROOT = path.join(ROOT, "science-renderer-packs/molstar");
const PACK_ID = "agentlas-science-renderer-molstar";
const PACK_VERSION = "1.2.1";
const SOURCE_FILES = [
  "adapter/adapter.js", "adapter/index.html", "adapter/style.css",
  "schemas/protein-structure-input-v1.json", "schemas/protein-structure-input-v2.json",
  "schemas/protein-structure-semantic-v1.json", "schemas/protein-structure-semantic-v2.json",
];
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const json = (value) => Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
const fail = (code) => { throw new Error(`molstar-pack-build-${code}`); };
const write = (target, bytes) => {
  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  fs.writeFileSync(target, bytes, { mode: 0o600, flag: "wx" });
};

// Build against this checkout's contracts, never a possibly stale shared dist.
// These two pure modules are compiled only in a fresh private build directory.
function loadContracts(directory) {
  const sources = ["product-extension", "science-renderer-pack"];
  const hashes = [];
  for (const name of sources) {
    const relative = `shared/${name}.ts`;
    const bytes = fs.readFileSync(path.join(ROOT, relative));
    const result = ts.transpileModule(bytes.toString("utf8"), {
      fileName: relative, reportDiagnostics: true,
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
    });
    if (result.diagnostics?.some((item) => item.category === ts.DiagnosticCategory.Error)) fail(`contract-compile:${relative}`);
    write(path.join(directory, `${name}.js`), result.outputText);
    hashes.push({ path: relative, sha256: sha256(bytes), compiledSha256: sha256(result.outputText) });
  }
  const require = createRequire(path.join(directory, "loader.cjs"));
  return { ...require("./product-extension.js"), ...require("./science-renderer-pack.js"), hashes };
}

function sourceEntries() {
  const actual = [];
  const walk = (relative = "") => {
    for (const entry of fs.readdirSync(path.join(SOURCE_ROOT, relative), { withFileTypes: true })) {
      const child = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(child);
      else if (entry.isFile()) actual.push(child);
      else fail(`source-entry-unsupported:${child}`);
    }
  };
  walk();
  if (JSON.stringify(actual.sort()) !== JSON.stringify(SOURCE_FILES)) fail("source-allowlist-mismatch");
  return SOURCE_FILES.map((relative) => ({ path: relative, bytes: fs.readFileSync(path.join(SOURCE_ROOT, relative)) }));
}

export async function buildMolstarRendererPack() {
  // The command prepares an unsigned release candidate, not an installed or signed release.
  // No key material is read, generated, or persisted by this builder.
  const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentlas-molstar-pack-build-"));
  fs.chmodSync(outputDir, 0o700);
  const packageDir = path.join(outputDir, "package");
  const contract = loadContracts(path.join(outputDir, "contracts"));
  const sources = sourceEntries();
  const bundle = await buildMolstarRendererBundle(path.join(outputDir, "bundle-build"));
  if (bundle.engineVersion !== "5.11.0" || bundle.forbiddenMp4Modules.length) fail("bundle-proof-invalid");
  const readArtifact = (name, target) => {
    const expected = bundle.artifacts.find((artifact) => artifact.name === name);
    const bytes = fs.readFileSync(path.join(bundle.outputDir, name));
    if (!expected || expected.sha256 !== sha256(bytes) || expected.bytes !== bytes.length) fail(`bundle-artifact-digest:${name}`);
    return { path: target, bytes };
  };
  const sbom = json({
    bomFormat: "CycloneDX", specVersion: "1.5", version: 1,
    metadata: { component: { type: "application", name: PACK_ID, version: PACK_VERSION }, properties: [
      { name: "agentlas:bundle:input-sha256", value: bundle.inputSha256 },
      { name: "agentlas:bundle:output-sha256", value: bundle.outputSha256 },
      { name: "agentlas:bundle:recipe-sha256", value: bundle.recipeSha256 },
      { name: "agentlas:bundle:excluded-extension", value: "mp4-export (unused by this renderer)" },
    ] },
    components: bundle.dependencies.map((dependency) => ({
      type: "library", name: dependency.name, version: dependency.version,
      purl: `pkg:npm/${dependency.name.replace(/^@/, "%40")}@${dependency.version}`,
      ...(typeof dependency.license === "string" ? { licenses: [{ expression: dependency.license }] } : {}),
      properties: [{ name: "agentlas:package-json:sha256", value: dependency.manifestSha256 }],
    })),
  });
  const entries = [...sources,
    readArtifact("molstar.js", "vendor/molstar.js"), readArtifact("molstar.css", "vendor/molstar.css"),
    readArtifact("MIT.txt", "legal/MIT.txt"), readArtifact("THIRD-PARTY-NOTICES.txt", "legal/THIRD-PARTY-NOTICES.txt"),
    { path: "sbom.cdx.json", bytes: sbom },
  ].sort((a, b) => a.path.localeCompare(b.path));
  const files = entries.map((entry) => ({ path: entry.path, sha256: sha256(entry.bytes), size: entry.bytes.length }));
  const digest = (name) => files.find((file) => file.path === name)?.sha256 ?? fail(`asset-missing:${name}`);
  const descriptor = {
    schema: contract.SCIENCE_RENDERER_PACK_SCHEMA, id: PACK_ID, version: PACK_VERSION,
    displayName: "Mol* Protein Structure Renderer", minimumDesktopVersion: "1.0.0",
    adapterApiVersion: contract.SCIENCE_RENDERER_ADAPTER_API_VERSION, entry: "adapter/index.html",
    engines: [{ name: "Mol*", version: bundle.engineVersion, licenseSpdx: "MIT", sourceUrl: "https://github.com/molstar/molstar/tree/v5.11.0" }],
    renderers: [{ id: "agentlas.molstar", artifactKinds: ["protein.structure"], surfaces: ["webgl2"], captureTargets: ["wrapper"],
      inputSchemaSha256: digest("schemas/protein-structure-input-v2.json"), semanticSchemaSha256: digest("schemas/protein-structure-semantic-v2.json"),
      entrySha256: digest("adapter/index.html"), maxPayloadBytes: 32 * 1024 * 1024 }],
    assets: { merkleRoot: contract.scienceRendererPackAssetRoot(files), packageBytes: files.reduce((sum, file) => sum + file.size, 0),
      sbomPath: "sbom.cdx.json", sbomSha256: sha256(sbom) },
    capabilities: { worker: false, wasm: true, vectorExport: false, offline: true, network: false, multiCapture: true, deterministicExport: false },
    networkPolicy: { mode: "deny-all" },
    licenses: [
      { spdx: "MIT", noticePath: "legal/MIT.txt", sourceUrl: "https://github.com/molstar/molstar/blob/v5.11.0/LICENSE" },
      { spdx: "LicenseRef-Third-Party", noticePath: "legal/THIRD-PARTY-NOTICES.txt", sourceUrl: "https://github.com/molstar/molstar/tree/v5.11.0" },
    ],
  };
  if (!contract.isScienceRendererPackManifest(descriptor)) fail("descriptor-contract-invalid");
  const descriptorBytes = json(descriptor);
  files.push({ path: "renderer-pack.json", sha256: sha256(descriptorBytes), size: descriptorBytes.length });
  files.sort((a, b) => a.path.localeCompare(b.path));
  const unsigned = { schema: contract.PRODUCT_EXTENSION_SCHEMA, id: PACK_ID, version: PACK_VERSION,
    displayName: descriptor.displayName, minimumDesktopVersion: descriptor.minimumDesktopVersion,
    entry: descriptor.entry, permissions: [], files };
  contract.validateScienceRendererPackRelease(descriptor, unsigned, descriptor.minimumDesktopVersion);
  for (const entry of sources) {
    if (sha256(fs.readFileSync(path.join(SOURCE_ROOT, entry.path))) !== sha256(entry.bytes)) fail(`source-changed-during-build:${entry.path}`);
  }
  for (const source of contract.hashes) {
    if (sha256(fs.readFileSync(path.join(ROOT, source.path))) !== source.sha256) fail(`contract-changed-during-build:${source.path}`);
  }
  for (const entry of entries) write(path.join(packageDir, entry.path), entry.bytes);
  write(path.join(packageDir, "renderer-pack.json"), descriptorBytes);
  // Kept outside package: cannot be mistaken for an installable extension.json.
  write(path.join(outputDir, "extension.unsigned.json"), json(unsigned));
  write(path.join(outputDir, "extension.signing-payload.json"), contract.productExtensionSignedPayload(unsigned));
  const receipt = { schema: "agentlas.molstar-pack-build/v1", outputDir, packageDir, signed: false,
    packId: PACK_ID, version: PACK_VERSION, packageBytes: descriptor.assets.packageBytes, merkleRoot: descriptor.assets.merkleRoot,
    descriptorSha256: sha256(descriptorBytes), unsignedManifestSha256: sha256(json(unsigned)),
    recipeSha256: sha256(fs.readFileSync(fileURLToPath(import.meta.url))), contracts: contract.hashes,
    sourceFiles: sources.map((entry) => ({ path: entry.path, sha256: sha256(entry.bytes) })),
    bundleReceiptPath: bundle.receiptPath, bundleInputSha256: bundle.inputSha256, bundleOutputSha256: bundle.outputSha256,
    files, validation: "current-source-descriptor-and-release-contract", excludedExtension: "mp4-export" };
  write(path.join(outputDir, "build-receipt.json"), json(receipt));
  return receipt;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 2) fail("usage:no-arguments-private-unsigned-build");
  buildMolstarRendererPack().then((receipt) => process.stdout.write(`${JSON.stringify(receipt)}\n`)).catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
    process.exitCode = 1;
  });
}
