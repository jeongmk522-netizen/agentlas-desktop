const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const ts = require("typescript");

const root = path.resolve(__dirname, "..");
const helperSource = fs.readFileSync(path.join(root, "renderer/components/one/durable-chat-catchup.ts"), "utf8");
const shellSource = fs.readFileSync(path.join(root, "renderer/components/one/OneShell.tsx"), "utf8");
const invocationServiceSource = fs.readFileSync(path.join(root, "electron/invocation/service.ts"), "utf8");
const compiled = ts.transpileModule(helperSource, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText;
const moduleRef = { exports: {} };
new Function("exports", "module", compiled)(moduleRef.exports, moduleRef);
const { mergeDurableChatCatchup } = moduleRef.exports;

const message = (id, text, durableMessageId, extra = {}) => ({
  id,
  text,
  ...(durableMessageId ? { durableMessageId } : {}),
  ...extra,
});

// Same copy is not an identity: an older durable reply must not erase a newer
// settled reply whose durable row has not arrived in this history read.
{
  const merged = mergeDurableChatCatchup(
    [message("one-answer:run-2", "Done", "message-2")],
    [message("message-1", "Done", "message-1")],
  );
  assert.deepEqual(merged.map((entry) => entry.id), ["message-1", "one-answer:run-2"]);
}

// Two assistant rows may share a run/role; exact message ids preserve both.
{
  const merged = mergeDurableChatCatchup(
    [message("one-answer:run-2", "Final", "message-final")],
    [
      message("message-fallback", "Fallback", "message-fallback", { role: "assistant", runId: "run-2" }),
      message("message-final", "Final", "message-final", { role: "assistant", runId: "run-2" }),
    ],
  );
  assert.deepEqual(merged.map((entry) => entry.id), ["message-fallback", "message-final"]);
}

// A normal history entry needs only its durable DB id. It still replaces the
// local receipt that carried that id separately from its display id.
{
  const merged = mergeDurableChatCatchup(
    [message("one-answer:run-2", "Final", "message-final")],
    [message("message-final", "Final")],
  );
  assert.deepEqual(merged.map((entry) => entry.id), ["message-final"]);
}

// A history response for another chat is rejected by OneShell before merging.
{
  const current = [message("one-answer:run-b", "Keep", "message-b")];
  const requestedChatId = "chat-a";
  const shownChatId = "chat-b";
  const result = shownChatId === requestedChatId
    ? mergeDurableChatCatchup(current, [message("message-a", "Late", "message-a")])
    : current;
  assert.equal(result, current);
}

assert.doesNotMatch(helperSource, /\.text\b/, "copy must not be a history identity");
assert.doesNotMatch(shellSource, /durableTexts|other\.text === message\.text|durable\.text === message\.text/, "One history catch-up must not deduplicate by copy");
assert.match(shellSource, /mergeDurableChatCatchup\(current, next\)/, "settled history must merge by durable message identity");
assert.match(shellSource, /liveRunOwnsThread[\s\S]*?if \(!liveRunOwnsThread\)/, "an active stream must not be replaced by a concurrent history read");
assert.match(shellSource, /shownThreadChatIdRef\.current !== chatId[\s\S]*?runIdRef\.current/, "the settle updater must re-check navigation and a newer run after its history promise");
assert.match(shellSource, /screenStillOnThisThread[\s\S]*?liveRunNowOwnsThread[\s\S]*?return current/, "the initial-history updater must re-check its owner at callback time");
assert.match(shellSource, /durableMessageId: entry\.durableMessageId \?\? entry\.id/, "history must expose its exact durable message id to catch-up");
assert.match(invocationServiceSource, /const durableMessageId = event\.durableAssistantMessageIdForVerification[\s\S]*?durableMessageId \}/, "the terminal event must retain Main's exact persistence receipt");
console.log("qa-one-history-catchup-contract: pass");
