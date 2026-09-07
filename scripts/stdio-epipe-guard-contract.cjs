#!/usr/bin/env node
"use strict";
/*
 * 죽은 stdout 파이프가 앱을 죽이지 못한다 — 실물 재현 계약.
 *
 * ★왜 있나 (오너 크래시 보고 2026-09-07):
 *     Uncaught Exception: Error: write EPIPE
 *       at afterWriteDispatched (node:internal/stream_base_commons:159:15)
 *       ... at console.error ... at writeOriginalConsoleSafely (dist/electron/logging.js:39:9)
 *
 *   39번 줄은 `writeOriginalConsoleSafely` 의 try 블록 **안**이다. 동기 throw 였다면
 *   그 catch 가 삼켰다. 삼키지 못했다 = EPIPE 는 동기로 던져지지 않는다. 소켓 쓰기
 *   실패는 nextTick 으로 미뤄져 스트림 'error' 이벤트로 나오고, 듣는 사람이 없으면
 *   uncaughtException 이 된다. 그래서 방어는 try/catch 가 아니라 스트림 리스너다.
 *
 * ★이 게이트는 문자열을 안 본다. 실제로 파이프를 끊고 자식이 살아남는지 본다.
 *   고장 주입(가드 없이 같은 짓)이 실제로 죽는 것까지 확인한다 — 안 그러면 이 검사는
 *   "원래 안 죽는 것"을 재고 있을 수 있다.
 */
const assert = require("node:assert/strict");
const path = require("node:path");
const { spawn } = require("node:child_process");

const root = path.resolve(__dirname, "..");
const guardPath = path.join(root, "dist/electron/logging.js");

/*
 * 실제 EPIPE 를 만든다. `process.stdout.destroy()` 로는 안 된다 — 그건
 * ERR_STREAM_DESTROYED 라 동기 throw 이고 try/catch 가 삼킨다(첫 판에서 고장 주입이
 * 그 사실을 잡아냈다). EPIPE 는 **읽는 쪽이 사라진 파이프**에 써야 나온다:
 * 부모가 자식의 stdout 읽기 끝을 닫고, 자식이 그 뒤에 쓴다.
 */
const CHILD = (withGuard) => `
const Module = require("node:module");
const original = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === "electron") return { app: { getPath: () => "/tmp", getName: () => "t" } };
  return original.call(this, request, parent, isMain);
};
${withGuard ? `require(${JSON.stringify(guardPath)}).installStdioErrorGuard();` : ""}
let n = 0;
const timer = setInterval(() => {
  n += 1;
  // 제품과 같은 자리를 지난다: console 은 try/catch 로 감싸여 있어도 EPIPE 는
  // nextTick 으로 나오므로 그 catch 를 통과한다.
  try { console.log("x".repeat(64 * 1024)); } catch {}
  if (n > 40) { clearInterval(timer); process.exit(0); }
}, 5);
`;

function runChild(withGuard) {
  return new Promise((resolveRun) => {
    const child = spawn(process.execPath, ["-e", CHILD(withGuard)], { stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    // 읽는 쪽을 즉시 없앤다 — 이 순간부터 자식의 stdout 쓰기는 EPIPE 다.
    child.stdout.destroy();
    const timer = setTimeout(() => { try { child.kill("SIGKILL"); } catch {} }, 15000);
    child.on("close", (code, signal) => { clearTimeout(timer); resolveRun({ code, signal, stderr }); });
  });
}

let checks = 0;
const check = (name) => { checks += 1; process.stdout.write(`  ok  ${name}\n`); };

(async () => {
  /*
   * ★고장 주입 먼저. 가드 없이 실제로 죽는 것을 확인하지 못하면, 아래 "살아남았다"는
   *   아무것도 증명하지 못한다(원래 안 죽는 것을 재고 있는 셈이다).
   */
  const unguarded = await runChild(false);
  assert.notEqual(
    unguarded.code,
    0,
    "가드 없이도 살아남았습니다 — 재현 조건이 EPIPE 를 만들지 못했습니다. 이 게이트는 아무것도 지키지 못합니다.",
  );
  assert.match(unguarded.stderr, /EPIPE/, `재현된 오류가 EPIPE 가 아닙니다:\n${unguarded.stderr.slice(0, 400)}`);
  check("★고장 주입 — 가드가 없으면 죽은 파이프가 실제로 프로세스를 죽인다(EPIPE)");

  const guarded = await runChild(true);
  assert.equal(
    guarded.code,
    0,
    `가드가 있는데 죽었습니다 (code=${guarded.code} signal=${guarded.signal})\n${guarded.stderr.slice(0, 600)}`,
  );
  assert.ok(!/EPIPE/.test(guarded.stderr), `가드가 있는데 EPIPE 가 올라왔습니다:\n${guarded.stderr.slice(0, 400)}`);
  check("가드가 켜지면 죽은 stdout 에 계속 써도 프로세스가 살아남는다");

  const guard = require(guardPath);
  assert.equal(typeof guard.installStdioErrorGuard, "function", "가드 함수가 export 되지 않았습니다");
  guard.installStdioErrorGuard();
  const after = process.stdout.listenerCount("error");
  guard.installStdioErrorGuard();
  assert.equal(process.stdout.listenerCount("error"), after, "가드가 멱등하지 않아 리스너가 쌓입니다");
  assert.ok(after >= 1, "stdout 에 error 리스너가 붙지 않았습니다");
  check("가드는 멱등하다 — 여러 번 불러도 리스너가 쌓이지 않는다");

  const fs = require("node:fs");
  const mainSrc = fs.readFileSync(path.join(root, "electron/main.ts"), "utf8");
  const guardAt = mainSrc.indexOf("installStdioErrorGuard()");
  const readyAt = mainSrc.indexOf("initFileLogging()");
  assert.ok(guardAt > 0, "main.ts 가 가드를 부르지 않습니다");
  assert.ok(
    guardAt < readyAt,
    "가드가 파일 로깅보다 늦게 걸립니다 — app ready 이전 console 줄이 그대로 노출됩니다",
  );
  check("가드가 파일 로깅보다 먼저 걸린다(ready 이전 구간도 덮는다)");

  process.stdout.write(`\nstdio-epipe-guard-contract: ${checks} checks passed\n`);
})().catch((error) => {
  process.stderr.write(`stdio-epipe-guard-contract FAILED: ${error && error.message}\n`);
  process.exit(1);
});
