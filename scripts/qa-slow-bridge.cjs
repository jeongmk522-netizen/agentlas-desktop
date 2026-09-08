#!/usr/bin/env node
"use strict";
/*
 * **느릴 때** 화면이 어떻게 보이는지 훑는다.
 *
 * ★왜: 지금까지의 훑기는 전부 mock 이 **즉시** 답하는 상태만 봤다. 실제 사용자는
 *   그렇지 않다 — 저장소 조회, 런타임 탐지, Hub 검색은 몇 초씩 걸린다. 그 사이 화면이
 *   비어 있으면 "고장" 으로 보이고, 그게 "부드럽지 않다" 의 실체다.
 *
 * 어떻게: 브리지의 모든 읽기를 2.5초 지연시킨 뒤 화면을 연다. 로드 직후에
 *   ① 기다리는 중이라는 표시(스피너·뼈대·"불러오는 중")가 있는가
 *   ② 아니면 그냥 빈 화면인가
 *   를 본다.
 *
 * 감사 도구다(게이트 아님).
 */
const fs = require("node:fs");
const path = require("node:path");
const { chromium } = require("playwright");
const { setupMockAgentlasBridge, mockBridgeOptions } = require("./lib/mock-agentlas-bridge.cjs");
const { resolveDistDir, startStaticRenderer, builtScreens } = require("./lib/qa-static-renderer.cjs");

const root = path.resolve(__dirname, "..");
const distDir = resolveDistDir(root);

const SLOW_BRIDGE = (delayMs) => {
  const slow = (fn) => async (...args) => {
    await new Promise((resolve) => setTimeout(resolve, delayMs));
    return fn(...args);
  };
  const patch = (node, depth) => {
    if (!node || depth > 3) return;
    for (const key of Object.keys(node)) {
      const value = node[key];
      if (typeof value === "function") node[key] = slow(value.bind(node));
      else if (value && typeof value === "object") patch(value, depth + 1);
    }
  };
  const install = () => { if (!window.agentlas) return false; patch(window.agentlas, 0); return true; };
  if (!install()) {
    let current;
    Object.defineProperty(window, "agentlas", {
      configurable: true, get: () => current,
      set: (value) => { current = value; if (value) patch(value, 0); },
    });
  }
};

const AUDIT = `(() => {
  const main = document.querySelector("main") || document.body;
  const text = (main.innerText || "").replace(/\\s+/g, " ").trim();
  /* 기다린다는 신호 — 글자로도, 움직이는 물건으로도 낼 수 있다. */
  const saysWaiting = /불러오는 중|읽는 중|찾는 중|준비하는 중|확인 중|잠시|loading|checking|searching|preparing|…/i.test(text);
  const spinners = [...main.querySelectorAll("*")].filter((el) => {
    const cs = getComputedStyle(el);
    if (cs.animationName && cs.animationName !== "none") return true;
    const cls = typeof el.className === "string" ? el.className : "";
    return /spin|skeleton|shimmer|placeholder|progress/i.test(cls);
  }).length;
  const status = main.querySelectorAll('[role="status"], [role="progressbar"], [aria-busy="true"]').length;
  const actions = [...main.querySelectorAll('button:not([disabled]), a[href], [role="button"]')].filter((el) => {
    const r = el.getBoundingClientRect();
    return r.width > 20 && r.height > 12;
  }).length;
  return { words: text.split(/\\s+/).filter(Boolean).length, saysWaiting, spinners, status, actions, text: text.slice(0, 140) };
})()`;

