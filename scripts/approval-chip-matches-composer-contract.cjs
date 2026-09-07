#!/usr/bin/env node
"use strict";
/*
 * 승인 칩은 **그 화면 작성창과 같은 폭**이어야 한다 — 계약.
 *
 * ★왜 (QA 실측 2026-09-08, 창 1450px): 작성창 495px / 칩 432px — 63px 어긋났다.
 *   승인 칩은 "지금 답해야 하는 자리"다. 답을 쓰는 상자와 폭이 다르면 다른 물건으로 읽힌다.
 *
 * ★무엇이 어긋났나 — 셋이었다:
 *   ① One 이 건네는 상수가 920 이었다. 그런데 One 작성창 CSS 는 나중 규칙에서
 *      min(720px, 100%) 로 바뀌었다. **CSS 는 움직였고 상수는 안 움직였다.**
 *   ② 칩 래퍼가 calc(100% - 24px) 로 24px 를 뺐다. 작성창은 그 24px 를 빼지 않는다.
 *   ③ 칩 자신이 width: fit-content 라 래퍼보다도 좁게 줄었다(QA 가 잰 432px).
 *
 * ★그래서 이 게이트는 상수와 CSS 를 **대조**한다. 상수는 반드시 드리프트한다 —
 *   드리프트를 막는 방법은 "조심하기"가 아니라 둘을 붙들어 매는 검사다.
 *   두 화면의 작성창은 **식이 다르므로**(One 은 여백 0, Work 는 32px) 상한만이 아니라
 *   여백까지 대조한다. 상한만 맞추면 좁은 창에서 다시 어긋난다.
 */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const read = (rel) => fs.readFileSync(path.join(root, rel), "utf8");
const strip = (css) => css.replace(/\/\*[\s\S]*?\*\//g, "");

let checks = 0;
const check = (name, fn) => { fn(); checks += 1; process.stdout.write(`  ok  ${name}\n`); };

/** `.composer` 의 **마지막** width 선언을 읽는다 — 뒤에 오는 규칙이 이긴다. */
function lastComposerWidth(css, selectorRe) {
  const bare = strip(css);
  // ★lookbehind 를 쓴다. `(^|[,{}])` 로 앞 글자를 **소비**하면 바로 뒤에 붙어 오는 규칙이
  //   자기 경계를 못 찾아 매치되지 않는다 — 이 게이트의 첫 판이 그래서 옛 값(920)을
  //   "마지막 값"으로 읽었고, 고장 주입이 그걸 잡았다.
  const re = new RegExp(`(?<![-\\w.])${selectorRe}\\s*\\{([^{}]*)\\}`, "g");
  let m, last = null;
  while ((m = re.exec(bare))) {
    const width = /width\s*:\s*([^;]+)/.exec(m[1]);
    if (width) last = width[1].trim();
  }
  return last;
}

/** `min(720px, 100%)` / `min(calc(100% - 32px), 740px)` 에서 (상한, 여백) 을 뽑는다. */
function parseWidthExpression(expr) {
  assert.ok(expr, "작성창의 width 선언을 못 찾았습니다");
  const cap = /(\d+)px/.exec(expr.replace(/calc\([^)]*\)/g, ""));
  const inset = /calc\(\s*100%\s*-\s*(\d+)px\s*\)/.exec(expr);
  return { cap: cap ? Number(cap[1]) : null, inset: inset ? Number(inset[1]) : 0, raw: expr };
}

const SURFACES = [
  {
    label: "One",
    css: "renderer/components/one/OneShell.module.css",
    selector: "\\.composer",
    tsx: "renderer/components/one/OneShell.tsx",
    widthConst: /const ONE_COMPOSER_WIDTH_PX = (\d+)/,
    insetConst: /const ONE_COMPOSER_INSET_PX = (\d+)/,
  },
  {
    label: "Work",
    css: null, // 인라인 style 로 선언된다.
    // ★작성창 자신의 선언을 봐야 한다. 같은 화면에 폭이 비슷한 줄이 여럿 있어서
    //   "첫 번째 min(...)" 을 읽으면 엉뚱한 요소(폴더 줄·진행 막대)를 잰다 —
    //   이 게이트의 첫 판이 실제로 그렇게 틀렸고, 대조가 그걸 잡았다.
    inlineWidth: { file: "renderer/components/ChatInput.tsx", re: /width:\s*"(min\(100%,\s*740px\))"/ },
    tsx: "renderer/components/TaskCockpit.tsx",
    widthConst: /const WORK_COMPOSER_WIDTH_PX = (\d+)/,
    insetConst: /const WORK_COMPOSER_INSET_PX = (\d+)/,
  },
];

