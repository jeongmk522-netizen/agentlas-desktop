#!/usr/bin/env node
"use strict";
/*
 * 사용자가 누른 일이 실패하면 **왜인지 화면에 말해야 한다** — 계약.
 *
 * ★왜 (오늘 이 계열만 여덟 건, 실측 2026-09-08). 전부 같은 모양이었다:
 *   · 목표 만들기   — 엔진·IPC·화면 **세 곳**이 삼켜 앱 로그에 "goal" 이 0줄이었다
 *   · 목표 이어가기 — 이유를 버리고 상태만 다시 읽어 단추가 죽은 것처럼 보였다
 *   · 목표 읽기     — 실패를 "목표 없음" 과 같은 화면으로 보여 줬다
 *   · 새 채팅       — 실패가 조용했고 뜨는 문구는 읽기 실패 얘기였다
 *   · 보내기        — One 은 문구 자체가 없었고, 그 상태 칸은 그려지지도 않았다
 *   · 조직 분석     — 결과를 만들어 놓고 읽는 곳이 없었다
 *   · 첨부 8개 초과 — 조용히 버리며 이유를 만들어 놓고 안 보여 줬다
 *   · 후보 풀 저장  — catch 가 문구를 **지워서** "아무 일 없음"과 구별되지 않았다
 *
 * 이 게이트는 **판정 함수를 실제로 부른다.** 화면 코드를 훑는 것이 아니라,
 * 실패를 사람 문장으로 옮기는 순수 함수들이 다음을 지키는지 값으로 단언한다:
 *   ① 어떤 입력에도 빈 문자열을 돌려주지 않는다(삼킴 금지)
 *   ② 이유가 없으면 **없다고 말한다**(지어내기 금지)
 *   ③ IPC 포장을 사람에게 보여 주지 않는다
 */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const ts = require("typescript");

const root = path.resolve(__dirname, "..");
/*
 * 렌더러 모듈은 번들되지 않은 TS 이고 `@/` 별칭을 쓴다. 여기서 직접 트랜스파일해
 * 부르되, 별칭은 저장소 경로로 풀어 준다(모듈 하나가 다른 하나를 부를 수 있어야 한다 —
 * 실제로 이 게이트가 "포장을 벗기는 규칙을 한 곳에 모으라"는 수리를 유도했다).
 */
const loaded = new Map();
function load(rel) {
  if (loaded.has(rel)) return loaded.get(rel);
  const js = ts.transpileModule(fs.readFileSync(path.join(root, rel), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText;
  const mod = { exports: {} };
  loaded.set(rel, mod.exports);
  const localRequire = (id) => {
    if (id.startsWith("@/")) return load(`renderer/${id.slice(2)}.ts`);
    if (id.startsWith("./") || id.startsWith("../")) {
      return load(path.join(path.dirname(rel), `${id}.ts`));
    }
    return require(id);
  };
  new Function("exports", "module", "require", js)(mod.exports, mod, localRequire);
  loaded.set(rel, mod.exports);
  return mod.exports;
}

const failure = load("renderer/lib/invocation-failure.ts");
const role = load("renderer/lib/runtime-role-failure.ts");

let checks = 0;
const check = (name, fn) => { fn(); checks += 1; process.stdout.write(`  ok  ${name}\n`); };

/** 사람에게 나갈 자격: 비어 있지 않고, 기계 포장이 안 보인다. */
function assertSpeaks(text, what) {
  assert.equal(typeof text, "string", `${what}: 문자열이 아닙니다`);
  assert.ok(text.trim().length > 0, `${what}: 빈 문구를 돌려줍니다 — 실패가 삼켜집니다`);
  assert.ok(!text.includes("remote method"), `${what}: IPC 포장이 그대로 나갑니다 — ${text}`);
  assert.ok(!/^Error:/.test(text.trim()), `${what}: Error 접두사가 그대로 나갑니다`);
}

const INPUTS = [
  new Error("Error invoking remote method 'invoke:run': Error: This chat is still running an earlier request."),
  new Error("Orchestrator pool cannot be empty."),
  new Error("CHECK constraint failed: role IN ('orchestrator','worker')"),
  new Error("SQLITE_BUSY: database is locked"),
  new Error(""),
  "문자열로 던져진 것",
  null,
  undefined,
  { message: "객체로 던져진 것" },
];

check("★어떤 실패에도 빈 문구를 돌려주지 않는다(삼킴 금지)", () => {
  for (const input of INPUTS) {
    assertSpeaks(role.describeRoleWriteFailure(input, true), `역할 저장 실패(${String(input)})`);
    assertSpeaks(role.describeRoleWriteFailure(input, false), `role write en(${String(input)})`);
  }
});

check("★이유가 없으면 '없다'고 말한다(지어내기 금지)", () => {
  const ko = role.describeRoleWriteFailure(new Error(""), true);
  assert.match(ko, /이유가 오지 않았습니다/, `이유 없음을 숨깁니다: ${ko}`);
  const en = role.describeRoleWriteFailure(new Error(""), false);
  assert.match(en, /no reason came back/i, `이유 없음을 숨깁니다: ${en}`);
});

check("★모르는 실패의 원문을 버리지 않는다", () => {
  const text = role.describeRoleWriteFailure(new Error("SQLITE_BUSY: database is locked"), true);
  assert.ok(text.includes("SQLITE_BUSY: database is locked"), `원문을 버렸습니다: ${text}`);
});

check("★IPC 포장은 벗겨서 보여 준다", () => {
  const wrapped = new Error("Error invoking remote method 'invoke:run': Error: 실제 이유");
  const text = failure.failureMessage(wrapped);
  assert.equal(text, "실제 이유", `포장을 못 벗겼습니다: ${text}`);
});

check("★대화 사용중은 code 가 사라져도 문장으로 알아본다", () => {
  const overIpc = new Error(
    "Error invoking remote method 'invoke:run': Error: This chat is still running an earlier request. Stop it first, then send this one again.",
  );
  assert.equal(failure.isChatBusyFailure(overIpc), true);
  assert.equal(failure.isChatBusyFailure(new Error("network unreachable")), false);
});

check("★고장 주입 — 옛 삼킴(빈 문구)이 실제로 걸린다", () => {
  let caught = null;
  try { assertSpeaks("", "삼킴"); } catch (error) { caught = error; }
  assert.ok(caught, "빈 문구가 통과한다면 이 게이트는 아무것도 안 재고 있습니다");
  let caught2 = null;
  try { assertSpeaks("Error invoking remote method 'x': boom", "포장"); } catch (error) { caught2 = error; }
  assert.ok(caught2, "IPC 포장이 통과한다면 이 게이트는 헛돕니다");
});

process.stdout.write(`\nuser-actions-explain-failure-contract: ${checks} checks passed\n`);
