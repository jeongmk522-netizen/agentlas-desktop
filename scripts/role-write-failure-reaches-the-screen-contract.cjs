#!/usr/bin/env node
"use strict";
/*
 * 역할 풀 저장이 **거절되면 화면이 그 이유를 말한다.**
 *
 * ★왜 (QA 실측 2026-09-08):
 *   "그 행 오른쪽 '관리' 칸의 × 를 5번 눌렀는데 행이 안 없어진다. 오류도 안 뜬다."
 *
 *   RuntimeControl 의 쓰기 경로 세 곳이 전부 `catch { setMessage(""); }` 였다. 거절되면
 *   문구를 **지웠다**. 그래서 "아무 일도 안 일어난 화면"과 "거절당한 화면"이 같았고,
 *   사용자에게는 제품이 고장난 것으로만 보였다. 마지막 오케스트레이터 후보를 못 지우는
 *   것은 규칙상 옳지만, 그 규칙이 화면에 없으면 규칙이 아니라 버그다.
 *
 *   같은 삼킴이 옛 저장소의 `CHECK constraint failed: role IN (...)` 도 감췄다
 *   (맥미니 로그 5회). 그쪽은 아예 저장이 안 되는데도 화면은 조용했다.
 *
 * 이 게이트는 **판정 함수를 실제로 부른다**. 소스 문자열 대조가 아니다 —
 * 문장 대조 게이트는 이 계열을 원리적으로 못 잡기 때문이다.
 */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const ts = require("typescript");

const root = path.resolve(__dirname, "..");
const src = path.join(root, "renderer/lib/runtime-role-failure.ts");
assert.ok(fs.existsSync(src), `판정 모듈이 없습니다: ${src}`);

/*
 * 렌더러는 번들되지 않은 TS 라 여기서 직접 트랜스파일해 부른다.
 * `@/` 별칭도 풀어 준다 — 이 판정이 IPC 포장 벗기기를 공용 모듈에 위임하게 되면서
 * 별칭 import 가 생겼다(그 위임 자체가 게이트가 잡아낸 수리다).
 */
