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

check("★이미 중지를 요청한 자리는 **다른** 안내를 낸다", () => {
  /*
   * "멈추고 다시" 는 아직 안 멈춘 사람에게만 맞는 말이다. 이미 눌렀는데 같은 문장이 나오면
   * 사용자는 방금 한 일을 또 하라는 말을 듣는다 — 그리고 두 번째 중지는 아무 일도 안 한다.
   */
  let caught = null;
  try {
    assertInvocationChatAvailable("chat-1", [{ chatId: "chat-1", cancelRequestedAt: "2026-09-08T00:00:00.000Z" }]);
  } catch (error) { caught = error; }
  assert.ok(caught, "이미 중지 요청된 자리를 통과시켰습니다");
  assert.equal(caught.code, INVOCATION_CHAT_BUSY_CODE, "코드는 같아야 소비자가 갈리지 않습니다");
  assert.equal(caught.cancelAlreadyRequested, true, "소비자가 이 상태를 코드로 갈라낼 수 없습니다");
  assert.doesNotMatch(
    caught.message, /Stop it first/,
    "이미 멈춘 사람에게 다시 멈추라고 합니다 — 두 번째 중지는 아무 일도 하지 않습니다",
  );
  assert.match(
    caught.message, /reopen|restart/i,
    "정산이 안 되는 자리의 실제 회수 경로(앱 다시 켜기)를 말하지 않습니다",
  );
});

check("아직 안 멈춘 자리는 원래대로 '멈추고 다시' 라고 한다", () => {
  let caught = null;
  try {
    assertInvocationChatAvailable("chat-1", [{ chatId: "chat-1" }]);
  } catch (error) { caught = error; }
  assert.ok(caught);
  assert.match(caught.message, /Stop it first/, "아직 안 멈춘 사람에게는 멈추라고 해야 합니다");
  assert.equal(caught.cancelAlreadyRequested, false);
});

/*
 * ★양쪽 끝을 붙들어 맨다 (2026-09-08).
 *
 *   엔진은 이 실패에 code 를 붙이지만 **그 값은 렌더러까지 못 온다** — Electron 의
 *   ipcRenderer.invoke 거절은 원본 Error 의 message 만 실어 오고 커스텀 속성은 사라진다
 *   (이 저장소의 렌더러에 code 로 판정하는 자리가 0곳인 것이 그 방증이다).
 *   그래서 화면은 **문장**으로 알아본다. 문장 대조는 조용히 어긋나므로, 여기서
 *   **엔진이 실제로 만드는 문장을 꺼내 화면의 판정 함수에 먹인다.**
 *   엔진 문구를 바꾸면 이 검사가 먼저 빨간불이 된다.
 */
const tsCompiler = require("typescript");
const rendererSource = fs.readFileSync(path.join(root, "renderer/lib/invocation-failure.ts"), "utf8");
const rendererJs = tsCompiler.transpileModule(rendererSource, {
  compilerOptions: { module: tsCompiler.ModuleKind.CommonJS, target: tsCompiler.ScriptTarget.ES2020 },
}).outputText;
const rendererMod = { exports: {} };
new Function("exports", "module", "require", rendererJs)(rendererMod.exports, rendererMod, require);
const { isChatBusyFailure, failureMessage } = rendererMod.exports;

/** 엔진이 실제로 던지는 두 문장을 그대로 받아 온다(손으로 옮겨 적지 않는다). */
function engineBusyErrors() {
  const out = [];
  for (const record of [{ chatId: "c" }, { chatId: "c", cancelRequestedAt: "2026-09-08T00:00:00.000Z" }]) {
    try { assertInvocationChatAvailable("c", [record]); } catch (error) { out.push(error); }
  }
  return out;
}

check("★엔진의 두 문장을 화면이 모두 알아본다(code 없이, IPC 포장까지 씌워서)", () => {
  const errors = engineBusyErrors();
  assert.equal(errors.length, 2, "엔진에서 두 가지 문장을 못 받아 왔습니다");
  for (const error of errors) {
    // IPC 를 건너온 모습 그대로 재현한다: code 는 사라지고 message 는 포장된다.
    const overIpc = new Error(`Error invoking remote method 'invoke:run': Error: ${error.message}`);
    assert.equal(
      isChatBusyFailure(overIpc), true,
      `화면이 이 실패를 못 알아봅니다 — 엔진 문구가 바뀌었는데 화면이 안 따라온 것입니다:\n  ${error.message}`,
    );
    assert.ok(
      !failureMessage(overIpc).includes("remote method"),
      "IPC 포장을 사용자에게 그대로 보여 줍니다",
    );
  }
});

check("★상관없는 실패를 이 실패로 오인하지 않는다", () => {
  for (const other of [
    new Error("Error invoking remote method 'invoke:run': Error: Project is unavailable"),
    new Error("network unreachable"),
    new Error(""),
    null,
    undefined,
  ]) {
    assert.equal(isChatBusyFailure(other), false, `엉뚱한 실패를 대화 사용중으로 봤습니다: ${other}`);
  }
});

check("★고장 주입 — code 로만 판정했다면 이 검사가 빨간불이 된다", () => {
  const codeOnly = (error) => error?.code === "chat_invocation_active";
  const errors = engineBusyErrors();
  const overIpc = new Error(`Error invoking remote method 'invoke:run': Error: ${errors[0].message}`);
  assert.equal(codeOnly(overIpc), false, "IPC 를 건너도 code 가 남는다면 이 게이트의 전제가 틀렸습니다");
  assert.equal(isChatBusyFailure(overIpc), true);
});

check("★고장 주입 — 옛 문구였다면 이 검사가 실제로 빨간불이 된다", () => {
  const old = () => { throw new Error("This chat already has an active invocation"); };
  let caught = null;
  try { old(); } catch (error) { caught = error; }
  assert.ok(caught && !/Stop it first/.test(caught.message), "옛 문구에도 길이 있다면 이 게이트는 헛돈다");
  assert.equal(caught.code, undefined, "옛 오류에 코드가 있다면 코드 단언이 무의미하다");
});

process.stdout.write(`\nchat-busy-error-has-a-way-out-contract: ${checks} checks passed\n`);
