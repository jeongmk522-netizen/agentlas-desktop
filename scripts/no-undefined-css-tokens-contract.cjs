#!/usr/bin/env node
"use strict";
/*
 * `var(--x)` 는 **정의된 토큰**만 가리켜야 한다 — 계약.
 *
 * ★왜 (실측 2026-09-08): 정의된 적 없는 토큰을 **폴백도 없이** 가리키는 자리가 43곳이었다.
 *   CSS 는 이런 것을 오류로 만들지 않는다 — 값이 조용히 **비어** 그 선언이 통째로 무효가 된다.
 *   그래서 배경이 안 칠해지고(--rd-canvas), 테두리가 사라지고(--rd-hair-strong / --border),
 *   그림자가 안 생기고(--shadow-xs/sm/md), 글자색이 상속으로 떨어진다(--ink-muted).
 *   화면은 "조금 이상한" 정도로 보이지 실패로 보이지 않아서 오래 남는다.
 *
 * 폴백이 있는 `var(--x, ...)` 는 무너지지 않으므로 세지 않는다.
 * 인라인 style 로 그때그때 세워 주는 토큰(예: --stage-color)은 허용 목록에 이유와 함께 둔다.
 */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { execSync } = require("node:child_process");

const root = path.resolve(__dirname, "..");
const files = execSync(
  "find renderer \\( -name '*.css' -o -name '*.tsx' -o -name '*.ts' \\) -not -path '*/.next*' -not -path '*/private/*'",
  { cwd: root },
).toString().trim().split("\n").filter(Boolean);

/** 인라인 style 로 세워지는 토큰 — 정의 파일에는 없는 것이 정상이다. 이유를 함께 적는다. */
const RUNTIME_TOKENS = new Map([
  ["--stage-color", "build 화면이 단계마다 style 로 직접 세운다(build/page.tsx)"],
]);

const defined = new Set();
for (const rel of files) {
  const source = fs.readFileSync(path.join(root, rel), "utf8");
  for (const m of source.matchAll(/(--[a-zA-Z][\w-]*)\s*:/g)) defined.add(m[1]);
}

function danglingRefs() {
  const out = [];
  for (const rel of files) {
    const source = fs.readFileSync(path.join(root, rel), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
    source.split("\n").forEach((line, i) => {
      // 폴백이 있는 형태는 무너지지 않는다 — 닫는 괄호 앞에 콤마가 없는 것만 본다.
      for (const m of line.matchAll(/var\(\s*(--[a-zA-Z][\w-]*)\s*\)/g)) {
        if (defined.has(m[1]) || RUNTIME_TOKENS.has(m[1])) continue;
        out.push(`${rel}:${i + 1}  ${m[1]}`);
      }
    });
  }
  return out;
}

let checks = 0;
const check = (name, fn) => { fn(); checks += 1; process.stdout.write(`  ok  ${name}\n`); };

check("전제 — 토큰 정의를 실제로 읽어 왔다", () => {
  assert.ok(defined.size > 200, `정의된 토큰이 ${defined.size}개뿐입니다 — 스캔이 깨졌습니다`);
  assert.ok(defined.has("--paper") && defined.has("--ink"), "핵심 토큰을 못 읽었습니다");
});

check("★정의 없는 토큰을 폴백 없이 가리키는 자리가 없다", () => {
  assert.deepEqual(
    danglingRefs(), [],
    "정의된 적 없는 토큰을 가리킵니다 — 그 선언은 조용히 무효가 되어 배경·테두리·그림자가 사라집니다.\n"
      + "실재하는 토큰으로 바꾸거나, 인라인으로 세우는 것이면 이유와 함께 허용 목록에 넣으세요.",
  );
});

check("허용 목록은 실재하는 사용처만 가리킨다(죽은 예외 금지)", () => {
  for (const [token, why] of RUNTIME_TOKENS) {
    assert.ok(why.trim().length > 4, `${token} 의 허용 이유가 비어 있습니다`);
    const used = files.some((rel) => fs.readFileSync(path.join(root, rel), "utf8").includes(token));
    assert.ok(used, `허용 목록이 아무도 안 쓰는 토큰을 가리킵니다: ${token}`);
  }
});

check("★고장 주입 — 없는 토큰을 넣으면 실제로 걸린다", () => {
  const fake = "--this-token-does-not-exist-2026";
  assert.ok(!defined.has(fake));
  const line = `  color: var(${fake});`;
  const hit = [...line.matchAll(/var\(\s*(--[a-zA-Z][\w-]*)\s*\)/g)].filter((m) => !defined.has(m[1]));
  assert.equal(hit.length, 1, "없는 토큰을 못 잡으면 이 검사는 헛돕니다");
  // 폴백이 있으면 안 잡는 것도 확인한다.
  const safe = `  color: var(${fake}, red);`;
  assert.equal([...safe.matchAll(/var\(\s*(--[a-zA-Z][\w-]*)\s*\)/g)].length, 0, "폴백 있는 형태를 결함으로 셉니다");
});

process.stdout.write(`\nno-undefined-css-tokens-contract: ${checks} checks passed\n`);
