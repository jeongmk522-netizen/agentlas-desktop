#!/usr/bin/env node
"use strict";
/*
 * 아이콘만 있는 단추는 **읽을 이름**이 있어야 한다 — 계약.
 *
 * ★왜 (실측 2026-09-08): 글자 없이 아이콘 하나만 든 단추가 6곳 있었고, 그중 하나는
 *   **조직을 지우는 단추**였다. 이름이 없으면 화면 낭독기는 물론 마우스를 올려도
 *   무엇인지 알 수 없다 — 지우는 단추를 짐작으로 누르게 된다.
 *
 * 판정: `<button>` 의 본문에서 아이콘 요소를 지웠을 때 **아무것도 안 남고**,
 *   여는 태그에 aria-label / aria-labelledby / title 이 없는 것.
 *   글자든 `{변수}` 든 남아 있으면 읽을 것이 있는 것이므로 대상이 아니다.
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

/** 여는 태그를 중괄호 깊이까지 세면서 정확히 자른다(`disabled={a > b}` 의 `>` 에 속지 않는다). */
function openTag(src, start) {
  let i = start, depth = 0, quote = null;
  while (i < src.length) {
    const c = src[i];
    if (quote) { if (c === quote && src[i - 1] !== "\\") quote = null; i++; continue; }
    if (c === '"' || c === "'" || c === "`") { quote = c; i++; continue; }
    if (c === "{") depth++;
    else if (c === "}") depth--;
    else if (c === ">" && depth === 0) return { tag: src.slice(start, i + 1), end: i + 1 };
    i++;
  }
  return null;
}

function unnamedIconButtons(sources) {
  const out = [];
  for (const [rel, src] of sources) {
    let idx = 0;
    while ((idx = src.indexOf("<button", idx)) !== -1) {
      const at = idx;
      const open = openTag(src, idx);
      idx += 7;
      if (!open) continue;
      if (/aria-label|aria-labelledby|title=/.test(open.tag)) continue;
      const close = src.indexOf("</button>", open.end);
      if (close < 0) continue;
      const body = src.slice(open.end, close);
      if (body.includes("<button")) continue; // 중첩은 바깥 단추가 따로 잡힌다
      const stripped = body
        .replace(/<Icon\w*\b[^>]*\/>/g, "")
        .replace(/<svg[\s\S]*?<\/svg>/g, "")
        .replace(/\{\s*\/\*[\s\S]*?\*\/\s*\}/g, "")
        .replace(/\s+/g, "");
      if (stripped !== "") continue;
      if (!/<Icon\w|<svg/.test(body)) continue;
      out.push(`${rel}:${src.slice(0, at).split("\n").length}`);
    }
  }
  return out;
}

const sources = files.map((rel) => [rel, fs.readFileSync(path.join(root, rel), "utf8")]);

let checks = 0;
const check = (name, fn) => { fn(); checks += 1; process.stdout.write(`  ok  ${name}\n`); };

check("전제 — 단추를 실제로 훑어 왔다", () => {
  const total = sources.reduce((n, [, src]) => n + (src.match(/<button/g) ?? []).length, 0);
  assert.ok(total > 300, `단추를 ${total}개만 찾았습니다 — 스캔이 깨졌습니다`);
});

check("★아이콘만 있는 단추에 읽을 이름이 없는 곳이 없다", () => {
  assert.deepEqual(
    unnamedIconButtons(sources), [],
    "아이콘만 있고 이름이 없는 단추입니다 — 무엇을 하는 단추인지 알 방법이 없습니다.\n"
      + "aria-label 과 title 을 주세요(토글이면 지금 상태를 말하게).",
  );
});

check("★고장 주입 — 이름 없는 아이콘 단추가 실제로 걸린다", () => {
  const broken = [["fake.tsx", `<button onClick={x}>\n  <IconTrash size={16} />\n</button>`]];
  assert.equal(unnamedIconButtons(broken).length, 1, "이름 없는 것을 못 잡으면 이 검사는 헛돕니다");
  const named = [["fake.tsx", `<button onClick={x} aria-label="지우기">\n  <IconTrash size={16} />\n</button>`]];
  assert.equal(unnamedIconButtons(named).length, 0, "이름이 있는 것을 결함으로 셉니다");
  const withText = [["fake.tsx", `<button onClick={x}>\n  <IconTrash size={16} /> 지우기\n</button>`]];
  assert.equal(unnamedIconButtons(withText).length, 0, "글자가 있는 단추를 결함으로 셉니다");
});

process.stdout.write(`\nicon-only-buttons-have-a-name-contract: ${checks} checks passed\n`);
