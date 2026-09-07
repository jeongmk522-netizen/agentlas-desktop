#!/usr/bin/env node
"use strict";
/*
 * 실행이 끝나면 알린다 — 계약.
 *
 * ★왜 (오너 2026-09-07): "설정에 알람 만들어라 작업 완료되거나 턴 종료되면 알람 나오게",
 *   "소리알람, 그냥 앱 흔들리기 등등 (윈도우도 다 되야한다)".
 *
 * ★이 게이트의 요지 둘:
 *   ① 판단(언제 울릴지)을 **값으로** 단언한다. 알림 배관 없이 순수 함수로 검사된다.
 *   ② **윈도우 경로가 실제로 다른 API 를 부르는지** 본다. "앱 흔들기"는 OS마다 이름이
 *      다르고(dock.bounce vs flashFrame), 하나만 부르면 다른 OS 에서 조용히 아무 일도
 *      안 한다 — 그리고 그 침묵은 화면에 안 보인다. 오너가 "윈도우도 다 되야한다"고
 *      한 것이 정확히 이 계열이다.
 */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const Module = require("node:module");

const root = path.resolve(__dirname, "..");
const distPath = path.join(root, "dist/electron/run-alerts.js");
assert.ok(fs.existsSync(distPath), "dist 가 없습니다 — tsc -p electron/tsconfig.json");

/*
 * electron 은 이 검사에 없다. 대신 **호출 기록을 남기는 가짜**를 끼워, 어느 API 가
 * 실제로 불렸는지 값으로 확인한다(소스 문자열 스캔보다 강하다).
 */
const calls = { bounce: 0, flash: 0, notifications: [] };
const fakeWindow = { flashFrame: (on) => { if (on) calls.flash += 1; } };
const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === "electron") {
    return {
      app: {
        // dock 은 macOS 에만 존재한다. 아래에서 플랫폼을 바꿔 가며 이 사실을 재현한다.
        get dock() {
          return process.platform === "darwin" ? { bounce: () => { calls.bounce += 1; } } : undefined;
        },
        getLocale: () => "en-US",
      },
      BrowserWindow: { getAllWindows: () => [fakeWindow] },
      Notification: class {
        constructor(options) { this.options = options; }
        static isSupported() { return true; }
        on() { return this; }
        show() { calls.notifications.push(this.options); }
      },
    };
  }
  if (request.endsWith("store/meta")) return { getMeta: () => null, setMeta: () => undefined };
  return originalLoad.call(this, request, parent, isMain);
};
const alerts = require(distPath);
Module._load = originalLoad;

let checks = 0;
const check = (name, fn) => { fn(); checks += 1; process.stdout.write(`  ok  ${name}\n`); };
const settings = (patch) => ({ ...alerts.DEFAULT_RUN_ALERTS, ...patch });

check("★상태 어휘가 제품 타입과 같다 — 지어낸 이름이면 알림이 영영 안 나온다", () => {
  // shared/types.ts 의 InvocationRunStatus 가 정본. 처음에 "succeeded" 로 지어 썼다가
  // 실제로는 "completed" 라서 조용히 항상 안 울릴 뻔했다.
  const source = fs.readFileSync(path.join(root, "shared/types.ts"), "utf8");
  const block = source.slice(source.indexOf("export type InvocationRunStatus ="));
  const vocabulary = block.slice(0, block.indexOf(";")).match(/"[a-z_]+"/g).map((item) => item.slice(1, -1));
  assert.ok(vocabulary.includes("completed"), `전제 확인 실패: 어휘가 바뀌었습니다 (${vocabulary.join(",")})`);
  assert.equal(
    alerts.decideRunAlert(settings({ minSeconds: 0 }), { status: "completed", focused: false }).alert,
    true,
    "정상 완료를 종료로 인식하지 못합니다 — 알림이 영영 안 나옵니다",
  );
  assert.equal(alerts.decideRunAlert(settings({}), { status: "running", focused: false }).alert, false);
  assert.equal(alerts.decideRunAlert(settings({}), { status: "cancelling", focused: false }).alert, false);
});

check("꺼져 있으면 아무 일도 하지 않는다", () => {
  const verdict = alerts.decideRunAlert(settings({ enabled: false }), { status: "completed", focused: false });
  assert.deepEqual(verdict, { alert: false, reason: "disabled" });
});

