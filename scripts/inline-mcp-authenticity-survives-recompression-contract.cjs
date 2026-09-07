#!/usr/bin/env node
"use strict";
/*
 * 내장 MCP 서버의 진위 판정은 **압축 바이트가 아니라 소스 해시**로 한다.
 *
 * ★왜 (실측 2026-09-07, 오너: "아니 컴퓨터 유즈를 못하네 … 아직도 컴퓨터 유즈나
 *   브라우저 조작을 못해?"):
 *
 *   설치된 cua-driver 행과 현재 빌드를 실제로 대조했다.
 *     압축해제 소스 sha256   현재 2c22587e…5020  ==  저장 2c22587e…5020   (바이트까지 동일)
 *     base64 압축 payload    현재 6372자          !=  저장 6424자
 *
 *   **gzip 출력은 재현되지 않는다.** zlib 버전이 바뀌면 같은 소스가 다른 바이트가 된다.
 *   그런데 진위 판정이 인자 배열을 **글자 단위로** 비교하고 있었다. 그래서 앱을
 *   업데이트하면 설치된 서버가 "위조"로 걸리고 MCP 설정에서 통째로 빠진다 —
 *   화면에는 아무 오류도 안 뜬다. 그냥 컴퓨터 유즈가 없어진다. One 도 Work 도.
 *
 * 이 게이트는 **재압축한 payload 가 통과하는지**(회귀의 정체)와 **위조는 여전히
 * 거절하는지**(수리가 판정을 약하게 만들지 않았는지)를 둘 다 값으로 단언한다.
 */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const zlib = require("node:zlib");

const root = path.resolve(__dirname, "..");
const dist = (rel) => path.join(root, "dist/electron", rel);
for (const file of ["computer-use/mcp-server.js", "mcp-tools/system-time-server.js"]) {
  assert.ok(fs.existsSync(dist(file)), `dist 가 없습니다(${file}) — tsc -p electron/tsconfig.json`);
}

const SUBJECTS = [
  {
    label: "컴퓨터 유즈(cua-driver)",
    module: require(dist("computer-use/mcp-server.js")),
    launch: "computerUseMcpLaunchArgs",
    authentic: "isAuthenticComputerUseMcpLaunch",
  },
  {
    label: "시스템 시간(system-time)",
    module: require(dist("mcp-tools/system-time-server.js")),
    launch: "systemTimeMcpLaunchArgs",
    authentic: "isAuthenticSystemTimeMcpLaunch",
  },
];

let checks = 0;
const check = (name, fn) => { fn(); checks += 1; process.stdout.write(`  ok  ${name}\n`); };

for (const subject of SUBJECTS) {
  const args = subject.module[subject.launch]();
  const isAuthentic = (a) => subject.module[subject.authentic](process.execPath, a);
  const source = zlib.gunzipSync(Buffer.from(args[2], "base64"));

  check(`${subject.label} — 오늘 빌드의 인자는 통과한다`, () => {
    assert.equal(isAuthentic(args), true, "자기 자신을 위조로 판정합니다");
  });

  check(`★${subject.label} — 압축 방식이 달라도 같은 소스면 통과한다(이게 깨져 있었다)`, () => {
    // 같은 소스를 다른 압축 수준으로 다시 압축한다 = 다른 바이트, 같은 코드.
    // 앱 업데이트로 zlib 이 바뀌면 실제로 이 상황이 된다.
    for (const level of [1, 6]) {
      const repacked = zlib.gzipSync(source, { level }).toString("base64");
      assert.notEqual(repacked, args[2], `전제 확인 실패: level=${level} 압축이 원본과 같습니다`);
      assert.equal(
        isAuthentic(["-e", args[1], repacked]),
        true,
        `재압축한 같은 코드를 위조로 판정합니다 — 앱 업데이트 한 번에 이 기능이 사라집니다(level=${level})`,
      );
    }
  });

  check(`${subject.label} — 남의 코드는 거절한다`, () => {
    const evil = zlib.gzipSync(Buffer.from("require('node:child_process').execSync('id')")).toString("base64");
    assert.equal(isAuthentic(["-e", args[1], evil]), false, "다른 소스를 실행하는 인자를 통과시켰습니다");
  });

  check(`${subject.label} — 부트스트랩 변조는 거절한다(해시 핀이 거기 박혀 있다)`, () => {
    assert.equal(isAuthentic(["-e", "console.log(1)", args[2]]), false, "검증기를 갈아치운 인자를 통과시켰습니다");
  });

  check(`${subject.label} — 실행 파일이 다르면 거절한다`, () => {
    assert.equal(subject.module[subject.authentic]("/bin/ls", args), false);
    assert.equal(subject.module[subject.authentic](null, args), false);
  });

  check(`${subject.label} — 인자 모양이 다르면 거절한다`, () => {
    assert.equal(isAuthentic([]), false);
    assert.equal(isAuthentic(["-e", args[1]]), false);
    assert.equal(isAuthentic(["--eval", args[1], args[2]]), false, "-e 가 아닌 실행 형태를 통과시켰습니다");
    assert.equal(isAuthentic(["-e", args[1], args[2], "extra"]), false);
  });

  check(`${subject.label} — 못 푸는 payload 는 조용히 통과시키지 않는다`, () => {
    assert.equal(isAuthentic(["-e", args[1], "not-base64-gzip"]), false);
    assert.equal(isAuthentic(["-e", args[1], ""]), false);
  });
}

check("★고장 주입 — 옛 판정(압축 바이트 비교)이 이 검사에 실제로 걸린다", () => {
  const subject = SUBJECTS[0];
  const args = subject.module[subject.launch]();
  const source = zlib.gunzipSync(Buffer.from(args[2], "base64"));
  // 수리 전 코드를 그대로 재현한다.
  const oldAuthentic = (command, given) =>
    Boolean(command) && path.resolve(command) === path.resolve(process.execPath)
    && given.length === args.length && given.every((arg, index) => arg === args[index]);
  const repacked = zlib.gzipSync(source, { level: 1 }).toString("base64");
  assert.equal(
    oldAuthentic(process.execPath, ["-e", args[1], repacked]),
    false,
    "옛 판정도 재압축을 통과시킨다면 이 게이트는 있지도 않은 결함을 재고 있다",
  );
});

process.stdout.write(`\ninline-mcp-authenticity-survives-recompression-contract: ${checks} checks passed\n`);
