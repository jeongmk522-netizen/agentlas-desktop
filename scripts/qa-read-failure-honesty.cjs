#!/usr/bin/env node
"use strict";
/*
 * **못 읽었을 때 화면이 뭐라고 하는가** 를 훑는다 — 읽기를 하나씩 실패시켜서.
 *
 * ★왜: 이 저장소가 반복해서 겪은 계열이다. 읽기가 실패하면 화면은 대개 "없음" 을
 *   그린다 — 대화 목록이 비고, 에이전트가 사라지고, 기억이 0건이 된다. 사용자는
 *   자기 것이 지워졌다고 읽는다. **실패는 사실이 아니다.**
 *   실제로 One/Work 의 대화 읽기가 그랬다(2026-09-08 실측): 못 읽었는데 둘 다
 *   아무 말도 없었고 One 은 "대화를 시작해 보세요" 빈 화면을 그렸다.
 *
 * 어떻게: 브리지 메서드를 하나씩 던지게 만들고 화면을 연 뒤,
 *   ① 실패를 말하는 문구가 있는가
 *   ② 대신 "없음/비어 있음" 을 말하고 있는가(= 사실인 척)
 *   둘을 함께 본다. ②만 참이면 사람이 볼 대상이다.
 *
 * 감사 도구다(게이트 아님) — 어떤 화면이 무엇을 말해야 하는지는 사람이 정한다.
 */
const fs = require("node:fs");
const path = require("node:path");
const { chromium } = require("playwright");
const { setupMockAgentlasBridge, mockBridgeOptions } = require("./lib/mock-agentlas-bridge.cjs");
const { resolveDistDir, startStaticRenderer, builtScreens } = require("./lib/qa-static-renderer.cjs");

const root = path.resolve(__dirname, "..");
const distDir = resolveDistDir(root);

const SAYS_FAILURE = /못 읽|불러오지 못|가져오지 못|확인하지 못|실패|다시 시도|다시 열어|오류|could not|couldn't|failed|unavailable|try again/i;
const SAYS_EMPTY = /아직 [^.]{0,12}없|없습니다|하나도 없|비어 ?있|시작해 ?보세|대화를 시작|no [a-z ]{0,14}(yet|found)|nothing (here|yet)|empty/i;

const READ_SCREEN = `(() => {
  const text = (document.body.innerText || "").replace(/\\s+/g, " ").trim();
  return { text };
})()`;

/** 무엇을 실패시켜 볼 것인가 — 화면이 "없음" 으로 그리기 쉬운 읽기들. */
const TARGETS = [
  { path: ["invoke", "history"], label: "대화 내용" },
  { path: ["chats", "listRecent"], label: "대화 목록" },
  { path: ["team", "list"], label: "에이전트 목록" },
  { path: ["mcpTools", "listInstalled"], label: "설치된 도구" },
  { path: ["projects", "list"], label: "프로젝트 목록" },
  { path: ["env", "list"], label: "환경 변수" },
  { path: ["firms", "list"], label: "조직 목록" },
  { path: ["runLedger", "chatTimeline"], label: "실행 기록" },
  { path: ["oneMemory", "getState"], label: "One 기억" },
  { path: ["marketplace", "search"], label: "Hub 검색" },
];

