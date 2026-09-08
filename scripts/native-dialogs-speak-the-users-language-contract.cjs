#!/usr/bin/env node
"use strict";
/*
 * 네이티브 대화상자(window.confirm / alert / prompt)도 **사용자 언어로 말해야 한다** — 계약.
 *
 * ★왜 (실측 2026-09-08): 한국어 화면 훑기가 "남은 영어 0건" 을 계속 보고했는데,
 *   정작 이 앱에서 가장 되돌리기 어려운 물음 — **결제 승인** 두 자리 — 이 영어로만 떠 있었다.
 *   이유는 두 겹이다:
 *     ① 네이티브 대화상자는 DOM 에 없다 → 화면을 훑는 검사가 원리적으로 못 본다.
 *     ② 문구가 화면 파일이 아니라 **계산 함수**(surface-approval) 안에서 조립된다
 *        → 화면 파일만 읽는 검사도 못 본다.
 *
 * 그래서 두 방향으로 잰다:
 *   ① 소스 훑기 — 대화상자에 넘기는 식(式)이 언어를 알고 있는가.
 *   ② **함수를 실제로 부른다** — 문장 대조가 아니라 ko/en 두 번 호출해 결과를 본다.
 *      (문장 대조만 하는 게이트는 이 계열을 못 잡는다는 걸 이미 배웠다.)
 */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const ts = require("typescript");

const root = path.resolve(__dirname, "..");
const read = (rel) => fs.readFileSync(path.join(root, rel), "utf8");

let checks = 0;
const check = (name, fn) => { fn(); checks += 1; process.stdout.write(`  ok  ${name}\n`); };

const HANGUL = /[가-힣]/;

/** 주석을 **같은 길이의 공백**으로 지운다 — 줄 번호가 밀리면 안 된다. */
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/(^|[^:])\/\/[^\n]*/g, (m, p1) => p1 + " ".repeat(m.length - p1.length));
}

