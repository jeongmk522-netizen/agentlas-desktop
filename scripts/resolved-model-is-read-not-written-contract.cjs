#!/usr/bin/env node
"use strict";
/*
 * 모델 세대는 **읽어서** 안다 — 코드에 적어 두지 않는다.
 *
 * ★왜 있나 (오너 2026-09-07): "왜 클로드는 opus 5.0이 아니고 opus라고 나오냐",
 *   그리고 "버전 바뀌어도 알아서 읽게 해라".
 *
 *   claude-code 에는 모델 목록 명령이 없다(electron/runtime/detect.ts 가
 *   `no-list-concept:cli-aliases` 로 명시). 그래서 우리가 보낼 수 있는 것은 벤더 별칭
 *   `opus|sonnet|haiku|fable` 뿐이고, 화면에도 그것만 보였다.
 *
 *   버전을 shared/models.ts 에 적어 두는 것은 답이 아니다 — 벤더가 세대를 올리는 순간
 *   거짓이 된다(같은 파일에 2026-07-28 실측 교훈이 이미 있다: 하드코딩 폴백은
 *   opus/sonnet/haiku 뿐인데 `--model fable` 이 정상 동작했다).
 *
 *   실측한 사실: claude 2.1.263 의 result 이벤트가 실제 모델을 싣고 온다.
 *     {"type":"result", …, "modelUsage":{"claude-opus-5[1m]":{…토큰…}}}
 *   그것을 읽어 별칭에 붙이면 세대가 바뀌어도 저절로 따라간다.
 */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const dist = (rel) => path.join(root, "dist/electron", rel);
assert.ok(fs.existsSync(dist("runtime/claude-code.js")), "dist 가 없습니다 — tsc -p electron/tsconfig.json");

const { observedClaudeModelId } = require(dist("runtime/claude-code.js"));
const models = require(path.join(root, "dist/shared/models.js"));

let checks = 0;
const check = (name, fn) => { fn(); checks += 1; process.stdout.write(`  ok  ${name}\n`); };

check("★실측 스트림에서 실제 모델 id 를 읽는다(컨텍스트 표식은 잘라낸다)", () => {
  // 2026-09-07 실측 그대로.
  assert.equal(
    observedClaudeModelId({
      "claude-opus-5[1m]": {
        inputTokens: 4, outputTokens: 93, cacheReadInputTokens: 26421, cacheCreationInputTokens: 6278,
      },
    }),
    "claude-opus-5",
  );
  assert.equal(observedClaudeModelId({ "claude-sonnet-5": { inputTokens: 10, outputTokens: 2 } }), "claude-sonnet-5");
});

check("★세대가 올라가도 코드를 안 고쳐도 된다 — 아직 존재하지 않는 이름도 그대로 읽는다", () => {
  // 이 게이트의 요지. 어휘 목록이 아니라 벤더가 준 문자열을 그대로 쓴다.
  assert.equal(observedClaudeModelId({ "claude-opus-9-future[200k]": { outputTokens: 1 } }), "claude-opus-9-future");
});

check("여러 모델이 섞이면 토큰을 가장 많이 쓴 쪽이 이 턴의 모델이다", () => {
  assert.equal(
    observedClaudeModelId({
      "claude-haiku-4-5": { inputTokens: 5, outputTokens: 5 },
      "claude-opus-5[1m]": { inputTokens: 900, outputTokens: 100 },
    }),
    "claude-opus-5",
  );
});

check("모르면 null — 짐작해서 채우지 않는다", () => {
  for (const bad of [undefined, null, {}, [], "claude-opus-5", 42, { "": {} }, { "a b": {} }]) {
    assert.equal(observedClaudeModelId(bad), null, `${JSON.stringify(bad)} 에서 값을 지어냈다`);
  }
});

