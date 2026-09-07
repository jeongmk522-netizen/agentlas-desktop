#!/usr/bin/env node
"use strict";
/*
 * 테마 무관 상수 토큰을 **표면 배경**으로 쓰지 않는다 — 계약.
 *
 * ★왜 (오너 실사용 2026-09-07): "검은 대화창 안에 또 흰색 밝은 회색 박스 안에 밝은글자
 *   나오는건 뭐하는짓이지".
 *
 *   토큰은 두 종류다:
 *     테마 토큰   --paper (라이트 #ffffff / 다크 #131419), --ink (#001519 / #f3f4f8)
 *     상수 토큰   --white (항상 #ffffff), --black (항상 어둡다)
 *
 *   OneShell 의 작업 헤더가 `background: var(--white)` 였다. 다크 테마에서 그 막대는
 *   **흰색인데** 그 위 글자는 테마 토큰(--ink = #f3f4f8, 거의 흰색)이라 읽을 수 없었다.
 *   불투명이 필요했던 것이지 "흰색"이 필요했던 게 아니다 — --paper 가 두 테마 모두
 *   불투명하다.
 *
 *   상수 토큰은 **어두운 물체와 그 위의 글자**에만 쓴다(예: background:--black + color:--white).
 *
 * ★기존 대비 게이트(qa-colour-contrast)는 이걸 못 잡았다: 그 화면 상태
 *   (data-task-active="true")를 렌더하지 않아 검사 대상에 없었다. 화면을 띄우는 검사는
 *   자기가 띄운 상태만 볼 수 있다 — 그래서 이 계열은 정적으로도 못박는다.
 */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");

/** 글자가 없는 순수 장식 물체만 상수 흰색을 배경으로 쓸 수 있다. 이유를 함께 적는다. */
const ALLOWED = [
  {
    file: "renderer/components/MediaDisplaySettings.module.css",
    selector: ".switch > span",
    why: "토글 손잡이 — 색이 있는 트랙 위의 장식 원이고 글자가 없다",
  },
];

function cssFiles(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name.startsWith(".next")) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...cssFiles(full));
    else if (entry.name.endsWith(".module.css")) out.push(full);
  }
  return out;
}

/** 배경으로 상수 흰색을 쓰는 줄을 찾는다. 주석은 코드가 아니다. */
function invariantSurfaceLines(source) {
  return source.split("\n")
    .map((line, index) => ({ line, number: index + 1 }))
    .filter(({ line }) => !/^\s*(\/\*|\*)/.test(line))
    .filter(({ line }) => /background(-color)?\s*:\s*var\(--white\)/.test(line));
}

let checks = 0;
const check = (name, fn) => { fn(); checks += 1; process.stdout.write(`  ok  ${name}\n`); };

check("★어떤 표면도 배경에 상수 흰색(--white)을 쓰지 않는다", () => {
  const offenders = [];
  for (const file of cssFiles(path.join(root, "renderer"))) {
    const relative = path.relative(root, file);
    const source = fs.readFileSync(file, "utf8");
    for (const hit of invariantSurfaceLines(source)) {
      const allowed = ALLOWED.some((item) => item.file === relative && source.includes(item.selector));
      if (!allowed) offenders.push(`${relative}:${hit.number} ${hit.line.trim()}`);
    }
  }
  assert.deepEqual(
    offenders,
    [],
    "상수 흰색을 표면 배경으로 씁니다 — 다크 테마에서 흰 박스 + 흰 글자가 됩니다.\n"
      + "불투명이 필요하면 var(--paper) 를 쓰세요(두 테마 모두 불투명).\n"
      + offenders.join("\n"),
  );
});

/*
 * ★같은 병의 나머지 절반 (실측 2026-09-08).
 *
 * 어두운 물체 안에서 글자 토큰을 뒤집는 규칙은 **바닥 토큰도 함께** 뒤집어야 한다.
 * One 사용자 말풍선이 정확히 그 상태였다: --ink/--design-ink 는 흰색으로 뒤집어 놓고
 * --design-panel 계열은 최상위의 밝은 값(#ffffff)으로 남겨 둬서, 말풍선 안 산출물 표면이
 * **흰 상자 + 흰 글자**가 됐다(잰 대비비 1.00).
 *
 * 글자만 뒤집으면 반쪽이다. 반쪽으로 착지한 수리는 고치기 전보다 나쁠 수 있다.
 */
const INK_TOKENS = /--(?:ink|ink-soft|design-ink|design-ink-2|design-muted|output-surface-ink)\s*:/;
const SURFACE_TOKENS = /--(?:paper|paper-2|paper-3|design-bg|design-panel|design-panel-muted|output-surface-bg|output-surface-panel|output-surface-muted)\s*:/;

