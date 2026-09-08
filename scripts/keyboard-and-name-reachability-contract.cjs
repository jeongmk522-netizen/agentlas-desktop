#!/usr/bin/env node
"use strict";
/*
 * 화면의 조작 요소는 **키보드로 닿고, 읽을 이름이 있어야 한다** — 계약.
 *
 * ★왜 (실측 2026-09-08). 세 계열을 훑어 나온 것:
 *   · 마우스로만 되던 자리 — Work 채팅 머리의 **프로젝트 이름**이 프로젝트로 가는 유일한
 *     길인데 `<span onClick>` 이라 Tab 으로 닿지도 Enter 로 눌리지도 않았다.
 *   · Escape 로 나갈 수 없던 대화상자 — 그중 **확인 요청 시트**는 실행을 멈춰 세우는
 *     자리인데 키보드 출구가 없었다.
 *   · 이름 없이 떠 있던 입력칸 24개 — 이름을 `<div>` 로 그려 **눈에는 보이는데 연결이
 *     없는** 상태였다(화면 낭독기에는 이름 없는 칸).
 *
 * ★검사기가 먼저 거짓말했다. 세 번 고쳐서 오탐을 걷어냈다:
 *   `<label>` 이 감싼 것, `<Field>/<Row>` 래퍼 안의 것, **주석 안의 태그**.
 *   그래서 이 게이트는 주석을 벗기고, 감싸는 것들을 이름으로 인정한다.
 */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { execSync } = require("node:child_process");

const root = path.resolve(__dirname, "..");
const files = execSync(
  "find renderer/components renderer/app -name '*.tsx' -not -path '*/.next*' -not -path '*/private/*'",
  { cwd: root },
).toString().trim().split("\n").filter(Boolean);

/** 주석은 코드가 아니다 — 주석 안의 `<select>` 를 세다가 한 번 헛짚었다. */
const strip = (src) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

function openTag(src, start) {
  let i = start, depth = 0, quote = null;
  while (i < src.length) {
    const c = src[i];
    if (quote) { if (c === quote && src[i - 1] !== "\\") quote = null; i++; continue; }
    if (c === '"' || c === "'" || c === "`") { quote = c; i++; continue; }
    if (c === "{") depth++;
    else if (c === "}") depth--;
    else if (c === ">" && depth === 0) return src.slice(start, i + 1);
    i++;
  }
  return null;
}

/** 감싸는 것이 이름을 주는가 — <label> 과, label 을 그리는 공용 래퍼들. */
const NAMING_WRAPPERS = ["label", "Field", "Row"];
function insideNamingWrapper(src, at) {
  const before = src.slice(0, at);
  return NAMING_WRAPPERS.some((name) => {
    const open = (before.match(new RegExp(`<${name}\\b`, "g")) || []).length;
    const close = (before.match(new RegExp(`</${name}>`, "g")) || []).length;
    return open > close;
  });
}

function unnamedInputs(sources) {
  const out = [];
  for (const [rel, raw] of sources) {
    const src = strip(raw);
    for (const tag of ["<input", "<textarea", "<select"]) {
      let idx = 0;
      while ((idx = src.indexOf(tag, idx)) !== -1) {
        const at = idx;
        const opened = openTag(src, idx);
        idx += tag.length;
        if (!opened) continue;
        if (/type=["']?\{?["']?(hidden|submit|button|checkbox|radio|file)/.test(opened)) continue;
        if (/aria-label|aria-labelledby|placeholder=|title=|\bid=/.test(opened)) continue;
        if (insideNamingWrapper(src, at)) continue;
        out.push(`${rel}:${src.slice(0, at).split("\n").length}`);
      }
    }
  }
  return out;
}

const sources = files.map((rel) => [rel, fs.readFileSync(path.join(root, rel), "utf8")]);

let checks = 0;
const check = (name, fn) => { fn(); checks += 1; process.stdout.write(`  ok  ${name}\n`); };

check("전제 — 입력칸을 실제로 훑어 왔다", () => {
  const total = sources.reduce((n, [, s]) => n + (s.match(/<input|<textarea|<select/g) ?? []).length, 0);
  assert.ok(total > 200, `입력칸을 ${total}개만 찾았습니다 — 스캔이 깨졌습니다`);
});

check("★이름 없이 떠 있는 입력칸이 없다", () => {
  assert.deepEqual(
    unnamedInputs(sources), [],
    "화면 낭독기에 이름 없는 칸으로 읽힙니다. aria-label 을 주거나 <label>(또는 Field/Row)로 감싸세요.",
  );
});

check("★공용 래퍼가 실제로 <label> 을 그린다(이름을 준다고 인정하는 근거)", () => {
  for (const [file, wrapper] of [
    ["renderer/components/automation/NodeConfigPanel.tsx", "Field"],
    ["renderer/components/automation/ScheduleBuilder.tsx", "Row"],
  ]) {
    const src = strip(fs.readFileSync(path.join(root, file), "utf8"));
    const idx = src.indexOf(`function ${wrapper}(`);
    assert.ok(idx >= 0, `${wrapper} 가 사라졌습니다 — 이 게이트의 전제가 깨졌습니다`);
    const body = src.slice(idx, idx + 500);
    assert.match(body, /<label\b/, `${wrapper} 가 더는 <label> 을 그리지 않습니다 — 그 안의 입력칸이 조용히 이름을 잃습니다`);
  }
});

check("★고장 주입 — 이름 없는 입력칸이 실제로 걸린다", () => {
  assert.equal(unnamedInputs([["fake.tsx", `<input value={x} onChange={y} />`]]).length, 1,
    "이름 없는 칸을 못 잡으면 이 검사는 헛돕니다");
  assert.equal(unnamedInputs([["fake.tsx", `<input aria-label="이름" value={x} />`]]).length, 0);
  assert.equal(unnamedInputs([["fake.tsx", `<label>이름<input value={x} /></label>`]]).length, 0,
    "label 이 감싼 칸을 결함으로 셉니다");
  assert.equal(unnamedInputs([["fake.tsx", `// 주석 속 <input value={x} />`]]).length, 0,
    "주석을 코드로 셉니다");
});

process.stdout.write(`\nkeyboard-and-name-reachability-contract: ${checks} checks passed\n`);
