#!/usr/bin/env node
"use strict";
/*
 * "이 대화에 이미 실행이 있다"는 거절은 **푸는 길을 말해야 한다** — 계약.
 *
 * ★왜 (오너 기기 main.log 실측 2026-09-07):
 *     13:05:21 Error: This chat already has an active invocation
 *     13:05:22 Error: This chat already has an active invocation
 *     13:05:24 Error: This chat already has an active invocation
 *   3초 안에 세 번. 그 사이 사용자가 친 말: "왜안되냐고".
 *   옛 문구는 **상태만** 말했다. 무엇을 하면 되는지 한 글자도 없었다.
 *
 * ★잠금 자체는 옳다(그리고 그 계약은 test-invocation-lifecycle 이 지킨다):
 *   취소를 요청해도 호스트 자식 프로세스가 아직 살아 있으므로, 실제 정산 전에는
 *   재시도를 막아야 같은 대화에 CLI 자식이 둘 뜨지 않는다. 그래서 이 게이트는
 *   잠금을 없애라고 하지 않는다 — **거절이 사람에게 길을 주는지**만 잰다.
 */
const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs");

const root = path.resolve(__dirname, "..");
const dist = path.join(root, "dist/electron/runtime");
assert.ok(fs.existsSync(path.join(dist, "run-id.js")), "dist 가 없습니다 — tsc -p electron/tsconfig.json");
const { assertInvocationChatAvailable, INVOCATION_CHAT_BUSY_CODE } = require(path.join(dist, "run-id.js"));
const { InvocationLifecycleRegistry } = require(path.join(dist, "invocation-lifecycle.js"));

let checks = 0;
const check = (name, fn) => { fn(); checks += 1; process.stdout.write(`  ok  ${name}\n`); };
const record = (chatId) => ({ chatId, controller: new AbortController(), cancelRequestedAt: null });

check("★거절이 무엇을 하면 되는지 말한다", () => {
  try {
    assertInvocationChatAvailable("chat-a", [{ chatId: "chat-a" }]);
    assert.fail("거절하지 않았습니다");
  } catch (error) {
    assert.match(error.message, /Stop it first/, "사용자가 할 수 있는 일을 말하지 않습니다");
    assert.doesNotMatch(error.message, /^This chat already has an active invocation$/, "옛 문구로 되돌아갔습니다");
  }
});

check("★소비자가 문구가 아니라 코드로 판정할 수 있다", () => {
  assert.equal(typeof INVOCATION_CHAT_BUSY_CODE, "string");
  try {
    assertInvocationChatAvailable("chat-a", [{ chatId: "chat-a" }]);
    assert.fail("거절하지 않았습니다");
  } catch (error) {
    assert.equal(error.code, INVOCATION_CHAT_BUSY_CODE);
  }
});

check("다른 대화는 막지 않는다", () => {
  assert.doesNotThrow(() => assertInvocationChatAvailable("chat-b", [{ chatId: "chat-a" }]));
});

check("잘못된 chatId 는 다른 오류로 갈린다(같은 코드로 뭉개지 않는다)", () => {
  try {
    assertInvocationChatAvailable("", []);
    assert.fail("거절하지 않았습니다");
  } catch (error) {
    assert.match(error.message, /Invalid invocation chatId/);
    assert.notEqual(error.code, INVOCATION_CHAT_BUSY_CODE);
  }
});

check("레지스트리도 같은 오류로 거절한다(경로가 갈리지 않는다)", () => {
  const registry = new InvocationLifecycleRegistry();
  registry.register("run-1", record("chat-A"));
  try {
    registry.register("run-2", record("chat-A"));
    assert.fail("거절하지 않았습니다");
  } catch (error) {
    assert.equal(error.code, INVOCATION_CHAT_BUSY_CODE);
  }
});

check("★고장 주입 — 옛 문구였다면 이 검사가 실제로 빨간불이 된다", () => {
  const old = () => { throw new Error("This chat already has an active invocation"); };
  let caught = null;
  try { old(); } catch (error) { caught = error; }
  assert.ok(caught && !/Stop it first/.test(caught.message), "옛 문구에도 길이 있다면 이 게이트는 헛돈다");
  assert.equal(caught.code, undefined, "옛 오류에 코드가 있다면 코드 단언이 무의미하다");
});

process.stdout.write(`\nchat-busy-error-has-a-way-out-contract: ${checks} checks passed\n`);