/** `window.confirm(` 뒤의 인자 식을 괄호 짝으로 잘라 온다. */
function dialogCalls(src) {
  const clean = stripComments(src);
  const out = [];
  const re = /window\.(confirm|alert|prompt)\s*\(/g;
  let m;
  while ((m = re.exec(clean))) {
    let depth = 1;
    let i = re.lastIndex;
    while (i < clean.length && depth > 0) {
      const ch = clean[i];
      if (ch === "(") depth += 1;
      else if (ch === ")") depth -= 1;
      i += 1;
    }
    out.push({
      kind: m[1],
      arg: clean.slice(re.lastIndex, i - 1),
      line: clean.slice(0, m.index).split("\n").length,
    });
  }
  return out;
}

/**
 * 식이 언어를 아는가.
 *  - locale 분기 / ko 분기 / 번역표 호출(t, tFor) 이면 안다.
 *  - 한글이 하나도 없고 영어 문장 리터럴만 있으면 **모른다**.
 *  - 리터럴이 아예 없는 식(변수 하나)은 여기서 판정하지 않고 아래 ②가 맡는다.
 */
function localeAware(arg) {
  if (/\blocale\b|\bko\b|\bappLocale\b|\btFor\s*\(|(?<![\w.])t\s*\(/.test(arg)) return true;
  return null_if_no_literal(arg);
}
function null_if_no_literal(arg) {
  const hasLiteral = /["'`]/.test(arg);
  if (!hasLiteral) return "indirect";
  return HANGUL.test(arg) ? true : false;
}

const RENDERER_DIRS = ["renderer/app", "renderer/components", "renderer/lib"];
function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) { if (entry.name !== "node_modules") walk(full, out); }
    else if (/\.tsx?$/.test(entry.name)) out.push(full);
  }
  return out;
}

const files = RENDERER_DIRS.flatMap((d) => walk(path.join(root, d)));

check("★전제 — 네이티브 대화상자 자리를 실제로 찾아냈다", () => {
  const total = files.reduce((n, f) => n + dialogCalls(fs.readFileSync(f, "utf8")).length, 0);
  assert.ok(total >= 20, `대화상자를 ${total}개밖에 못 찾았습니다 — 이 게이트가 헛돌고 있습니다`);
});

check("★영어로만 뜨는 네이티브 대화상자가 없다", () => {
  const bad = [];
  const indirect = [];
  for (const file of files) {
    const rel = path.relative(root, file);
    for (const call of dialogCalls(fs.readFileSync(file, "utf8"))) {
      const verdict = localeAware(call.arg);
      if (verdict === false) bad.push(`${rel}:${call.line} (${call.kind})`);
      else if (verdict === "indirect") indirect.push(`${rel}:${call.line}`);
    }
  }
  assert.deepEqual(bad, [], `영어 문구만 넘기는 대화상자:\n  ${bad.join("\n  ")}`);
  // 간접 호출(변수 하나)은 아래 ②가 값으로 확인해야 한다. 새로 생기면 여기서 알린다.
  /*
   * ★줄 번호로 못박으면 **주변을 한 줄만 고쳐도** 빨간불이 된다(실제로 그랬다).
   *   파일로 못박는다 — 그 파일의 문구 제조기는 아래 ②가 값으로 확인한다.
   */
  const known = new Set(["renderer/components/TaskCockpit.tsx"]);
  const unknown = indirect.filter((x) => !known.has(x.split(":")[0]));
  assert.deepEqual(unknown, [], `문구를 다른 곳에서 만들어 넘기는 대화상자가 새로 생겼습니다 — 그 만드는 함수를 이 게이트에서 실제로 불러 확인하세요:\n  ${unknown.join("\n  ")}`);
});

/* ② 문구를 만드는 함수를 **실제로 부른다**. */
function loadSurfaceApproval() {
  const js = ts.transpileModule(read("renderer/lib/surface-approval.ts"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText;
  const mod = { exports: {} };
  new Function("exports", "module", "require", js)(mod.exports, mod, require);
  return mod.exports.surfaceApprovalRequirement;
}

const paymentSubject = {
  id: "surface-1",
  manifest: {
    capabilities: [{ id: "checkout", type: "payment", approval: "once" }],
    budget: { currency: "USD", spent: 12, limit: 50, approvalThreshold: 10 },
    jobs: [],
  },
};
const paymentAction = {
  id: "act-1",
  label: "Buy the ticket",
  type: "request-payment-approval",
  permission: "full",
  payment: { merchant: "Acme", amount: 30, currency: "USD", recurrence: "once" },
};

check("★전제 — 승인 문구를 만드는 함수가 실제로 문구를 만든다", () => {
  const fn = loadSurfaceApproval();
  const en = fn(paymentSubject, paymentAction, "en");
  assert.ok(en && en.message.length > 40, "승인 문구가 만들어지지 않았습니다 — 픽스처가 관문을 못 넘고 있습니다");
  assert.equal(en.kind, "payment");
});

check("★결제·전체권한 승인 문구가 한국어로 나온다", () => {
  const fn = loadSurfaceApproval();
  const ko = fn(paymentSubject, paymentAction, "ko");
  assert.ok(HANGUL.test(ko.message), `한국어 승인 문구에 한글이 없습니다:\n${ko.message}`);
  assert.ok(!/needs Agentlas OS approval|Approve to continue\?/.test(ko.message),
    `한국어 승인 문구에 영어 원문이 남아 있습니다:\n${ko.message}`);
  const en = fn(paymentSubject, paymentAction, "en");
  assert.ok(!HANGUL.test(en.message), `영어 승인 문구에 한글이 섞였습니다:\n${en.message}`);
});

check("★언어가 달라도 승인 기록의 좌표(scopeKey)는 같다", () => {
  const fn = loadSurfaceApproval();
  // 언어에 따라 좌표가 갈리면 한 번 승인한 것을 언어 바꿀 때마다 다시 묻는다.
  assert.equal(
    fn(paymentSubject, paymentAction, "ko").scopeKey,
    fn(paymentSubject, paymentAction, "en").scopeKey,
  );
});

/* SELFTEST — 옛 고장을 주입해 이 게이트가 실제로 빨간불이 되는지 본다. */
check("SELFTEST 영어 전용 대화상자를 주입하면 잡힌다", () => {
  const injected = `const ok = window.confirm("Approve payment step?\\n\\nCard details stay in provider checkout.");`;
  const calls = dialogCalls(injected);
  assert.equal(calls.length, 1);
  assert.equal(localeAware(calls[0].arg), false);
});

check("SELFTEST 주석 속 대화상자는 세지 않는다", () => {
  assert.deepEqual(dialogCalls(`// window.confirm("English only")\n`), []);
  assert.deepEqual(dialogCalls(`/* window.alert("English only") */\n`), []);
});

check("SELFTEST 한국어 분기가 있으면 통과한다", () => {
  const good = `window.confirm(ko ? "삭제할까요?" : "Delete this?")`;
  assert.equal(localeAware(dialogCalls(good)[0].arg), true);
});

process.stdout.write(`native-dialogs-speak-the-users-language: ${checks} checks passed\n`);