const loaded = new Map();
function loadTs(rel) {
  if (loaded.has(rel)) return loaded.get(rel);
  const js = ts.transpileModule(fs.readFileSync(path.join(root, rel), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText;
  const mod = { exports: {} };
  loaded.set(rel, mod.exports);
  const localRequire = (id) => {
    if (id.startsWith("@/")) return loadTs(`renderer/${id.slice(2)}.ts`);
    if (id.startsWith("./") || id.startsWith("../")) return loadTs(path.join(path.dirname(rel), `${id}.ts`));
    return require(id);
  };
  new Function("exports", "module", "require", js)(mod.exports, mod, localRequire);
  loaded.set(rel, mod.exports);
  return mod.exports;
}
const { describeRoleWriteFailure } = loadTs("renderer/lib/runtime-role-failure.ts");
assert.equal(typeof describeRoleWriteFailure, "function", "describeRoleWriteFailure 를 내보내지 않습니다");

let checks = 0;
const check = (name, fn) => { fn(); checks += 1; process.stdout.write(`  ok  ${name}\n`); };

/** 화면에 도착할 자격: 비어 있지 않고, 원인과 **다음에 할 일**이 함께 있다. */
function assertActionable(text, { ko }) {
  assert.equal(typeof text, "string");
  assert.ok(text.trim().length >= 12, `문구가 너무 짧아 이유가 될 수 없습니다: ${JSON.stringify(text)}`);
  // 풀어낼 길이 있어야 한다 — 명령형 동사나 조치가 한 번은 나온다.
  const wayOut = ko
    ? /(하세요|하십시오|추가한 뒤|다시 켜|다시 시도|고르세요|올리거나)/
    : /(Add |Quit |Update |Reopen |Pick |try again|remove )/i;
  assert.match(text, wayOut, `푸는 길이 없습니다(원인만 있고 조치가 없음): ${JSON.stringify(text)}`);
}

const CASES = [
  {
    label: "마지막 오케스트레이터 후보 삭제 — 엔진의 실제 문구",
    // electron/store/model-roles.ts 가 던지는 그 문장 그대로.
    error: new Error("Orchestrator pool cannot be empty."),
    ko: /오케스트레이터 후보는 최소 하나/,
    en: /At least one orchestrator candidate/,
  },
  {
    label: "★옛 저장소의 역할 CHECK — 맥미니 로그에 5회 찍힌 그 오류",
    error: new Error("CHECK constraint failed: role IN ('orchestrator','worker')"),
    ko: /저장소가 아직 이 역할을 모릅니다/,
    en: /does not know this role yet/,
  },
  {
    label: "이 판이 모르는 런타임 종류",
    error: new Error("Unknown stored runtime kind: gemini-legacy"),
    ko: /모르는 것이 있습니다/,
    en: /unknown to this build/,
  },
  {
    label: "이유가 아예 안 온 경우 — 그것도 사실로 말한다",
    error: new Error(""),
    ko: /이유가 오지 않았습니다/,
    en: /no reason came back/,
  },
];

for (const c of CASES) {
  check(`${c.label} (ko)`, () => {
    const text = describeRoleWriteFailure(c.error, true);
    assert.match(text, c.ko);
    assertActionable(text, { ko: true });
  });
  check(`${c.label} (en)`, () => {
    const text = describeRoleWriteFailure(c.error, false);
    assert.match(text, c.en);
    assertActionable(text, { ko: false });
  });
}

check("★모르는 오류도 삼키지 않는다 — 원문을 붙여서라도 보여준다", () => {
  const text = describeRoleWriteFailure(new Error("SQLITE_BUSY: database is locked"), true);
  assert.ok(text.includes("SQLITE_BUSY: database is locked"), `원문을 버렸습니다: ${text}`);
  assert.ok(text.trim().length > 0);
});

check("Error 가 아닌 것이 던져져도 빈 문자열을 돌려주지 않는다", () => {
  for (const thrown of [null, undefined, "boom", 42, { code: "x" }]) {
    const text = describeRoleWriteFailure(thrown, true);
    assert.ok(text.trim().length >= 12, `빈 응답: ${JSON.stringify(thrown)} -> ${JSON.stringify(text)}`);
  }
});

check("겹쳐 붙은 `Error: ` 접두사는 사용자에게 안 보인다", () => {
  const text = describeRoleWriteFailure(new Error("Error: Error: SQLITE_BUSY"), true);
  assert.ok(!text.includes("Error: Error:"), `IPC 잡음이 그대로 나갑니다: ${text}`);
});

check("★고장 주입 — 옛 삼킴(`catch { setMessage(\"\") }`)이 이 검사에 실제로 걸린다", () => {
  const swallow = () => "";
  let caught = null;
  try {
    assertActionable(swallow(), { ko: true });
  } catch (error) {
    caught = error;
  }
  assert.ok(caught, "빈 문구가 이 게이트를 통과한다면 이 게이트는 아무것도 안 재고 있다");
});

/*
 * 컴포넌트가 실제로 이 판정을 부르는지 — 모듈만 옳고 화면이 안 부르면 아무 소용이 없다.
 * (여기만은 배선 확인이라 구조를 본다. 판정 자체는 위에서 값으로 쟀다.)
 */
check("RuntimeControl 의 쓰기 catch 가 더 이상 문구를 지우지 않는다", () => {
  const ui = fs.readFileSync(path.join(root, "renderer/components/dashboard/RuntimeControl.tsx"), "utf8");
  assert.ok(ui.includes("describeRoleWriteFailure"), "화면이 판정 함수를 부르지 않습니다");
  // ★주석을 세면 안 된다. 이 게이트의 첫 판은 *자기 설명 주석*에 적힌 옛 코드를 잡아
  //   있지도 않은 결함을 보고했다(같은 사고가 이 저장소에 이미 기록돼 있다).
  const code = ui.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  const swallows = code.match(/catch\s*\{\s*setMessage\(""\);/g) ?? [];
  assert.equal(swallows.length, 0, `아직 조용히 삼키는 catch 가 ${swallows.length}곳 남아 있습니다`);
});

process.stdout.write(`\nrole-write-failure-reaches-the-screen-contract: ${checks} checks passed\n`);
