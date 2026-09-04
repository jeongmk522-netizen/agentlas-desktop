#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const dist = (...parts) => path.join(root, "dist", "electron", ...parts);
const observed = [];

function replace(modulePath, exportName, replacement) {
  require(modulePath)[exportName] = replacement;
}

replace(dist("runtime", "claude-code.js"), "probeClaudeCode", async () => { observed.push("claude-code"); return null; });
replace(dist("runtime", "claude-code.js"), "probeClaudeEfforts", async () => { observed.push("claude-efforts"); return []; });
replace(dist("runtime", "codex.js"), "probeCodex", async () => {
  observed.push("codex");
  return { path: "/qa/codex", version: "qa" };
});
replace(dist("runtime", "codex-models.js"), "readCodexModelDiscovery", async () => {
  observed.push("codex-models");
  return {
    inventory: [],
    discovery: { status: "unsupported", models: [], rawLineCount: 0, reason: "qa", source: "none" },
  };
});
for (const [file, exportName, kind] of [
  ["antigravity.js", "probeAntigravity", "antigravity"],
  ["kimi.js", "probeKimi", "kimi"],
  ["grok.js", "probeGrok", "grok"],
  ["cursor.js", "probeCursor", "cursor"],
  ["ollama.js", "probeOllama", "ollama"],
  ["lmstudio.js", "probeLMStudio", "lmstudio"],
  ["mlx.js", "probeMLX", "mlx"],
]) {
  replace(dist("runtime", file), exportName, async () => { observed.push(kind); return null; });
}
replace(dist("runtime", "acp-agents.js"), "listAcpKindSpecs", () => { observed.push("acp"); return []; });
replace(dist("secrets", "vault.js"), "hasApiKey", () => false);
replace(dist("runtime", "selection-mirror.js"), "writeRuntimeSelectionMirror", () => {});
replace(dist("store", "model-roles.js"), "listResolvedModelRoles", () => ({
  orchestrator: {
    role: "orchestrator",
    selection: { kind: "codex", backend: "openai", source: "/qa/codex" },
    inherited: false,
    updatedAt: null,
  },
}));
replace(dist("store", "model-roles.js"), "pickModelRoleFromPool", () => null);
replace(dist("usage", "index.js"), "peekProviderUsedPercent", () => null);
replace(dist("auth.js"), "getSessionCookieHeader", () => null);
replace(dist("store", "db.js"), "getDb", () => ({
  prepare: () => ({
    get: () => ({ kind: "codex", backend: "openai", source: "/qa/codex", model: null, long_context: 0 }),
    all: () => [],
    run: () => ({}),
  }),
  transaction: (run) => run,
}));

const { detectRuntimes } = require(dist("runtime", "detect.js"));
const allProbeKinds = ["claude-code", "codex", "antigravity", "kimi", "grok", "cursor", "ollama", "lmstudio", "mlx", "acp"];

async function main() {
  process.env.AGENTLAS_DISABLED_RUNTIME_KINDS = allProbeKinds.filter((kind) => kind !== "codex").join(",");
  const codexOnly = await detectRuntimes(true);
  assert.deepEqual(observed, ["codex", "codex-models"]);
  assert.deepEqual(codexOnly.map((runtime) => runtime.kind), ["codex"]);

  observed.length = 0;
  process.env.AGENTLAS_DISABLED_RUNTIME_KINDS = allProbeKinds.join(",");
  const none = await detectRuntimes(true);
  assert.deepEqual(observed, []);
  assert.deepEqual(none, []);
  console.log("runtime-disabled-probe-contract: ok force=true codex-only and all-disabled");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : String(error));
  process.exitCode = 1;
});
