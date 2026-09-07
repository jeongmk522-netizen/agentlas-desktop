#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

if (!process.versions.electron) {
  const electronBinary = path.join(__dirname, "..", "node_modules", ".bin", process.platform === "win32" ? "electron.cmd" : "electron");
  if (!fs.existsSync(electronBinary)) throw new Error("science-literature-chunk-contract-electron-runtime-missing");
  const rerun = spawnSync(electronBinary, [__filename], {
    cwd: path.join(__dirname, ".."),
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
    stdio: "inherit",
  });
  if (rerun.error) throw rerun.error;
  process.exit(rerun.status ?? 1);
}

const { ScienceStore } = require("../dist/electron/science/store.js");
const { ScienceEvidenceGraphService } = require("../dist/electron/science/evidence-graph.js");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentlas-science-literature-chunks-"));
const databasePath = path.join(root, "science.sqlite");
let store;

const digest = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");

try {
  store = new ScienceStore(databasePath);
  const created = store.createProject({
    requestId: crypto.randomUUID(),
    question: "Does zeolite confinement improve catalyst selectivity?",
    domain: "chemistry",
  });
  const fullTextBytes = Buffer.from([
    "Introduction",
    "Zeolite confinement may improve catalyst selectivity under controlled temperature.",
    "",
    "Methods",
    "Independent reactor replicates compared confined and baseline catalysts.",
    "",
    "Results",
    "The confined catalyst showed higher selectivity in all registered replicates.",
  ].join("\n\n"), "utf8");
  const source = store.createSource({
    requestId: crypto.randomUUID(), projectId: created.project.id, kind: "journal-article",
    canonicalUri: "https://example.org/full-text-zeolite", title: "Zeolite confinement study",
    authors: ["Contract Researcher"], publicationYear: 2026, publisher: "Contract Publisher",
    containerTitle: "Contract Journal", abstract: "Zeolite abstract metadata.", accessState: "parsed",
    contentSha256: digest(fullTextBytes), mimeType: "text/plain; charset=utf-8",
    retrievedAt: "2026-09-01T00:00:00.000Z", retrievalMethod: "contract-full-text-parser", license: "CC0-1.0",
  }, fullTextBytes).source;

  const chunks = store.listSourceTextChunks(created.project.id, source.version.id, 100);
  assert.ok(chunks.length >= 3, "source ingestion must persist section-aware chunks");
  assert.ok(chunks.every((chunk) => chunk.evidenceScope === "full-text"));
  assert.ok(chunks.every((chunk) => fullTextBytes.subarray(chunk.startByte, chunk.endByte).equals(Buffer.from(chunk.text, "utf8"))));
  assert.ok(chunks.every((chunk) => digest(Buffer.from(chunk.text, "utf8")) === chunk.textSha256));
  assert.ok(new Set(chunks.map((chunk) => chunk.sectionId)).size >= 3);

  const fullTextSearch = store.searchSourceTextChunks(created.project.id, "registered reactor replicates", 10);
  assert.equal(fullTextSearch.chunks.length > 0, true);
  assert.equal(fullTextSearch.chunks[0].sourceVersionId, source.version.id);
  assert.equal(fullTextSearch.chunks[0].text.includes("replicates"), true);

  // 연구 지시 전체가 이 검색으로 들어오면 예전에는 2,000자에서 예외로 죽어
  // 모델이 돌기도 전에 연구 턴이 끝났다. 검색은 어차피 앞의 낱말 24개만 쓰므로
  // 긴 요청은 죽일 일이 아니라 접을 일이다. 이 검사를 예전 코드로 되돌리면 throw 로 빨간불이 된다.
  const longResearchRequest = `${"연구 지시 서문이 아주 길다. ".repeat(220)} registered reactor replicates`;
  assert.ok(longResearchRequest.length > 2_000, "the probe must exceed the old hard limit");
  const longSearch = store.searchSourceTextChunks(created.project.id, longResearchRequest, 10);
  assert.equal(longSearch.query.length <= 2_000, true, "an over-long research request is folded, not rejected");
  assert.equal(longSearch.schema, "agentlas.science.source-text-search/v1");
  assert.throws(() => store.searchSourceTextChunks(created.project.id, "   ", 10), /science-source-text-search-query-invalid/,
    "an empty query is still refused");
  assert.throws(() => store.searchSourceTextChunks(created.project.id, 42, 10), /science-source-text-search-query-invalid/,
    "a non-string query is still refused");

  const metadata = store.createSource({
    requestId: crypto.randomUUID(), projectId: created.project.id, kind: "journal-article",
    canonicalUri: "https://example.org/abstract-only-zeolite", title: "Abstract boundary study",
    authors: ["Boundary Researcher"], publicationYear: 2026, publisher: "Boundary Publisher",
    containerTitle: "Boundary Journal", abstract: "Abstract-only evidence reports microporous confinement.",
    accessState: "metadata-only", retrievalMethod: "metadata-provider",
  }).source;
  const abstract = store.promoteSourceAbstract({
    requestId: crypto.randomUUID(), projectId: created.project.id, sourceId: metadata.id,
    expectedSourceVersionId: metadata.version.id,
  }).source;
  const abstractChunks = store.listSourceTextChunks(created.project.id, abstract.version.id, 10);
  assert.equal(abstractChunks.length, 1);
  assert.equal(abstractChunks[0].evidenceScope, "abstract");

  const graph = new ScienceEvidenceGraphService(store);
  graph.refresh({ requestId: crypto.randomUUID(), projectId: created.project.id });
  const context = graph.boundedContext(created.project.id, "microporous confinement", 24);
  assert.ok(context.literatureChunks.some((chunk) => chunk.sourceVersionId === abstract.version.id && chunk.evidenceScope === "abstract"));
  assert.ok(context.chunkBindings.some((binding) => binding.chunkId === abstractChunks[0].id));
  assert.ok(context.missing.includes("abstract-only-source"));
  const fullContext = graph.boundedContext(created.project.id, "registered reactor replicates", 24);
  assert.ok(fullContext.literatureChunks.some((chunk) => chunk.sourceVersionId === source.version.id && chunk.evidenceScope === "full-text"));
  assert.ok(fullContext.chunkBindings.some((binding) => binding.sourceVersionNodeId === fullContext.nodes.find((node) => node.canonicalRef.id === source.version.id)?.id));

  const other = store.createProject({ requestId: crypto.randomUUID(), question: "Is the chunk index project scoped?", domain: "general" });
  assert.equal(store.searchSourceTextChunks(other.project.id, "registered reactor replicates", 10).chunks.length, 0);
  assert.deepEqual(store.listSourceTextChunks(other.project.id, source.version.id, 10), []);

  store.close();
  store = new ScienceStore(databasePath);
  const replayedChunks = store.listSourceTextChunks(created.project.id, source.version.id, 100);
  assert.deepEqual(replayedChunks.map((chunk) => chunk.contentSha256), chunks.map((chunk) => chunk.contentSha256));
  assert.equal(store.ensureSourceTextIndex(created.project.id, source.id, source.version.id).chunkManifestSha256,
    store.ensureSourceTextIndex(created.project.id, source.id, source.version.id).chunkManifestSha256);

  store.recordSourceCheck({
    requestId: crypto.randomUUID(), projectId: created.project.id, sourceId: source.id,
    sourceVersionId: source.version.id, status: "retracted", code: "contract-retraction", summary: "Contract source is retracted.",
  });
  assert.equal(store.searchSourceTextChunks(created.project.id, "registered reactor replicates", 10).chunks.length, 0);

  console.log(JSON.stringify({
    ok: true,
    persistentIndex: true,
    exactByteOffsets: true,
    abstractScopeBoundary: true,
    ftsRetrieval: true,
    graphBoundChunkRetrieval: true,
    retractionExclusion: true,
    projectIsolation: true,
    restartReplay: true,
  }, null, 2));
} finally {
  if (store) store.close();
  fs.rmSync(root, { recursive: true, force: true });
}