check("별칭 레지스트리는 관측값만 붙이고, 같은 값이면 아무 말도 안 한다", () => {
  const before = models.cliModels("claude-code");
  const opusBefore = before.find((item) => item.id === "opus");
  assert.ok(opusBefore, "전제 확인: claude-code 목록에 opus 별칭이 있다");
  assert.equal(opusBefore.resolvedId, undefined, "전제 확인: 관측 전에는 세대를 모른다");

  models.setResolvedCliModelAlias("claude-code", "opus", "claude-opus-5");
  const opusAfter = models.cliModels("claude-code").find((item) => item.id === "opus");
  assert.equal(opusAfter.resolvedId, "claude-opus-5", "관측한 세대가 목록에 안 붙는다");
  assert.equal(
    models.cliModels("claude-code").find((item) => item.id === "sonnet").resolvedId,
    undefined,
    "관측하지 않은 별칭에까지 값이 붙었다",
  );

  // 별칭과 같은 값이면 덧붙일 것이 없다(화면에 "opus · opus" 가 되면 안 된다).
  models.setResolvedCliModelAlias("claude-code", "opus", "opus");
  assert.equal(models.cliModels("claude-code").find((item) => item.id === "opus").resolvedId, undefined);

  // 세대가 올라가면 다음 관측이 그냥 덮는다 — 우리가 손댈 곳이 없다.
  models.setResolvedCliModelAlias("claude-code", "opus", "claude-opus-5");
  models.setResolvedCliModelAlias("claude-code", "opus", "claude-opus-6");
  assert.equal(models.cliModels("claude-code").find((item) => item.id === "opus").resolvedId, "claude-opus-6");
});

check("★버전을 코드에 적어 두지 않는다 — 별칭 목록에 세대 번호가 없어야 한다", () => {
  const source = fs.readFileSync(path.join(root, "shared/models.ts"), "utf8");
  const start = source.indexOf('"claude-code": [');
  assert.ok(start > 0, "claude-code 별칭 목록을 찾지 못했습니다");
  const block = source.slice(start, source.indexOf("],", start));
  const versioned = block.split("\n").filter((line) =>
    !/^\s*(\/\/|\*|\/\*)/.test(line) && /claude-(opus|sonnet|haiku)-\d/.test(line));
  assert.deepEqual(
    versioned,
    [],
    `별칭 목록에 세대가 박혀 있습니다 — 벤더가 올리는 순간 거짓이 됩니다:\n${versioned.join("\n")}`,
  );
});

check("★고장 주입 — 위 검사가 실제로 빨간불이 된다", () => {
  const broken = 'x "claude-code": [\n    { id: "opus", label: "Opus 5.0", model: "claude-opus-5-20260101" },\n  ],';
  const block = broken.slice(broken.indexOf('"claude-code": ['), broken.indexOf("],"));
  const versioned = block.split("\n").filter((line) =>
    !/^\s*(\/\/|\*|\/\*)/.test(line) && /claude-(opus|sonnet|haiku)-\d/.test(line));
  assert.equal(versioned.length, 1, "하드코딩된 세대를 스캔이 못 잡았다 — 이 검사는 헛돈다");
});

check("실행이 세대를 알려주면 러너가 그것을 결과에 싣는다", () => {
  const runner = fs.readFileSync(path.join(root, "electron/runtime/claude-code.ts"), "utf8");
  const code = runner.split("\n").filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line));
  assert.ok(
    code.some((line) => /observedModel = observedClaudeModelId\(ev\.modelUsage\)/.test(line)),
    "result 이벤트에서 모델을 읽지 않습니다",
  );
  assert.ok(
    code.filter((line) => /observedModel \? \{ observedModel \}/.test(line)).length >= 2,
    "성공·실패 두 반환 경로 모두에 싣지 않습니다 — 한도로 끝난 턴도 세대는 알려 준다",
  );
});

process.stdout.write(`\nresolved-model-is-read-not-written-contract: ${checks} checks passed\n`);
