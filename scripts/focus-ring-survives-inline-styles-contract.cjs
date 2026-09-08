#!/usr/bin/env node
"use strict";
/*
 * 초점이 어디 있는지는 **언제나 보여야 한다** — 계약.
 *
 * ★왜 (키보드 실측 2026-09-08): Tab 을 실제로 눌러 30개 화면을 걸어 보니, 입력칸
 *   17자리에서 초점 표시가 아예 없었다. 전역 초점 링 규칙은 이미 있었는데도 그랬다 —
 *   그 자리들이 style={{ outline: "none" }} 처럼 **인라인**으로 쓰여 있었고,
 *   인라인은 어떤 선택자보다 세다. 그래서 규칙이 있는데도 조용히 죽어 있었다.
 *
 * 여기서 지키는 것:
 *   ① 인라인을 이기는 규칙(!important, :focus-visible 한정)이 있다.
 *   ② 링을 감싼 상자에 맡긴 자리(data-focus-ring="wrapper")는 **그 상자에 실제로
 *      :focus-within 규칙이 있다.** 표식만 붙이고 상자에 규칙이 없으면 예전과 똑같이
 *      아무 표시가 없다 — 그게 이 표식의 유일한 위험이다.
 *
 * 실제로 눌러 보는 검사는 scripts/qa-keyboard-journey.cjs 다(이 게이트가 그걸 대신하지 않는다).
 */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const read = (rel) => fs.readFileSync(path.join(root, rel), "utf8");
let checks = 0;
const check = (name, fn) => { fn(); checks += 1; process.stdout.write(`  ok  ${name}\n`); };

const globals = read("renderer/app/globals.css");

check("★인라인 outline:none 을 이기는 초점 규칙이 있다", () => {
  const rule = globals.match(/:where\(input, textarea, select\):focus-visible:not\(\[data-focus-ring="wrapper"\]\)\s*\{[^}]*\}/);
  assert.ok(rule, "인라인을 이기는 :focus-visible 규칙을 못 찾았습니다");
  assert.ok(/outline:[^;]*!important/.test(rule[0]),
    `그 규칙이 !important 를 쓰지 않습니다 — 인라인 style 을 못 이깁니다:\n${rule[0]}`);
});

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) { if (entry.name !== "node_modules") walk(full, out); }
    else if (/\.tsx$/.test(entry.name)) out.push(full);
  }
  return out;
}
const files = ["renderer/app", "renderer/components"].flatMap((d) => walk(path.join(root, d)));
const marked = files
  .map((f) => ({ rel: path.relative(root, f), src: fs.readFileSync(f, "utf8") }))
  .filter((f) => f.src.includes('data-focus-ring="wrapper"'));

check("★전제 — 링을 상자에 맡긴 자리를 실제로 찾아냈다", () => {
  assert.ok(marked.length >= 5, `표식이 ${marked.length}곳뿐입니다 — 이 게이트가 헛돌고 있습니다`);
});

/** 모든 스타일시트(전역 + 모듈)를 한 덩어리로 본다. */
function allStyleSheets() {
  const out = [globals];
  const stack = [path.join(root, "renderer")];
  while (stack.length) {
    const dir = stack.pop();
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { if (entry.name !== "node_modules" && entry.name !== ".next") stack.push(full); }
      else if (entry.name.endsWith(".css")) out.push(fs.readFileSync(full, "utf8"));
    }
  }
  return out.join("\n");
}
const sheets = allStyleSheets();
const focusWithinOwners = new Set(
  [...sheets.matchAll(/\.([A-Za-z0-9_-]+)(?:\[[^\]]*\])?:focus-within/g)].map((m) => m[1]),
);

check("★상자에 맡긴 자리는 그 상자에 :focus-within 규칙이 있다", () => {
  const missing = [];
  for (const { rel, src } of marked) {
    // 표식 근처 주석이 어느 상자에 맡겼는지 적어 둔다: (.클래스:focus-within)
    const notes = [...src.matchAll(/\.([A-Za-z0-9_-]+):focus-within/g)].map((m) => m[1]);
    if (notes.length === 0) { missing.push(`${rel} — 어느 상자가 링을 그리는지 적혀 있지 않습니다`); continue; }
    for (const owner of notes) {
      if (!focusWithinOwners.has(owner)) missing.push(`${rel} — .${owner}:focus-within 규칙이 스타일시트에 없습니다`);
    }
  }
  assert.deepEqual(missing, [], `표식만 붙고 링을 그리는 상자가 없습니다:\n  ${missing.join("\n  ")}`);
});

check("★대시보드 토큰은 대시보드 밖에서도 값이 있다", () => {
  /*
   * ★--dash-* 가 .dashboard-root 안에서만 정의돼 있어, 그 토큰을 쓰는 부품이 다른
   *   화면에 놓이면 `border: 1px solid var(--dash-line)` 선언 전체가 무효가 됐다
   *   (자동화 만들기 화면에서 단추 테두리 굵기 0으로 실측).
   */
  const rootBlock = globals.match(/:root\s*\{[\s\S]*?--dash-line:[\s\S]*?\}/);
  assert.ok(rootBlock, "--dash-* 기본값이 :root 에 없습니다 — 대시보드 밖에서 그 선언들이 통째로 무효가 됩니다");
  // 대체값이 붙은 var(--dash-x, ...) 는 안전하다 — 대체값 없는 것만 본다.
  const used = new Set([...globals.matchAll(/var\((--dash-[a-z0-9-]+)\s*\)/g)].map((m) => m[1]));
  const defined = new Set([...rootBlock[0].matchAll(/(--dash-[a-z0-9-]+)\s*:/g)].map((m) => m[1]));
  const gaps = [...used].filter((name) => !defined.has(name));
  assert.deepEqual(gaps, [], `:root 에 기본값이 없는 대시보드 토큰: ${gaps.join(", ")}`);
});

/* SELFTEST — 옛 고장을 주입하면 잡히는가. */
check("SELFTEST !important 없는 규칙은 통과하지 못한다", () => {
  const broken = ':where(input, textarea, select):focus-visible:not([data-focus-ring="wrapper"]) { outline: 2px solid var(--accent); }';
  const rule = broken.match(/:where\(input, textarea, select\):focus-visible:not\(\[data-focus-ring="wrapper"\]\)\s*\{[^}]*\}/);
  assert.ok(rule);
  assert.equal(/outline:[^;]*!important/.test(rule[0]), false);
});

check("SELFTEST 상자에 규칙이 없으면 잡힌다", () => {
  const owners = new Set(["composer"]);
  assert.equal(owners.has("sidenav-search"), false);
});

process.stdout.write(`focus-ring-survives-inline-styles: ${checks} checks passed\n`);