async function main() {
  if (!fs.existsSync(path.join(distDir, "one.html"))) throw new Error(`dist 가 없습니다: ${distDir} — npm run build:renderer`);
  const { server, baseUrl } = await startStaticRenderer(distDir);
  const browser = await chromium.launch();

  /* ★자체 확인 — 기다림 신호를 실제로 읽어 내는가. */
  {
    const p = await browser.newPage();
    await p.setContent(`<style>@keyframes s{to{transform:rotate(1turn)}}.sp{animation:s 1s linear infinite;width:10px;height:10px}</style><main><div class="sp"></div><span>불러오는 중</span></main>`);
    const v = await p.evaluate(AUDIT);
    await p.close();
    if (!v.saysWaiting || v.spinners < 1) throw new Error(`기다림 신호 판정이 안 됩니다: ${JSON.stringify(v)}`);
    const q = await browser.newPage();
    await q.setContent(`<main></main>`);
    const w = await q.evaluate(AUDIT);
    await q.close();
    if (w.saysWaiting || w.spinners > 0) throw new Error(`빈 화면을 기다림으로 오인합니다: ${JSON.stringify(w)}`);
  }

  const screens = process.env.SB_QA_ALL ? builtScreens(distDir) : [
    { label: "one", url: "/one.html", wait: "body" },
    { label: "workspace/task", url: "/workspace/task.html?id=chat-1", wait: "body" },
    { label: "index", url: "/index.html", wait: "body" },
    { label: "library/agents", url: "/library/agents.html", wait: "body" },
    { label: "marketplace", url: "/marketplace.html", wait: "body" },
    { label: "settings", url: "/settings.html", wait: "body" },
  ];
  const report = [];
  for (const screen of screens) {
    const context = await browser.newContext({ viewport: { width: 1440, height: 980 }, locale: "ko-KR" });
    await context.addInitScript(setupMockAgentlasBridge, mockBridgeOptions({ oneConversation: true }));
    await context.addInitScript(SLOW_BRIDGE, 2500);
    await context.addInitScript(() => {
      window.localStorage.setItem("agentlas.locale", "ko");
      window.localStorage.setItem("agentlas.work.firstRunOnboarding.v3", "1");
    });
    const page = await context.newPage();
    try {
      await page.goto(`${baseUrl}${screen.url}`, { waitUntil: "domcontentloaded" });
      await page.waitForSelector(screen.wait, { timeout: 15000 });
      /*
       * ★모든 화면 앞에 **세션 확인 관문**이 있다("Agentlas 세션을 확인하고 있습니다").
       *   그걸 재면 어느 화면이든 똑같은 결과가 나온다 — 첫 판이 그랬다(6개 화면 전부
       *   같은 16낱말). 관문이 지나간 **직후**, 화면 자신의 읽기는 아직 도는 시점을 잰다.
       */
      await page.waitForFunction(
        () => !/세션을 확인|Checking your Agentlas session/i.test(document.body.innerText || ""),
        { timeout: 20000 },
      ).catch(() => {});
      await page.waitForTimeout(250);
      report.push({ screen: screen.label, ...(await page.evaluate(AUDIT)) });
    } catch (cause) {
      report.push({ screen: screen.label, error: String((cause && cause.message) || cause).slice(0, 160) });
    }
    await context.close();
  }
  await browser.close();
  server.close();

  let blank = 0;
  for (const row of report) {
    if (row.error) { console.log(`■ ${row.screen} — 열지 못함: ${row.error}`); continue; }
    const hasSignal = row.saysWaiting || row.spinners > 0 || row.status > 0;
    if (hasSignal) { console.log(`■ ${row.screen} — 기다림 표시 있음 (글자 ${row.words}, 움직임 ${row.spinners}, 상태 ${row.status})`); continue; }
    if (row.words >= 25) { console.log(`■ ${row.screen} — 표시는 없지만 화면이 이미 채워져 있다 (글자 ${row.words})`); continue; }
    /*
     * ★"주소가 올바르지 않습니다 / 찾으시는 페이지가 없습니다" 처럼 **끝난 상태**는
     *   기다림 표시가 없는 게 맞다. 누를 것이 있으면 막다른 길도 아니다.
     *   글자도 적고 누를 것도 없을 때만 지적한다(첫 판 7건 중 5건이 이 오탐이었다).
     */
    if ((row.actions ?? 0) > 0) { console.log(`■ ${row.screen} — 표시는 없지만 다음 걸음이 있다 (글자 ${row.words}, 단추 ${row.actions})`); continue; }
    blank += 1;
    console.log(`■ ${row.screen} — 느릴 때 **아무 표시 없이 빈 화면** (글자 ${row.words})`);
    console.log(`     본문: ${row.text || "(없음)"}`);
  }
  console.log(`\n느릴 때 아무 표시가 없는 화면 ${blank}개`);
  const out = path.join(root, "docs", "qa-slow-bridge.json");
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify(report, null, 2));
  console.log(`기록: ${path.relative(root, out)}`);
}

main().catch((cause) => { console.error(cause); process.exit(1); });
