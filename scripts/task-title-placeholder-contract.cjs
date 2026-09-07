#!/usr/bin/env node
"use strict";
/*
 * 엔진이 새 작업에 붙이는 제목은 **자리표시자로 인식돼야 한다** — 계약.
 *
 * ★왜 (QA 실측 2026-09-08): 한국어 화면에 "New task" 가 그대로 떴다.
 *
 *   엔진(electron/ipc.ts "tasks:createProject")이 제목으로 **영어 문자열 "New task"** 를
 *   저장한다. 그런데 화면은
 *       {task.title || (ko ? "새 작업" : "New task")}
 *   처럼 썼다. "New task" 는 빈 문자열이 아니므로 **폴백이 영원히 안 걸린다.**
 *   소스만 보면 번역돼 있는 것처럼 보이는 것이 이 결함이 오래 남은 이유다.
 *
 * 그래서 두 가지를 값으로 단언한다:
 *   ① 엔진이 실제로 쓰는 기본 제목이 화면의 자리표시자 목록에 들어 있다.
 *   ② 그 목록은 한 곳에만 있다(사본이 둘이면 반드시 갈라진다).
 */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const ts = require("typescript");

const root = path.resolve(__dirname, "..");
const read = (rel) => fs.readFileSync(path.join(root, rel), "utf8");

const src = read("renderer/lib/task-title.ts");
const js = ts.transpileModule(src, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
}).outputText;
const mod = { exports: {} };
new Function("exports", "module", "require", js)(mod.exports, mod, require);
const { isPlaceholderTaskTitle, taskTitleForDisplay } = mod.exports;

let checks = 0;
const check = (name, fn) => { fn(); checks += 1; process.stdout.write(`  ok  ${name}\n`); };

/** 엔진 소스에서 새 작업의 기본 제목을 **읽어 온다**(손으로 옮겨 적지 않는다). */
function engineDefaultTitles() {
  const ipc = read("electron/ipc.ts").replace(/\/\*[\s\S]*?\*\//g, "");
  const found = new Set();
  // `: "New task"` 꼴의 기본값 — createProject / createChat 근처만 본다.
  for (const m of ipc.matchAll(/tasks:createProject[\s\S]{0,1600}?/g)) {
    const block = ipc.slice(m.index, m.index + 1600);
    for (const t of block.matchAll(/:\s*"([^"]{2,40})"\s*[,;)\n]/g)) {
      if (/^(task|work|project|user|assistant|system|one)$/i.test(t[1])) continue;
      if (/^[a-z-]+$/.test(t[1])) continue; // 식별자·모드 값
      found.add(t[1]);
    }
  }
  return [...found];
}

check("★전제 — 엔진 소스에서 기본 제목을 실제로 읽어 왔다", () => {
  const titles = engineDefaultTitles();
  assert.ok(titles.length > 0, "electron/ipc.ts 에서 기본 제목 후보를 하나도 못 읽었습니다 — 이 게이트는 아무것도 안 재고 있습니다");
  assert.ok(titles.includes("New task"), `기대한 기본 제목을 못 찾았습니다: ${JSON.stringify(titles)}`);
});

check("★엔진이 저장하는 기본 제목이 자리표시자로 인식된다", () => {
  for (const title of engineDefaultTitles()) {
    assert.equal(
      isPlaceholderTaskTitle(title), true,
      `엔진이 "${title}" 를 제목으로 저장하는데 화면은 그것을 이름으로 봅니다 — 한국어 화면에 그대로 뜹니다`,
    );
  }
});

check("★자리표시자는 그 화면의 언어로 바뀐다", () => {
  assert.equal(taskTitleForDisplay("New task", true), "새 작업");
  assert.equal(taskTitleForDisplay("New task", false), "New task");
  assert.equal(taskTitleForDisplay("", true), "새 작업");
  assert.equal(taskTitleForDisplay(null, true), "새 작업");
  // 사람이 붙인 이름은 건드리지 않는다.
  assert.equal(taskTitleForDisplay("New task pricing research", true), "New task pricing research");
  assert.equal(taskTitleForDisplay("  거실 공기청정기  ", true), "거실 공기청정기");
});

check("★목록이 한 곳에만 있다(사본 금지)", () => {
  const files = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === "node_modules" || entry.name.startsWith(".next") || entry.name === "private") continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.tsx?$/.test(entry.name)) files.push(full);
    }
  };
  walk(path.join(root, "renderer"));
  const copies = files.filter((file) => {
    if (file.endsWith(path.join("lib", "task-title.ts"))) return false;
    const text = fs.readFileSync(file, "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
    // 같은 목록을 손으로 다시 적은 자리
    return /\["",\s*"새 채팅"/.test(text);
  });
  assert.deepEqual(copies.map((f) => path.relative(root, f)), [],
    "자리표시자 목록의 사본이 있습니다 — 목록이 둘이면 반드시 갈라집니다");
});

check("★고장 주입 — 옛 판정('비었는가')이 이 검사에 실제로 걸린다", () => {
  const oldWay = (title, ko) => title || (ko ? "새 작업" : "New task");
  assert.equal(oldWay("New task", true), "New task", "옛 방식이 이미 한국어를 낸다면 이 게이트는 헛돕니다");
  assert.notEqual(taskTitleForDisplay("New task", true), oldWay("New task", true));
});

process.stdout.write(`\ntask-title-placeholder-contract: ${checks} checks passed\n`);
