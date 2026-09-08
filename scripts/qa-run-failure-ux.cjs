#!/usr/bin/env node
"use strict";
/*
 * **보냈는데 실행이 시작되지 않았을 때** 화면이 뭐라고 하는지 잰다.
 *
 * ★왜: 이 제품에서 가장 자주 실패할 수 있고, 실패하면 가장 아픈 자리다. 사용자는
 *   방금 쓴 글이 어디로 갔는지 알아야 하고(사라졌나? 보내졌나?), 다시 할 방법을
 *   알아야 한다. 지금까지의 훑기는 단추만 눌렀지 **글을 써서 보내 본 적이 없다.**
 *
 * 무엇을 보나:
 *   ① 실패를 말하는가(침묵 금지)
 *   ② 기계 식별자를 그대로 보여 주지 않는가
 *   ③ 내가 쓴 글이 남아 있는가 — 실패했는데 입력창까지 비면 글을 잃는다
 *
 * 감사 도구다(게이트 아님).
 */
const fs = require("node:fs");
const path = require("node:path");
const { chromium } = require("playwright");
const { setupMockAgentlasBridge, mockBridgeOptions } = require("./lib/mock-agentlas-bridge.cjs");
const { resolveDistDir, startStaticRenderer } = require("./lib/qa-static-renderer.cjs");

const root = path.resolve(__dirname, "..");
const distDir = resolveDistDir(root);
const DRAFT = "테스트 지시문입니다. 이 글이 사라지면 안 됩니다.";

const FAILURES = [
  { name: "식별자로 거절", message: "chat_invocation_not_started" },
  { name: "사람 문장으로 거절", message: "This conversation is still running an earlier request." },
];

async function probe(page, token) {
  return page.evaluate((draft) => {
    const text = (document.body.innerText || "").replace(/\s+/g, " ").trim();
    const box = document.querySelector("textarea");
    return {
      /* ★"시작하지 못했습니다" 처럼 붙여 쓰는 꼴을 놓치면 멀쩡한 화면을 침묵으로 읽는다. */
      saysFailure: /못했|못 |불러오지|보내지|시작하지|실패|다시 시도|다시 보내|오류|could not|failed|try again/i.test(text),
      keepsDraft: Boolean(box && box.value && box.value.includes(draft.slice(0, 12))),
      draftValue: box ? box.value.slice(0, 40) : null,
      sample: text.slice(0, 200),
    };
  }, token);
}

async function main() {
  if (!fs.existsSync(path.join(distDir, "one.html"))) throw new Error(`dist 가 없습니다: ${distDir} — npm run build:renderer`);
  const { server, baseUrl } = await startStaticRenderer(distDir);
  const browser = await chromium.launch();

  const SCREENS = [
    { label: "One", url: "/one.html", wait: "main" },
    { label: "Work 채팅", url: "/workspace/task.html?id=chat-1", wait: '[data-chat-input="true"]' },
  ];
  const report = [];
  for (const screen of SCREENS) {
    for (const failure of FAILURES) {
      const context = await browser.newContext({ viewport: { width: 1440, height: 980 }, locale: "ko-KR" });
      await context.addInitScript(setupMockAgentlasBridge, mockBridgeOptions({ oneConversation: true }));
      await context.addInitScript((message) => {
        const patch = (api) => {
          if (!api || !api.invoke) return false;
          api.invoke.run = async () => { throw new Error(message); };
          return true;
        };
        if (!patch(window.agentlas)) {
          let current;
          Object.defineProperty(window, "agentlas", {
            configurable: true,
            get: () => current,
            set: (value) => { current = value; patch(value); },
          });
        }
      }, failure.message);
      await context.addInitScript(() => {
        window.localStorage.setItem("agentlas.locale", "ko");
        window.localStorage.setItem("agentlas.work.firstRunOnboarding.v3", "1");
        window.confirm = () => true;
        window.alert = () => undefined;
      });
      const page = await context.newPage();
      try {
        await page.goto(`${baseUrl}${screen.url}`, { waitUntil: "domcontentloaded" });
        await page.waitForSelector(screen.wait, { timeout: 15000 });
        await page.waitForTimeout(900);
        const box = page.locator("textarea").first();
        await box.click({ timeout: 4000 });
        await box.fill(DRAFT);
        await page.waitForTimeout(150);
        await page.keyboard.press("Enter");
        await page.waitForTimeout(1400);
        const verdict = await probe(page, DRAFT);
        report.push({
          screen: screen.label,
          failure: failure.name,
          ...verdict,
          leaksToken: verdict.sample.includes(failure.message) && /^[a-z0-9_]+$/i.test(failure.message.replace(/[_]/g, "")),
        });
      } catch (cause) {
        report.push({ screen: screen.label, failure: failure.name, error: String((cause && cause.message) || cause).slice(0, 160) });
      }
      await context.close();
    }
  }
  await browser.close();
  server.close();

  let bad = 0;
  for (const row of report) {
    if (row.error) { console.log(`■ ${row.screen} / ${row.failure} — 열지 못함: ${row.error}`); continue; }
    const problems = [];
    if (!row.saysFailure) problems.push("아무 말이 없다");
    if (!row.keepsDraft) problems.push("쓴 글이 사라졌다");
    if (row.leaksToken) problems.push("식별자를 그대로 보여 준다");
    if (!problems.length) { console.log(`■ ${row.screen} / ${row.failure} — 말하고, 글도 남아 있다`); continue; }
    bad += problems.length;
    console.log(`■ ${row.screen} / ${row.failure} — ${problems.join(", ")}`);
    console.log(`     입력창: ${JSON.stringify(row.draftValue)}`);
    console.log(`     화면: ${row.sample.slice(0, 150)}`);
  }
  console.log(`\n지적 ${bad}건`);
  const out = path.join(root, "docs", "qa-run-failure-ux.json");
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify(report, null, 2));
  console.log(`기록: ${path.relative(root, out)}`);
}

main().catch((cause) => { console.error(cause); process.exit(1); });
