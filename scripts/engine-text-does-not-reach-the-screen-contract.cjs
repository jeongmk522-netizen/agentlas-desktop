#!/usr/bin/env node
"use strict";
/*
 * 엔진이 낸 **식별자**가 화면에 그대로 뜨지 않는다 — 계약.
 *
 * ★왜 (실측 2026-09-08): 설정의 모바일 연결 패널이 엔진 오류 문구를 그대로 그렸다.
 *   `npm run qa:machine-text-leak` 으로 단추를 눌러 재현했고, 그 자리는 세 군데였다
 *   (QR 만들기 / 다시 열기 / 기기 해제). 엔진 문구 중 상당수는 사람 문장이 아니라
 *   `untrusted-site-publish-ipc-sender` 같은 식별자다 — 읽어도 할 일을 알 수 없다.
 *
 * 여기서 지키는 것:
 *   ① 판정 함수를 **실제로 부른다** — 엔진 소스에서 뽑은 진짜 문구를 먹여서.
 *     (문장 대조만 하는 게이트는 이 계열을 못 잡는다는 걸 이미 배웠다.)
 *   ② 사람 문장은 통과시켜야 한다 — 다 막으면 쓸모없는 함수가 된다.
 */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const ts = require("typescript");

const root = path.resolve(__dirname, "..");
const read = (rel) => fs.readFileSync(path.join(root, rel), "utf8");
let checks = 0;
const check = (name, fn) => { fn(); checks += 1; process.stdout.write(`  ok  ${name}\n`); };

const js = ts.transpileModule(read("renderer/lib/invocation-failure.ts"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
}).outputText;
const mod = { exports: {} };
new Function("exports", "module", "require", js)(mod.exports, mod, require);
const { looksLikeMachineText, humanFailure, failureMessage } = mod.exports;

/** 엔진 소스에서 실제로 던지는 문구를 읽어 온다(손으로 옮겨 적지 않는다). */
function engineThrownStrings() {
  const src = read("electron/ipc.ts").replace(/\/\*[\s\S]*?\*\//g, "");
  return [...src.matchAll(/throw new Error\("([^"]{6,80})"/g)].map((m) => m[1]);
}

check("★전제 — 엔진이 던지는 문구를 실제로 읽어 왔다", () => {
  const strings = engineThrownStrings();
  assert.ok(strings.length >= 20, `엔진 문구를 ${strings.length}개밖에 못 읽었습니다 — 이 게이트가 헛돌고 있습니다`);
});

check("★식별자 꼴 엔진 문구는 화면에 올리지 않는다", () => {
  const identifiers = engineThrownStrings().filter((s) => /^[a-z0-9]+([-_][a-z0-9]+)+$/i.test(s));
  assert.ok(identifiers.length >= 3, `식별자 꼴 문구를 ${identifiers.length}개밖에 못 찾았습니다 — 표본이 없습니다`);
  const leaked = identifiers.filter((s) => !looksLikeMachineText(s));
  assert.deepEqual(leaked, [], `식별자인데 사람 문장으로 판정됩니다:\n  ${leaked.join("\n  ")}`);
});

check("★사람 문장은 그대로 통과한다", () => {
  const sentences = engineThrownStrings().filter((s) => /\s/.test(s) && /[.?!]$|[a-z] [a-z]/i.test(s));
  assert.ok(sentences.length >= 5, `사람 문장 표본이 ${sentences.length}개뿐입니다`);
  const wrongly = sentences.filter((s) => looksLikeMachineText(s));
  assert.deepEqual(wrongly, [], `사람 문장인데 기계 문자열로 막힙니다:\n  ${wrongly.join("\n  ")}`);
});

check("★humanFailure 는 식별자를 감추고 사람 문장은 덧붙인다", () => {
  const human = "연결을 다시 열지 못했습니다.";
  assert.equal(humanFailure(new Error("untrusted-site-publish-ipc-sender"), human), human);
  assert.equal(humanFailure(new Error(""), human), human);
  const withDetail = humanFailure(new Error("The pairing QR expired. Create a new one."), human);
  assert.ok(withDetail.startsWith(human));
  assert.ok(withDetail.includes("pairing QR expired"));
});

check("★IPC 포장을 벗긴 뒤에 판정한다", () => {
  /*
   * ★메시지는 IPC 를 건너며 "Error invoking remote method '...': Error: <원문>" 으로
   *   감싸인다. 벗기지 않고 판정하면 **모든 식별자가 '사람 문장'** 이 된다(공백이 있으니까).
   */
  const wrapped = new Error("Error invoking remote method 'mobileBridge:retry': Error: untrusted-site-publish-ipc-sender");
  assert.equal(failureMessage(wrapped), "untrusted-site-publish-ipc-sender");
  assert.equal(humanFailure(wrapped, "다시 열지 못했습니다."), "다시 열지 못했습니다.");
});

/* SELFTEST — 옛 고장을 주입하면 잡히는가. */
check("SELFTEST 판정을 껐다고 가정하면 이 게이트는 실패한다", () => {
  const broken = () => false;   // 무엇이든 사람 문장이라고 우기는 판정
  const identifiers = engineThrownStrings().filter((s) => /^[a-z0-9]+([-_][a-z0-9]+)+$/i.test(s));
  const leaked = identifiers.filter((s) => !broken(s));
  assert.ok(leaked.length > 0, "고장을 주입했는데도 통과합니다 — 이 게이트는 아무것도 안 재고 있습니다");
});

process.stdout.write(`engine-text-does-not-reach-the-screen: ${checks} checks passed (화면 실측은 npm run qa:machine-text-leak)\n`);