check("보고 있는 창에는 알리지 않는다(기본) — 소음이 되면 사용자가 꺼 버린다", () => {
  assert.equal(alerts.decideRunAlert(settings({}), { status: "completed", focused: true }).reason, "focused");
  // 사용자가 원하면 언제나 울린다.
  assert.equal(
    alerts.decideRunAlert(settings({ onlyWhenUnfocused: false, minSeconds: 0 }), { status: "completed", focused: true }).alert,
    true,
  );
});

check("★짧은 턴은 조용하지만, 실패와 입력 대기는 길이와 무관하게 알린다", () => {
  const short = { startedAt: "2026-09-07T00:00:00.000Z", finishedAt: "2026-09-07T00:00:03.000Z", focused: false };
  assert.equal(alerts.decideRunAlert(settings({ minSeconds: 20 }), { ...short, status: "completed" }).reason, "too-short");
  // 짧게 실패한 실행이야말로 사람이 모르면 그대로 멈춰 있는다.
  assert.equal(alerts.decideRunAlert(settings({ minSeconds: 20 }), { ...short, status: "failed" }).kind, "failed");
  assert.equal(
    alerts.decideRunAlert(settings({ minSeconds: 20 }), { ...short, status: "completed", pendingQuestion: true }).kind,
    "attention",
  );
  // 긴 실행은 그대로 알린다.
  assert.equal(
    alerts.decideRunAlert(settings({ minSeconds: 20 }), {
      status: "completed", focused: false,
      startedAt: "2026-09-07T00:00:00.000Z", finishedAt: "2026-09-07T00:01:00.000Z",
    }).kind,
    "done",
  );
});

check("시간을 모르면 삼키지 않는다 — 모르는 것을 짧다고 단정하지 않는다", () => {
  assert.equal(alerts.decideRunAlert(settings({ minSeconds: 60 }), { status: "completed", focused: false }).alert, true);
});

check("저장값은 무엇이 들어와도 좁혀서 읽는다", () => {
  assert.deepEqual(alerts.normalizeRunAlerts(null), alerts.DEFAULT_RUN_ALERTS);
  assert.deepEqual(alerts.normalizeRunAlerts("nonsense"), alerts.DEFAULT_RUN_ALERTS);
  assert.equal(alerts.normalizeRunAlerts({ minSeconds: -5 }).minSeconds, 0);
  assert.equal(alerts.normalizeRunAlerts({ minSeconds: 99999 }).minSeconds, 600, "상한이 없으면 알림을 영영 안 나오게 만들 수 있다");
  assert.equal(alerts.normalizeRunAlerts({ minSeconds: "abc" }).minSeconds, alerts.DEFAULT_RUN_ALERTS.minSeconds);
  assert.equal(alerts.normalizeRunAlerts({ enabled: "yes" }).enabled, alerts.DEFAULT_RUN_ALERTS.enabled);
});

/* ── 플랫폼 — 여기가 이 게이트의 존재 이유다 ─────────────────────────────── */

function withPlatform(value, fn) {
  const descriptor = Object.getOwnPropertyDescriptor(process, "platform");
  Object.defineProperty(process, "platform", { value, configurable: true });
  try { fn(); } finally { Object.defineProperty(process, "platform", descriptor); }
}

check("★macOS 는 Dock 을 튀긴다", () => {
  calls.bounce = 0; calls.flash = 0;
  withPlatform("darwin", () => alerts.bounceApp(fakeWindow));
  assert.equal(calls.bounce, 1, "macOS 에서 Dock 바운스를 안 부릅니다");
  assert.equal(calls.flash, 0, "macOS 에서 작업표시줄 깜빡임을 불렀습니다(그 API 는 여기 없습니다)");
});

check("★Windows 는 작업표시줄을 깜빡인다 — 하나만 부르면 여기가 조용히 죽는다", () => {
  calls.bounce = 0; calls.flash = 0;
  withPlatform("win32", () => alerts.bounceApp(fakeWindow));
  assert.equal(calls.flash, 1, "윈도우에서 아무것도 하지 않습니다 — '윈도우도 다 되야한다'가 깨집니다");
  assert.equal(calls.bounce, 0);
});

check("Linux 도 작업표시줄 경로를 탄다", () => {
  calls.bounce = 0; calls.flash = 0;
  withPlatform("linux", () => alerts.bounceApp(fakeWindow));
  assert.equal(calls.flash, 1);
});

