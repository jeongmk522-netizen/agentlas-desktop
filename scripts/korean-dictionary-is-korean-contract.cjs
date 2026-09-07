#!/usr/bin/env node
"use strict";
/*
 * 한국어 사전에 **영어가 그대로 들어 있으면** 안 된다 — 계약.
 *
 * ★왜 (실측 2026-09-08): QA 가 "New task 가 한국어 화면에 뜬다"를 올렸다. 화면을 훑어
 *   고쳤는데, 화면에 안 뜨는 자리에도 같은 것이 남아 있었다. 사전을 직접 재니 16건이었고
 *   그중 10건이 진짜였다(사이드바 "Apps", 채팅 빈 상태의 "Commands"/"Agents"/"Context",
 *   "tokens" …). **화면을 띄우는 검사는 자기가 띄운 화면만 본다** — 사전은 정적으로 못박는다.
 *
 * 판정: ko 값에 한글이 하나도 없고 라틴 글자가 있으며, **en 값과 글자까지 같은** 항목.
 *   ko 와 en 이 다르면 의도적으로 다르게 쓴 것일 수 있으므로 건드리지 않는다.
 *
 * 영어가 정답인 것들(제품명·약어·순수 치환 문구)은 이유와 함께 허용 목록에 둔다.
 */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const source = fs.readFileSync(path.join(root, "renderer/lib/i18n.tsx"), "utf8");
const lines = source.split("\n");
const koStart = lines.findIndex((line) => line.startsWith("  ko: {"));
const enStart = lines.findIndex((line) => line.startsWith("  en: {"));
assert.ok(koStart >= 0 && enStart > koStart, "사전의 ko/en 경계를 못 찾았습니다 — 이 검사의 전제가 깨졌습니다");

function readDict(from, to) {
  const out = {};
  for (let i = from; i < to; i += 1) {
    const m = /^\s*"([^"]+)":\s*"((?:[^"\\]|\\.)*)"/.exec(lines[i]);
    if (m) out[m[1]] = m[2];
  }
  return out;
}
const ko = readDict(koStart, enStart);
const en = readDict(enStart, lines.length);

/** 영어가 정답인 값. 값이 아니라 **이유**를 함께 적는다. */
const ALLOWED = new Map([
  ["settings.lang.en", "언어 이름 자체 — 한국어로 옮기면 무엇을 고르는지 알 수 없다"],
  ["nav.agent_hub", "제품 이름"],
  ["one.sug.hub.eyebrow", "제품 이름"],
  ["sidebar.backend_label", "약어(LLM)"],
  ["auto.row.schedule_with", "치환 자리만 있는 형식 문자열"],
  ["common.created_at", "치환 자리만 있는 형식 문자열"],
]);

const HANGUL = /[가-힣]/;
const LATIN = /[A-Za-z]/;
const PRODUCT = /^(Agentlas|One|Work|Science|Hub|Cargo|Codex|Claude|MCP|API|CLI|URL|ID|AI|UI|OS|PDF|CSV|JSON|GPU|CPU|SSH|HTTP|IP|DNS|QA|Graph|Plugin)\b/i;

let checks = 0;
const check = (name, fn) => { fn(); checks += 1; process.stdout.write(`  ok  ${name}\n`); };

function untranslated() {
  const out = [];
  for (const [key, value] of Object.entries(ko)) {
    if (HANGUL.test(value) || !LATIN.test(value)) continue;
    if (value !== en[key]) continue;
    if (value.trim().length < 3) continue;
    if (PRODUCT.test(value.trim())) continue;
    if (ALLOWED.has(key)) continue;
    out.push(`${key} = ${JSON.stringify(value)}`);
  }
  return out;
}

check("전제 — 사전을 실제로 읽어 왔다", () => {
  assert.ok(Object.keys(ko).length > 500, `ko 사전이 ${Object.keys(ko).length}개뿐입니다 — 파싱이 깨졌습니다`);
  assert.equal(Object.keys(ko).length, Object.keys(en).length, "ko/en 키 수가 다릅니다");
});

check("★한국어 사전에 영어가 그대로 든 항목이 없다", () => {
  assert.deepEqual(
    untranslated(), [],
    "한국어 화면에 영어가 그대로 뜹니다. 옮기거나, 영어가 정답이면 이유와 함께 허용 목록에 넣으세요.",
  );
});

check("허용 목록은 실재하는 키만 가리킨다(죽은 예외 금지)", () => {
  for (const [key, why] of ALLOWED) {
    assert.ok(key in ko, `허용 목록이 없는 키를 가리킵니다: ${key}`);
    assert.ok(why.trim().length > 4, `${key} 의 허용 이유가 비어 있습니다`);
  }
});

check("★고장 주입 — 옛 값(\"Apps\")이 실제로 걸린다", () => {
  const saved = ko["sidebar.apps"];
  assert.ok(saved !== undefined, "검사 대상 키가 사라졌습니다");
  ko["sidebar.apps"] = en["sidebar.apps"];
  const caught = untranslated();
  ko["sidebar.apps"] = saved;
  assert.ok(
    caught.some((row) => row.startsWith("sidebar.apps")),
    "영어를 그대로 넣어도 안 걸립니다 — 이 검사는 아무것도 재고 있지 않습니다",
  );
});

check("의도적으로 두 언어가 다른 값은 건드리지 않는다", () => {
  // ko 와 en 이 다르면(예: 이미 번역된 자리) 이 검사에 걸리면 안 된다.
  const sample = Object.entries(ko).find(([key, value]) => en[key] && en[key] !== value && !HANGUL.test(en[key]));
  assert.ok(sample, "ko/en 이 다른 항목을 못 찾았습니다 — 전제 확인 실패");
  assert.ok(!untranslated().includes(`${sample[0]} = ${JSON.stringify(sample[1])}`));
});

process.stdout.write(`\nkorean-dictionary-is-korean-contract: ${checks} checks passed\n`);