for (const surface of SURFACES) {
  check(`★${surface.label} — 칩에 건네는 폭이 작성창 CSS 와 같다`, () => {
    const expr = surface.css
      ? lastComposerWidth(read(surface.css), surface.selector)
      : (surface.inlineWidth.re.exec(read(surface.inlineWidth.file)) || [])[1];
    const actual = parseWidthExpression(expr);
    const source = read(surface.tsx);
    const declaredWidth = Number((surface.widthConst.exec(source) || [])[1]);
    const declaredInset = Number((surface.insetConst.exec(source) || [])[1]);
    assert.ok(Number.isFinite(declaredWidth), `${surface.label} 의 폭 상수를 못 찾았습니다`);
    assert.ok(Number.isFinite(declaredInset), `${surface.label} 의 여백 상수를 못 찾았습니다`);
    assert.equal(
      declaredWidth, actual.cap,
      `${surface.label} 승인 칩 폭 ${declaredWidth}px 이 작성창 ${actual.raw} 과 다릅니다 — 화면에서 어긋나 보입니다`,
    );
    assert.equal(
      declaredInset, actual.inset,
      `${surface.label} 승인 칩 여백 ${declaredInset}px 이 작성창 ${actual.raw} 과 다릅니다 — 좁은 창에서 어긋납니다`,
    );
  });
}

check("★칩 래퍼가 건네받은 값을 실제로 쓴다(폭·여백 둘 다)", () => {
  const css = strip(read("renderer/app/globals.css"));
  const rule = /\.tool-approval-inline\s*\{([^{}]*)\}/.exec(css);
  assert.ok(rule, ".tool-approval-inline 규칙이 없습니다");
  assert.match(rule[1], /var\(--agentlas-composer-width/, "래퍼가 건네받은 폭을 안 씁니다");
  assert.match(rule[1], /var\(--agentlas-composer-inset/, "래퍼가 건네받은 여백을 안 씁니다");
  assert.doesNotMatch(
    rule[1], /calc\(\s*100%\s*-\s*\d+px\s*\)/,
    "여백이 래퍼에 상수로 박혀 있습니다 — 화면마다 달라야 하는 값입니다",
  );
});

check("★칩 자신이 다시 줄어들지 않는다(fit-content 금지)", () => {
  const css = strip(read("renderer/app/globals.css"));
  const rule = /\.tool-approval-chip\s*\{([^{}]*)\}/.exec(css);
  assert.ok(rule, ".tool-approval-chip 규칙이 없습니다");
  assert.doesNotMatch(
    rule[1], /width\s*:\s*fit-content/,
    "칩이 내용만큼 줄어듭니다 — 래퍼가 작성창 폭이어도 보이는 폭은 그보다 좁아집니다(QA 가 잰 432px 이 이것입니다)",
  );
});

check("★고장 주입 — 옛 상수(920)와 옛 여백(24px)이 실제로 걸린다", () => {
  const actual = parseWidthExpression(lastComposerWidth(read("renderer/components/one/OneShell.module.css"), "\\.composer"));
  assert.notEqual(920, actual.cap, "옛 상수가 지금 CSS 와 같다면 이 게이트는 아무것도 안 재고 있습니다");
  const oldWrapper = "width: min(var(--agentlas-composer-width, 920px), calc(100% - 24px));";
  assert.match(oldWrapper, /calc\(\s*100%\s*-\s*\d+px\s*\)/, "옛 모양을 못 잡으면 위 검사는 헛돕니다");
  // 마지막 선언이 이긴다는 전제도 실제로 확인한다.
  const twoRules = ".composer { width: min(920px, 100%); }\n.composer { width: min(720px, 100%); }";
  assert.equal(parseWidthExpression(lastComposerWidth(twoRules, "\\.composer")).cap, 720,
    "뒤에 오는 규칙을 안 읽으면 옛 값을 정답으로 착각합니다 — 이번 결함이 정확히 그것이었습니다");
});

process.stdout.write(`\napproval-chip-matches-composer-contract: ${checks} checks passed\n`);
