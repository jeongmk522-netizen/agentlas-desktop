#!/usr/bin/env node
"use strict";
/*
 * **아무것도 없는 화면**이 다음에 뭘 하라고 말해 주는지 훑는다.
 *
 * ★왜: 처음 쓰는 사람이 보는 화면이다. 목록이 비었을 때 그냥 하얗게 두면
 *   "고장인가?" 와 구별되지 않고, 무엇을 해야 하는지도 알 수 없다.
 *   지금까지의 훑기는 전부 **데이터가 있는** 상태만 봤다.
 *
 * 어떻게: 목록을 돌려주는 읽기를 전부 **정상적으로 빈 배열**로 만들고(실패가 아니다),
 *   화면에 ① 설명 문장과 ② 누를 수 있는 다음 걸음이 있는지 본다.
 *
 * 감사 도구다(게이트 아님) — 어떤 화면에 무엇이 있어야 하는지는 사람이 정한다.
 */
const fs = require("node:fs");
const path = require("node:path");
const { chromium } = require("playwright");
const { setupMockAgentlasBridge, mockBridgeOptions } = require("./lib/mock-agentlas-bridge.cjs");
const { resolveDistDir, startStaticRenderer, builtScreens } = require("./lib/qa-static-renderer.cjs");

const root = path.resolve(__dirname, "..");
const distDir = resolveDistDir(root);

const EMPTY_EVERYTHING = () => {
  const LIST = /^(list|search|getAll|history|detect|all)/;
  const patch = (node, depth) => {
    if (!node || depth > 3) return;
    for (const key of Object.keys(node)) {
      const value = node[key];
      if (typeof value === "function") {
        if (LIST.test(key)) node[key] = async () => [];
      } else if (value && typeof value === "object") patch(value, depth + 1);
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

/** 화면의 "본문" 영역에 설명과 다음 걸음이 있는가. */
const AUDIT = `(() => {
  const main = document.querySelector("main") || document.body;
  const text = (main.innerText || "").replace(/\\s+/g, " ").trim();
  const actions = [...main.querySelectorAll('button:not([disabled]), a[href], [role="button"]')]
    .filter((el) => {
      const r = el.getBoundingClientRect();
      return r.width > 20 && r.height > 12 && r.top >= 0 && r.top < innerHeight;
    })
    .map((el) => (el.getAttribute("aria-label") || el.textContent || "").replace(/\\s+/g, " ").trim())
    .filter(Boolean);
  return {
    words: text.split(/\\s+/).filter(Boolean).length,
    text: text.slice(0, 200),
    actions: actions.slice(0, 8),
    actionCount: actions.length,
  };
})()`;

async function main() {
  if (!fs.existsSync(path.join(distDir, "one.html"))) throw new Error(`dist 가 없습니다: ${distDir} — npm run build:renderer`);
  const { server, baseUrl } = await startStaticRenderer(distDir);
  const browser = await chromium.launch();

  /* ★자체 확인 — 텅 빈 본문을 잡는가. */
  {
    const p = await browser.newPage();
    await p.setContent(`<main></main>`);
    const v = await p.evaluate(AUDIT);
    await p.close();
    if (v.words !== 0 || v.actionCount !== 0) throw new Error(`검사기가 빈 본문을 못 읽습니다: ${JSON.stringify(v)}`);
  }

  const screens = process.env.ES_QA_ALL ? builtScreens(distDir) : [
    { label: "one", url: "/one.html", wait: "main" },
    { label: "workspace", url: "/workspace.html", wait: "main" },
    { label: "index", url: "/index.html", wait: "main" },
    { label: "library/agents", url: "/library/agents.html", wait: "main" },
    { label: "library/mcps", url: "/library/mcps.html", wait: "main" },
    { label: "automation", url: "/automation.html", wait: "main" },
    { label: "prompts", url: "/prompts.html", wait: "main" },
    { label: "marketplace", url: "/marketplace.html", wait: "main" },
  ];
  const report = [];
  for (const screen of screens) {
    const context = await browser.newContext({ viewport: { width: 1440, height: 980 }, locale: "ko-KR" });
    await context.addInitScript(setupMockAgentlasBridge, mockBridgeOptions());
    await context.addInitScript(EMPTY_EVERYTHING);
    await context.addInitScript(() => {
      window.localStorage.setItem("agentlas.locale", "ko");
      window.localStorage.setItem("agentlas.work.firstRunOnboarding.v3", "1");
    });
    const page = await context.newPage();
    try {
      await page.goto(`${baseUrl}${screen.url}`, { waitUntil: "domcontentloaded" });
      await page.waitForSelector(screen.wait, { timeout: 15000 });
      /*
       * ★자동 복구가 도는 화면이 있다(ErrorBoundary 는 2.5초마다 두 번까지 다시 그린다).
       *   1초만 기다리면 그 "다시 그리는 중" 상태를 결함으로 읽는다 — 실제로 그랬다.
       *   복구가 끝나거나 포기할 때까지 기다렸다가 잰다.
       */
      await page.waitForTimeout(8000);
      report.push({ screen: screen.label, ...(await page.evaluate(AUDIT)) });
    } catch (cause) {
      report.push({ screen: screen.label, error: String((cause && cause.message) || cause).slice(0, 160) });
    }
    await context.close();
  }
  await browser.close();
  server.close();

  let bare = 0;
  for (const row of report) {
    if (row.error) { console.log(`■ ${row.screen} — 열지 못함: ${row.error}`); continue; }
    /*
     * ★글자가 적은 것 자체는 결함이 아니다 — 404 안내처럼 **짧아도 다음 걸음이 있으면**
     *   충분하다(첫 판이 그걸 결함으로 셌다). 문장도 걸음도 없을 때만 지적한다.
     */
    const problems = [];
    if (row.actionCount === 0) {
      problems.push(row.words < 8 ? `다음 걸음도 설명도 없다(낱말 ${row.words}개)` : "누를 수 있는 다음 걸음이 없다");
    }
    if (!problems.length) { console.log(`■ ${row.screen} — 낱말 ${row.words}, 다음 걸음 ${row.actionCount}개`); continue; }
    bare += 1;
    console.log(`■ ${row.screen} — ${problems.join(", ")}`);
    console.log(`     본문: ${row.text || "(없음)"}`);
    console.log(`     단추: ${row.actions.join(" · ") || "(없음)"}`);
  }
  console.log(`\n빈 상태가 아무 안내도 못 하는 화면 ${bare}개`);
  const out = path.join(root, "docs", "qa-empty-state.json");
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify(report, null, 2));
  console.log(`기록: ${path.relative(root, out)}`);
}

main().catch((cause) => { console.error(cause); process.exit(1); });
