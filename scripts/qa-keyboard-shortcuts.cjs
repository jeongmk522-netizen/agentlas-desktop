#!/usr/bin/env node
"use strict";
/*
 * **키보드로 보내는 길**이 제대로 도는지 잰다 — One 과 Work 둘 다.
 *
 * ★왜: 이 제품을 쓰는 사람은 마우스를 거의 안 쓴다. Enter 로 보내고 Shift+Enter 로
 *   줄을 바꾼다. 그게 어긋나면(줄바꿈이 전송되거나, Enter 가 두 번 보내거나)
 *   가장 자주 하는 동작이 매번 어긋난다.
 *
 * 무엇을 재나 — 브리지 호출을 **세어서** 확인한다(화면 글자 대조가 아니다):
 *   ① Shift+Enter → 실행 0번, 작성창에 줄바꿈이 남는다
 *   ② Enter → 실행 정확히 1번
 *   ③ Enter 를 빠르게 두 번 → 실행이 두 번 나가지 않는다(같은 글이 두 번 실행되면 안 된다)
 *   ④ 빈 작성창에서 Enter → 실행 0번
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

const COUNT_RUNS = () => {
  window.__runCalls = [];
  const patch = (api) => {
    if (!api || !api.invoke || typeof api.invoke.run !== "function") return false;
    const original = api.invoke.run.bind(api.invoke);
    api.invoke.run = async (payload) => {
      window.__runCalls.push({ at: Date.now(), prompt: String((payload && payload.userPrompt) || "").slice(0, 40) });
      return original(payload);
    };
    return true;
  };
  if (!patch(window.agentlas)) {
    let current;
    Object.defineProperty(window, "agentlas", {
      configurable: true, get: () => current,
      set: (value) => { current = value; patch(value); },
    });
  }
};

const READ = `(() => {
  const box = document.querySelector("textarea");
  return { runs: (window.__runCalls || []).length, value: box ? box.value : null };
})()`;

async function openScreen(browser, baseUrl, screen) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 980 }, locale: "ko-KR" });
  await context.addInitScript(setupMockAgentlasBridge, mockBridgeOptions({ oneConversation: true }));
  await context.addInitScript(COUNT_RUNS);
  await context.addInitScript(() => {
    window.localStorage.setItem("agentlas.locale", "ko");
    window.localStorage.setItem("agentlas.work.firstRunOnboarding.v3", "1");
  });
  const page = await context.newPage();
  await page.goto(`${baseUrl}${screen.url}`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector(screen.wait, { timeout: 15000 });
  await page.waitForTimeout(900);
  return { context, page };
}

async function main() {
  if (!fs.existsSync(path.join(distDir, "one.html"))) throw new Error(`dist 가 없습니다: ${distDir} — npm run build:renderer`);
  const { server, baseUrl } = await startStaticRenderer(distDir);
  const browser = await chromium.launch();

  const SCREENS = [
    { label: "One", url: "/one.html", wait: "main" },
    { label: "Work", url: "/workspace/task.html?id=chat-1", wait: '[data-chat-input="true"]' },
  ];
  const report = [];
  for (const screen of SCREENS) {
    // ① Shift+Enter
    {
      const { context, page } = await openScreen(browser, baseUrl, screen);
      try {
        const box = page.locator("textarea").first();
        await box.click();
        await box.type("첫 줄", { delay: 8 });
        await page.keyboard.press("Shift+Enter");
        await box.type("둘째 줄", { delay: 8 });
        await page.waitForTimeout(400);
        const v = await page.evaluate(READ);
        report.push({ screen: screen.label, case: "Shift+Enter 는 줄바꿈", runs: v.runs, ok: v.runs === 0 && (v.value || "").includes("\n"), value: (v.value || "").replace(/\n/g, "\\n").slice(0, 40) });
      } catch (cause) { report.push({ screen: screen.label, case: "Shift+Enter 는 줄바꿈", error: String(cause.message || cause).slice(0, 120) }); }
      await context.close();
    }
    // ② Enter 한 번
    {
      const { context, page } = await openScreen(browser, baseUrl, screen);
      try {
        const box = page.locator("textarea").first();
        await box.click();
        await box.type("보내기 시험", { delay: 8 });
        await page.keyboard.press("Enter");
        await page.waitForTimeout(1200);
        const v = await page.evaluate(READ);
        report.push({ screen: screen.label, case: "Enter 는 한 번만 보낸다", runs: v.runs, ok: v.runs === 1 });
      } catch (cause) { report.push({ screen: screen.label, case: "Enter 는 한 번만 보낸다", error: String(cause.message || cause).slice(0, 120) }); }
      await context.close();
    }
    // ③ Enter 두 번 빠르게
    {
      const { context, page } = await openScreen(browser, baseUrl, screen);
      try {
        const box = page.locator("textarea").first();
        await box.click();
        await box.type("두 번 시험", { delay: 8 });
        await page.keyboard.press("Enter");
        await page.keyboard.press("Enter");
        await page.waitForTimeout(1400);
        const v = await page.evaluate(READ);
        report.push({ screen: screen.label, case: "Enter 를 두 번 빠르게 눌러도 두 번 실행되지 않는다", runs: v.runs, ok: v.runs <= 1 });
      } catch (cause) { report.push({ screen: screen.label, case: "Enter 를 두 번 빠르게", error: String(cause.message || cause).slice(0, 120) }); }
      await context.close();
    }
    // ④ 빈 작성창에서 Enter
    {
      const { context, page } = await openScreen(browser, baseUrl, screen);
      try {
        const box = page.locator("textarea").first();
        await box.click();
        await page.keyboard.press("Enter");
        await page.waitForTimeout(800);
        const v = await page.evaluate(READ);
        report.push({ screen: screen.label, case: "빈 작성창에서 Enter 는 아무것도 안 보낸다", runs: v.runs, ok: v.runs === 0 });
      } catch (cause) { report.push({ screen: screen.label, case: "빈 작성창에서 Enter", error: String(cause.message || cause).slice(0, 120) }); }
      await context.close();
    }
  }
  await browser.close();
  server.close();

  let bad = 0;
  for (const row of report) {
    if (row.error) { console.log(`■ ${row.screen} / ${row.case} — 재지 못함: ${row.error}`); continue; }
    if (row.ok) { console.log(`■ ${row.screen} / ${row.case} — 맞음 (실행 ${row.runs}번${row.value ? `, 작성창 "${row.value}"` : ""})`); continue; }
    bad += 1;
    console.log(`■ ${row.screen} / ${row.case} — ★어긋남 (실행 ${row.runs}번${row.value !== undefined ? `, 작성창 "${row.value}"` : ""})`);
  }
  console.log(`\n키보드로 보내는 길이 어긋난 자리 ${bad}건`);
  const out = path.join(root, "docs", "qa-keyboard-shortcuts.json");
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify(report, null, 2));
  console.log(`기록: ${path.relative(root, out)}`);
}

main().catch((cause) => { console.error(cause); process.exit(1); });