async function main() {
  if (!fs.existsSync(path.join(distDir, "one.html"))) throw new Error(`dist 가 없습니다: ${distDir} — npm run build:renderer`);
  const { server, baseUrl } = await startStaticRenderer(distDir);
  const browser = await chromium.launch();

  const SCREENS = process.env.RF_QA_ALL
    ? [
      { label: "One", url: "/one.html?chat=one-chat-1", wait: "main" },
      { label: "Work 채팅", url: "/workspace/task.html?id=chat-1", wait: '[data-chat-input="true"]' },
      ...builtScreens(distDir).filter((s) => !/^(one|workspace\/task)$/.test(s.label)),
    ]
    : [
      { label: "One", url: "/one.html?chat=one-chat-1", wait: "main" },
      { label: "Work 채팅", url: "/workspace/task.html?id=chat-1", wait: '[data-chat-input="true"]' },
      { label: "대시보드", url: "/index.html", wait: "main" },
      { label: "라이브러리", url: "/library.html", wait: "main" },
    ];

  /* ★검사기 자체 확인 — 실패 문구와 없음 문구를 실제로 가려내는가. */
  {
    if (!SAYS_FAILURE.test("이 대화를 불러오지 못했습니다.")) throw new Error("실패 문구 판정이 안 됩니다");
    if (SAYS_FAILURE.test("아직 대화가 없습니다")) throw new Error("없음 문구를 실패로 오인합니다");
    if (!SAYS_EMPTY.test("아직 대화가 없습니다")) throw new Error("없음 문구 판정이 안 됩니다");
  }

  /*
   * ★기준선을 먼저 잡는다. 그 화면이 **쓰지도 않는 읽기**를 실패시켜 놓고
   *   "아무 말이 없다"고 적으면 목록의 대부분이 오탐이 된다(첫 판이 33건 중
   *   상당수가 그랬다). 실패로 화면에서 **없어진 것이 있을 때만** 지적한다.
   */
  const openScreen = async (screen, target) => {
    const context = await browser.newContext({ viewport: { width: 1440, height: 980 }, locale: "ko-KR" });
    await context.addInitScript(setupMockAgentlasBridge, mockBridgeOptions({ oneConversation: true }));
    if (target) {
      await context.addInitScript((spec) => {
        const breakIt = (api) => {
          let node = api;
          for (const key of spec.path.slice(0, -1)) node = node && node[key];
          const last = spec.path[spec.path.length - 1];
          if (!node || typeof node[last] !== "function") return false;
          node[last] = async () => { throw new Error(`${spec.path.join(".")} read failed`); };
          return true;
        };
        if (!breakIt(window.agentlas || {})) {
          let current;
          Object.defineProperty(window, "agentlas", {
            configurable: true,
            get: () => current,
            set: (value) => { current = value; if (value) breakIt(value); },
          });
        }
      }, target);
    }
    await context.addInitScript(() => {
      window.localStorage.setItem("agentlas.locale", "ko");
      window.localStorage.setItem("agentlas.work.firstRunOnboarding.v3", "1");
    });
    const page = await context.newPage();
    await page.goto(`${baseUrl}${screen.url}`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector(screen.wait, { timeout: 15000 });
    await page.waitForTimeout(1300);
    const { text } = await page.evaluate(READ_SCREEN);
    await context.close();
    return text;
  };

  const baselines = new Map();
  for (const screen of SCREENS) baselines.set(screen.label, await openScreen(screen, null));

  const report = [];
  for (const screen of SCREENS) {
    for (const target of TARGETS) {
      try {
        const text = await openScreen(screen, target);
        const base = baselines.get(screen.label) || "";
        /*
         * ★시계·개수처럼 **매 실행마다 달라지는 낱말**은 빼야 한다. 안 빼면
         *   "11:29:02 가 사라졌다" 같은 지적이 화면마다 뜬다(첫 판 58건의 상당수).
         */
        const volatile = /^\d{1,2}:\d{2}(:\d{2})?$|^\(?\d+\)?$|^\d+[개명건초분]$|^\d+\.$|^오전$|^오후$|^[APap][Mm]$/;
        const words = (value) => new Set(
          value.split(/\s+/).filter((w) => w.length > 1 && !volatile.test(w)),
        );
        const before = words(base);
        const after = words(text);
        const lost = [...before].filter((w) => !after.has(w));
        report.push({
          screen: screen.label,
          target: target.label,
          used: lost.length > 0,
          lost: lost.slice(0, 8),
          lostCount: lost.length,
          saysFailure: SAYS_FAILURE.test(text),
          saysEmpty: SAYS_EMPTY.test(text) && !SAYS_EMPTY.test(base),
          sample: text.replace(/\s+/g, " ").slice(0, 120),
        });
      } catch (cause) {
        report.push({ screen: screen.label, target: target.label, error: String((cause && cause.message) || cause).slice(0, 120) });
      }
    }
  }
  await browser.close();
  server.close();

  let silent = 0;
  let pretending = 0;
  for (const row of report) {
    if (row.error) { console.log(`■ ${row.screen} / ${row.target} — 열지 못함: ${row.error}`); continue; }
    if (!row.used) continue;          // 이 화면이 안 쓰는 읽기다 — 말할 이유가 없다
    if (row.saysFailure) continue;
    silent += 1;
    if (row.saysEmpty) pretending += 1;
    console.log(`■ ${row.screen} — "${row.target}" 을 못 읽자 화면에서 ${row.lostCount}개 낱말이 사라졌는데 아무 말이 없다${row.saysEmpty ? "  ← 게다가 '없음' 이라고 말한다" : ""}`);
    console.log(`     사라진 것: ${row.lost.join(" · ")}`);
  }
  console.log(`\n말 안 함 ${silent}건 / 그중 '없음' 이라 말함 ${pretending}건 (총 ${report.length}회 시도)`);
  const out = path.join(root, "docs", "qa-read-failure-honesty.json");
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify(report, null, 2));
  console.log(`기록: ${path.relative(root, out)}`);
}

main().catch((cause) => { console.error(cause); process.exit(1); });
