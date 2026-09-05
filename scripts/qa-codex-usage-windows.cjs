#!/usr/bin/env node
const assert = require("node:assert/strict");
const fs = require("node:fs");
const ts = require("typescript");

require.extensions[".ts"] = (module, filename) => {
  const source = fs.readFileSync(filename, "utf8");
  const compiled = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true,
    },
    fileName: filename,
  });
  module._compile(compiled.outputText, filename);
};

const { windowsFromCodex } = require("../electron/usage/codex.ts");

const resetAt = 1_800_000_000;
const window = (usedPercent, limitWindowSeconds) => ({
  used_percent: usedPercent,
  reset_at: resetAt,
  ...(limitWindowSeconds == null ? {} : { limit_window_seconds: limitWindowSeconds }),
});

const fiveHour = windowsFromCodex({
  rate_limit: { primary_window: window(25, 300 * 60) },
});
assert.deepEqual(
  fiveHour.map(({ kind, windowDurationMins, usedPercent }) => ({ kind, windowDurationMins, usedPercent })),
  [{ kind: "5h", windowDurationMins: 300, usedPercent: 25 }],
);

const weeklyPrimary = windowsFromCodex({
  rate_limit: { primary_window: window(90, 10_080 * 60) },
});
assert.deepEqual(
  weeklyPrimary.map(({ kind, windowDurationMins, usedPercent }) => ({ kind, windowDurationMins, usedPercent })),
  [{ kind: "7d", windowDurationMins: 10_080, usedPercent: 90 }],
);
assert.equal(weeklyPrimary[0].label, "Weekly (7d)");

const unknown = windowsFromCodex({
  rate_limit: { primary_window: window(7, null) },
});
assert.deepEqual(
  unknown.map(({ kind, label, windowDurationMins }) => ({ kind, label, windowDurationMins })),
  [{ kind: "unknown", label: "Usage limit", windowDurationMins: null }],
);

const paired = windowsFromCodex({
  rate_limit: {
    primary_window: window(11, 300 * 60),
    secondary_window: window(22, 10_080 * 60),
  },
});
assert.deepEqual(
  paired.map(({ id, kind, usedPercent }) => ({ id, kind, usedPercent })),
  [
    { id: "codex:primary", kind: "5h", usedPercent: 11 },
    { id: "codex:secondary", kind: "7d", usedPercent: 22 },
  ],
);

const named = windowsFromCodex({
  rateLimitsByLimitId: {
    codex_bengalfox: {
      limitName: "GPT-5.3-Codex-Spark",
      primary: { usedPercent: 3, windowDurationMins: 300, resetsAt: resetAt },
      secondary: { usedPercent: 44, windowDurationMins: 10_080, resetsAt: resetAt },
    },
    codex: {
      primary: { usedPercent: 90, windowDurationMins: 10_080, resetsAt: resetAt },
    },
  },
  rateLimits: {
    primary: { usedPercent: 99, windowDurationMins: 300, resetsAt: resetAt },
  },
});
assert.deepEqual(
  named.map(({ id, limitId, limitName, kind, usedPercent }) => ({ id, limitId, limitName, kind, usedPercent })),
  [
    { id: "codex_bengalfox:primary", limitId: "codex_bengalfox", limitName: "GPT-5.3-Codex-Spark", kind: "5h", usedPercent: 3 },
    { id: "codex_bengalfox:secondary", limitId: "codex_bengalfox", limitName: "GPT-5.3-Codex-Spark", kind: "7d", usedPercent: 44 },
    { id: "codex:primary", limitId: "codex", limitName: null, kind: "7d", usedPercent: 90 },
  ],
);

console.log(JSON.stringify({ ok: true, fixtures: 5, windows: 8 }));
