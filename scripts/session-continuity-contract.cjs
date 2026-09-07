#!/usr/bin/env node
"use strict";

/*
 * Why a conversation looked continuous and was not.
 *
 * Reported and then traced on 2026-09-07: a 2,000-character prompt with an explicit Goal produced
 * no visible answer; the person typed "d" to wake it and the model asked what it should do, as if
 * the long prompt had never existed.
 *
 * Three separate things had to line up for that:
 *
 *  1. Antigravity can exit 0 with an empty response. Nothing turned that into a failure, so the
 *     screen stayed silent and no reason was recorded anywhere.
 *  2. A turn is only saved as a resumable session when it did not fail — so that empty turn was
 *     saved as a good one.
 *  3. A resumed turn sends only the new prompt, never the history. So the next turn carried "d" and
 *     nothing else.
 *
 * The transcript still showed all 2,000 characters, because the transcript is drawn from our own
 * store. That is what made it look maintained.
 */

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const read = (relative) => fs.readFileSync(path.join(root, relative), "utf8");

// ── 1. An empty answer is a failure, with a marker ───────────────────────────
const antigravity = read("electron/runtime/antigravity.ts");
assert.ok(
  /kind: "empty" as const/.test(antigravity),
  "an empty Antigravity answer is no longer reported as a failure, so the screen goes silent again",
);
assert.ok(
  /!trimmed && reportedAgyTools\.size === 0/.test(antigravity),
  "the empty-answer rule must only fire when the run produced neither text nor tool activity",
);

// ── 2. A failed turn must never become a resumable session ───────────────────
assert.ok(
  /if \(runReq\.chatId && agyFingerprint && agyState\.conversationId && !failure\)/.test(antigravity),
  "a failed turn is being saved as a resumable session again; the next turn would inherit an empty conversation",
);

// ── 3. Session identity may only carry things stable for the conversation ────
const client = read("electron/mcp/client.ts");
const seed = client.slice(client.indexOf("agentlas.chat-session-seed"), client.indexOf("agentlas.chat-session-seed") + 900);
assert.ok(seed.includes("chatId"), "the session seed must be per conversation");
assert.ok(
  !seed.includes("mcpIsolation"),
  "a per-turn tool choice is back in the session identity: a conversation that uses the browser once "
  + "would silently drop its runtime session and lose everything the CLI held",
);
for (const volatile of ["toolMode", "hubMode", "effort"]) {
  assert.ok(
    !new RegExp(`\\b${volatile}\\b`).test(seed),
    `${volatile} changes within a conversation and must not decide session identity`,
  );
}

// ── 4. The empty failure kind must be one the continuation loop retries ──────
const { passFailureVerdict } = require(path.join(root, "dist", "electron", "long-run", "pass-failure-verdict.js"));
assert.equal(
  passFailureVerdict({ kind: "empty" }, 0).action,
  "retry",
  "an empty answer must be retried, not treated as the end of the goal",
);

// ── 5. A resumed turn sends no history, so this rule has to hold ─────────────
assert.ok(
  /agyResumeId\s*\n?\s*\?\s*\[runReq\.turnContext\?\.trim\(\), runReq\.userPrompt\]/.test(antigravity),
  "resume prompt shape changed; if it now includes history, revisit this contract rather than deleting it",
);

// ── 6. A model change must not throw the conversation away ───────────────────
// Owner decision 2026-09-07. These CLIs take the model per call, so the thread is not bound to it.
// Keeping the model in the identity meant a usage-limit fallback -- something the person never
// chose -- silently discarded everything the CLI held while the transcript stayed continuous.
for (const runtime of ["claude-code", "codex", "antigravity", "kimi", "grok"]) {
  const source = read(`electron/runtime/${runtime}.ts`);
  const start = source.indexOf("essionFingerprint");
  assert.ok(start > 0, `${runtime} has no session fingerprint`);
  const body = source.slice(start, start + 1600);
  assert.ok(
    !/update\(req\.model/.test(body),
    `${runtime} puts the model back into session identity: changing model, or a usage-limit fallback, `
    + "would drop the runtime session and lose everything it held",
  );
}
// A different executable is genuinely a different conversation and must still start fresh.
assert.ok(
  /executableFingerprint/.test(read("electron/runtime/claude-code.ts")),
  "the executable must remain part of session identity",
);

process.stdout.write(`${JSON.stringify({ ok: true, checks: 6 })}\n`);