check("창이 없어도 죽지 않는다(알람이 실행을 망치면 안 된다)", () => {
  withPlatform("win32", () => alerts.bounceApp(null));
  withPlatform("darwin", () => alerts.bounceApp(null));
});

check("★소리 스위치가 실제로 알림에 실린다", () => {
  calls.notifications = [];
  withPlatform("darwin", () => alerts.fireRunAlert({
    decision: { alert: true, kind: "done" }, settings: settings({ sound: true }), locale: "ko", goal: "테스트 작업",
  }));
  assert.equal(calls.notifications.length, 1, "알림이 표시되지 않았습니다");
  assert.equal(calls.notifications[0].silent, false, "소리를 켰는데 silent 로 나갑니다");

  calls.notifications = [];
  withPlatform("darwin", () => alerts.fireRunAlert({
    decision: { alert: true, kind: "done" }, settings: settings({ sound: false }), locale: "ko", goal: "x",
  }));
  assert.equal(calls.notifications[0].silent, true, "소리를 껐는데 소리가 납니다");
});

check("알림을 꺼도 흔들기는 따로 동작한다(둘은 독립 스위치다)", () => {
  calls.notifications = []; calls.flash = 0;
  withPlatform("win32", () => alerts.fireRunAlert({
    decision: { alert: true, kind: "failed" }, settings: settings({ notification: false, bounce: true }), locale: "en", goal: "x",
  }));
  assert.equal(calls.notifications.length, 0);
  assert.equal(calls.flash, 1, "알림을 끄자 흔들기까지 같이 죽었습니다");
});

check("문구가 결과를 정직하게 말한다", () => {
  assert.match(alerts.runAlertText("failed", "ko", "요가 앱 고치기").title, /실패/);
  assert.match(alerts.runAlertText("attention", "ko", "x").title, /확인/);
  assert.match(alerts.runAlertText("done", "en", "Fix the yoga app").body, /Fix the yoga app/);
  // 여러 줄 목표는 첫 줄만 — 알림 본문에 대화 전문이 흘러나오면 안 된다.
  assert.equal(alerts.runAlertText("done", "en", "first line\nsecond line").body, "first line");
});

check("★One 과 Work 가 같이 지나는 종료 지점 하나에만 붙는다", () => {
  const main = fs.readFileSync(path.join(root, "electron/main.ts"), "utf8");
  const code = main.split("\n").filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line));
  const has = (pattern) => code.some((line) => pattern.test(line));
  assert.ok(has(/function startRunAlertBridge\(/), "알람 브리지가 없습니다");
  assert.ok(
    has(/startRunAlertBridge\(\);/),
    "브리지를 시작하는 곳이 없습니다 — 코드는 있는데 아무도 안 부르는 상태입니다",
  );
  assert.ok(
    has(/decideRunAlert\(/),
    "판단 함수를 부르지 않습니다 — 알람이 항상 울리거나 전혀 안 울립니다",
  );
  // 종료 지점은 One·Work 공통인 onSettled 하나여야 한다. 표면마다 따로 달면 한쪽만 울린다.
  const bridge = main.slice(main.indexOf("function startRunAlertBridge("), main.indexOf("function startOneTeamNotificationBridge("));
  assert.match(bridge, /invocationService\.onSettled\(/, "공통 종료 지점이 아닌 곳에 붙었습니다");
});

check("설정 화면이 실제로 이 설정을 읽고 쓴다", () => {
  const page = fs.readFileSync(path.join(root, "renderer/app/(shell)/settings/page.tsx"), "utf8");
  const code = page.split("\n").filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line));
  assert.ok(code.some((line) => /runAlerts\.get\(\)/.test(line)), "설정을 읽지 않습니다");
  assert.ok(code.some((line) => /runAlerts\.set\(/.test(line)), "설정을 저장하지 않습니다");
  assert.ok(code.some((line) => /runAlerts\?\.preview\(\)/.test(line)), "미리듣기가 없습니다 — 안 들릴 때 확인할 길이 사라집니다");
  assert.ok(/RunAlertsPanel/.test(page), "패널을 화면에 붙이지 않았습니다");
});

process.stdout.write(`\nrun-alerts-contract: ${checks} checks passed\n`);
