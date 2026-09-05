#!/usr/bin/env node
"use strict";

// 결과 레일이 "만든 적 없는 파일"을 산출물로 올리지 않는가.
//
// 배경(2026-09-05, 실제 claude-code 실행 실측). Work 한 턴이 파일 하나(hello.md)를
// 썼는데 결과 레일에는 hello.md 가 두 줄로 떴다. 한 줄은 도구 기록의 절대경로였고,
// 다른 한 줄은 답변 본문의 `hello.md` 를 **기본 실행 폴더**로 찍어 만든 경로라
// 디스크에 없었다. 산출물 목록이 존재하지 않는 파일을 보여주면 화면이 거짓말을 한다.
//
// 이 게이트는 문장을 대조하지 않는다 — 판정 함수를 실제로 부르고, 옛 고장을 주입해
// 빨간불까지 확인한다.
//
// 실행: node scripts/output-rail-shadow-contract.cjs

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const root = path.resolve(__dirname, "..");
const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "output-rail-shadow-"));
const compiled = spawnSync(
  path.join(root, "node_modules/.bin/tsc"),
  ["shared/tool-call-detail.ts", "--outDir", outDir, "--module", "commonjs", "--target", "es2022", "--skipLibCheck"],
  { cwd: root, encoding: "utf8" },
);
if (!fs.existsSync(path.join(outDir, "tool-call-detail.js"))) {
  throw new Error(`판정 모듈을 컴파일하지 못했다: ${compiled.stdout || compiled.stderr}`);
}
const { shadowsToolRecordedPath } = require(path.join(outDir, "tool-call-detail.js"));

const RECORDED = ["/private/tmp/work-real-project/hello.md"];
const checks = [];
const check = (name, fn) => {
  try { fn(); checks.push(["PASS", name, ""]); } catch (error) { checks.push(["FAIL", name, error.message]); }
};

check("1) 실행 폴더를 잘못 찍은 같은 이름은 그림자다 — 레일에 올리면 없는 파일이 뜬다", () => {
  assert.equal(shadowsToolRecordedPath("/tmp/qa-profile/agent-cwd/hello.md", RECORDED), true);
});
check("2) 도구가 기록한 바로 그 경로는 그림자가 아니다 (/private 접두는 같은 파일)", () => {
  assert.equal(shadowsToolRecordedPath("/private/tmp/work-real-project/hello.md", RECORDED), false);
  assert.equal(shadowsToolRecordedPath("/tmp/work-real-project/hello.md", RECORDED), false);
});
check("3) 도구가 손대지 않은 다른 이름은 그대로 살린다 — 과잉 차단은 산출물을 지운다", () => {
  assert.equal(shadowsToolRecordedPath("/tmp/qa-profile/agent-cwd/guide.md", RECORDED), false);
  assert.equal(shadowsToolRecordedPath("/tmp/anything/report.pdf", []), false);
});
check("4) 경로가 없는 참조는 판정 대상이 아니다", () => {
  for (const value of [undefined, null, ""]) {
    assert.equal(shadowsToolRecordedPath(value, RECORDED), false, `입력 ${String(value)}`);
  }
});
check("5) 옛 고장(그림자를 그대로 통과시키던 판정)은 이 계약을 못 지난다", () => {
  const buggy = () => false;
  assert.notEqual(buggy("/tmp/qa-profile/agent-cwd/hello.md", RECORDED), true,
    "sanity: 옛 판정은 항상 false 였다");
  assert.equal(shadowsToolRecordedPath("/tmp/qa-profile/agent-cwd/hello.md", RECORDED), true,
    "지금 판정은 그림자를 잡아야 한다");
});

fs.rmSync(outDir, { recursive: true, force: true });
for (const [status, name, detail] of checks) console.log(`${status} ${name}${detail ? ` — ${detail}` : ""}`);
const failed = checks.filter(([status]) => status === "FAIL");
if (failed.length > 0) process.exit(1);
console.log(`PASS output-rail-shadow-contract (${checks.length} checks)`);
