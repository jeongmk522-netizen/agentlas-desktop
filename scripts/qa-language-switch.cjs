#!/usr/bin/env node
"use strict";
/*
 * **언어를 도중에 바꿨을 때** 화면이 따라오는지 잰다.
 *
 * ★왜: 지금까지의 한국어 훑기는 전부 "처음부터 그 언어로 연" 상태만 봤다. 실제
 *   사용자는 앱을 쓰다가 설정에서 바꾼다. 그때 이미 그려진 화면이 그대로 남으면
 *   한 화면 안에 두 언어가 섞이고, 그건 번역 누락보다 더 이상해 보인다.
 *
 * 어떻게: 설정에서 언어를 바꾼 뒤 **다시 불러오지 않고** 다른 화면으로 이동해
 *   반대 언어 글자가 남아 있는지 본다. 한국어→영어, 영어→한국어 양방향.
 *
 * ★사용자가 쓴 글·고유명사는 언어가 아니다 — mock 이 넣은 이름("QA Project",
 *   "One CEO")과 제품 이름은 세지 않는다.
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

/** 세지 않을 것 — 이름·고유명사·mock 데이터. */
const IGNORE = [
  "Agentlas", "One", "Work", "Hub", "Cloud", "Science", "QA Project", "QA Chat",
  "CEO", "Codex", "Claude", "GPT", "OpenAI", "Ollama", "MCP", "CLI", "API", "URL",
  "Founder HQ", "Google Play", "App Store", "Android", "iOS", "Desktop", "Mobile",
];

const SCAN = `((wanted) => {
  const ignore = ${JSON.stringify(IGNORE)};
  const out = [];
  const root = document.querySelector("main") || document.body;
  for (const el of root.querySelectorAll("*")) {
    if (el.children.length) continue;
    const cs = getComputedStyle(el);
    if (cs.display === "none" || cs.visibility === "hidden") continue;
    let text = (el.textContent || "").trim();
    if (!text || text.length < 2) continue;
    for (const term of ignore) text = text.split(term).join(" ");
    const hasHangul = /[가-힣]/.test(text);
    const hasLatinWord = /[A-Za-z]{3,}/.test(text);
    if (wanted === "en" && hasHangul) out.push(text.slice(0, 40));
    if (wanted === "ko" && !hasHangul && hasLatinWord) out.push(text.slice(0, 40));
  }
  return [...new Set(out)];
})`;

async function main() {
  if (!fs.existsSync(path.join(distDir, "one.html"))) throw new Error(`dist 가 없습니다: ${distDir} — npm run build:renderer`);
  const { server, baseUrl } = await startStaticRenderer(distDir);
  const browser = await chromium.launch();

  /* ★자체 확인 — 섞인 글자를 실제로 잡는가. */
  {
    const p = await browser.newPage();
    await p.setContent(`<main><span>Save changes</span><span>변경 저장</span></main>`);
    const inEn = await p.evaluate(`(${SCAN})("en")`);
    const inKo = await p.evaluate(`(${SCAN})("ko")`);
    await p.close();
    if (!inEn.length) throw new Error("영어 화면에서 한글을 못 잡습니다");
    if (!inKo.length) throw new Error("한국어 화면에서 영어를 못 잡습니다");
  }

  const AFTER = [
    { label: "One", href: "/one.html" },
    { label: "Work", href: "/workspace/task.html?id=chat-1" },
    { label: "대시보드", href: "/index.html" },
    { label: "라이브러리", href: "/library/agents.html" },
  ];
  const report = [];
  for (const direction of [{ from: "ko", to: "en", button: "English" }, { from: "en", to: "ko", button: "한국어" }]) {
    const context = await browser.newContext({ viewport: { width: 1440, height: 980 }, locale: direction.from === "ko" ? "ko-KR" : "en-US" });
    await context.addInitScript(setupMockAgentlasBridge, mockBridgeOptions({ oneConversation: true }));
    await context.addInitScript((locale) => {
      /*
       * ★init 스크립트는 **이동할 때마다** 다시 돈다. 여기서 무조건 덮어쓰면
       *   사용자가 방금 바꾼 언어를 매번 되돌려 놓고 "안 따라온다" 고 보고하게 된다
       *   (첫 판 283건이 전부 그 자국이었다). 없을 때만 심는다.
       */
      if (!window.localStorage.getItem("agentlas.locale")) {
        window.localStorage.setItem("agentlas.locale", locale);
      }
      window.localStorage.setItem("agentlas.work.firstRunOnboarding.v3", "1");
    }, direction.from);
    const page = await context.newPage();
    try {
      await page.goto(`${baseUrl}/settings.html`, { waitUntil: "domcontentloaded" });
      await page.waitForSelector("main", { timeout: 15000 });
      await page.waitForTimeout(1000);
      const button = page.getByRole("button", { name: direction.button, exact: true });
      if (await button.count() === 0) {
        report.push({ direction: `${direction.from}→${direction.to}`, screen: "설정", error: `"${direction.button}" 단추를 못 찾음` });
      } else {
        await button.first().click();
        await page.waitForTimeout(900);
        const leftovers = await page.evaluate(`(${SCAN})(${JSON.stringify(direction.to)})`);
        report.push({ direction: `${direction.from}→${direction.to}`, screen: "설정(바꾼 그 화면)", leftovers });
        /* 다시 불러오지 않고 앱 안에서 이동한다 — 그게 실제 사용 순서다. */
        for (const next of AFTER) {
          await page.goto(`${baseUrl}${next.href}`, { waitUntil: "domcontentloaded" });
          await page.waitForSelector("body", { timeout: 15000 });
          await page.waitForTimeout(1100);
          const rest = await page.evaluate(`(${SCAN})(${JSON.stringify(direction.to)})`);
          report.push({ direction: `${direction.from}→${direction.to}`, screen: next.label, leftovers: rest });
        }
      }
    } catch (cause) {
      report.push({ direction: `${direction.from}→${direction.to}`, screen: "?", error: String((cause && cause.message) || cause).slice(0, 150) });
    }
    await context.close();
  }
  await browser.close();
  server.close();

  let total = 0;
  for (const row of report) {
    if (row.error) { console.log(`■ ${row.direction} / ${row.screen} — 재지 못함: ${row.error}`); continue; }
    if (!row.leftovers.length) { console.log(`■ ${row.direction} / ${row.screen} — 남은 반대 언어 0건`); continue; }
    total += row.leftovers.length;
    console.log(`■ ${row.direction} / ${row.screen} — 남은 반대 언어 ${row.leftovers.length}건`);
    for (const t of row.leftovers.slice(0, 10)) console.log(`     "${t}"`);
    if (row.leftovers.length > 10) console.log(`     … 그 외 ${row.leftovers.length - 10}건`);
  }
  console.log(`\n언어를 바꾼 뒤 남은 반대 언어 ${total}건`);
  const out = path.join(root, "docs", "qa-language-switch.json");
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify(report, null, 2));
  console.log(`기록: ${path.relative(root, out)}`);
}

main().catch((cause) => { console.error(cause); process.exit(1); });