/** 주석을 벗기고 규칙 단위로 자른다 — 주석 속 옛 코드를 세면 있지도 않은 결함이 나온다. */
function rules(source) {
  const bare = source.replace(/\/\*[\s\S]*?\*\//g, "");
  const out = [];
  const re = /([^{}]+)\{([^{}]*)\}/g;
  let m;
  while ((m = re.exec(bare))) {
    const selector = m[1].trim();
    if (selector.startsWith("@") || selector === ":root") continue;
    out.push({ selector, body: m[2] });
  }
  return out;
}

check("★글자 토큰을 뒤집는 규칙은 바닥 토큰도 함께 뒤집는다", () => {
  const offenders = [];
  for (const file of cssFiles(path.join(root, "renderer"))) {
    for (const rule of rules(fs.readFileSync(file, "utf8"))) {
      if (!INK_TOKENS.test(rule.body)) continue;
      if (SURFACE_TOKENS.test(rule.body)) continue;
      offenders.push(`${path.relative(root, file)} :: ${rule.selector.slice(0, 80)}`);
    }
  }
  assert.deepEqual(
    offenders,
    [],
    "글자 토큰만 뒤집고 바닥 토큰은 그대로 둔 규칙입니다 — 그 안의 표면은 밝은 상자로 남고\n"
      + "글자는 밝아져서 흰 상자에 흰 글자가 됩니다(One 말풍선에서 실제로 대비 1.00 이었습니다).\n"
      + offenders.join("\n"),
  );
});

check("★고장 주입 — 글자만 뒤집은 옛 말풍선이 실제로 걸린다", () => {
  const broken = `.messageBody { --ink: var(--white); --design-ink: var(--white); }`;
  const found = rules(broken).filter((r) => INK_TOKENS.test(r.body) && !SURFACE_TOKENS.test(r.body));
  assert.equal(found.length, 1, "옛 모양을 못 잡으면 이 검사는 헛돕니다");
  const fixed = `.messageBody { --design-ink: var(--white); --design-panel: rgba(255,255,255,.07); }`;
  assert.equal(
    rules(fixed).filter((r) => INK_TOKENS.test(r.body) && !SURFACE_TOKENS.test(r.body)).length,
    0,
    "고친 모양을 여전히 결함으로 셉니다",
  );
});

check("허용 목록은 실재하는 자리만 가리킨다(죽은 예외 금지)", () => {
  for (const item of ALLOWED) {
    const full = path.join(root, item.file);
    assert.ok(fs.existsSync(full), `허용 목록이 없는 파일을 가리킵니다: ${item.file}`);
    const source = fs.readFileSync(full, "utf8");
    assert.ok(source.includes(item.selector), `허용 목록의 선택자가 사라졌습니다: ${item.selector}`);
    assert.ok(
      invariantSurfaceLines(source).length > 0,
      `${item.file} 에 더는 상수 흰색 배경이 없습니다 — 예외를 지우세요`,
    );
  }
});

check("토큰의 두 종류가 실제로 그렇게 정의돼 있다(전제 확인)", () => {
  const globals = fs.readFileSync(path.join(root, "renderer/app/globals.css"), "utf8");
  const dark = globals.slice(globals.indexOf(':root[data-theme="dark"]'));
  assert.match(dark, /--paper:\s*#1[0-9a-f]{5}/i, "다크에서 --paper 가 어둡지 않습니다");
  assert.match(dark, /--ink:\s*#f[0-9a-f]{5}/i, "다크에서 --ink 가 밝지 않습니다");
  assert.match(dark, /--white:\s*#ffffff/i, "--white 가 테마와 무관한 상수가 아닙니다");
});

check("★고장 주입 — 옛 모양이 실제로 걸린다", () => {
  const broken = ".windowBar {\n  background: var(--white);\n}";
  assert.equal(invariantSurfaceLines(broken).length, 1, "옛 모양을 못 잡으면 이 게이트는 헛돕니다");
  // 주석 안의 언급은 결함이 아니다(현재 소스에 설명 주석이 실제로 들어 있다).
  assert.equal(invariantSurfaceLines("  /* background: var(--white) 였다 */").length, 0, "주석을 코드로 셌습니다");
  // 어두운 물체 위 글자는 정상이다.
  assert.equal(invariantSurfaceLines("  color: var(--white);\n  background: var(--black);").length, 0);
});

process.stdout.write(`\ntheme-invariant-surface-contract: ${checks} checks passed\n`);
