#!/usr/bin/env node
"use strict";
/*
 * **목록이 길 때** 화면이 버티는지 훑는다.
 *
 * ★왜: mock 은 프로젝트 1개·에이전트 몇 개만 준다. 실제 사용자는 수십 개를 갖는다.
 *   그때 목록이 화면을 넘겨도 스크롤이 없거나, 조작 단추가 아래로 밀려 화면 밖으로
 *   나가면 그 기능은 도달 불가가 된다. 지금까지의 훑기는 **적은 데이터**만 봤다.
 *
 * 어떻게: 목록 읽기의 결과를 가로채 같은 모양으로 60배 늘린다(id 만 바꾼다).
 *   그 뒤 ① 화면 밖으로 나간 조작 ② 스크롤 없이 잘린 목록 ③ 가로 넘침을 잰다.
 *
 * ★이 도구의 한계 (2026-09-08 실측):
 *   mock 이 **행을 하나도 안 주는 목록은 늘릴 수 없다**(빈 배열 × 60 = 빈 배열).
 *   그래서 automation·prompts·library/mcps·marketplace 는 "재지 못했다" 로 나온다 —
 *   결함 없음이 아니라 **측정 못 함**이다. 지금 실제로 재는 것은 workspace(61행)와
 *   대시보드(354행) 둘이다. 다른 화면을 재려면 그 화면이 쓰는 읽기에 mock 행을 넣어야 한다.
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

const MULTIPLY_ROWS = (times) => {
  const LIST = /^(list|search|getAll|history|detect|all|listInstalled|listCatalog|listRecent|listByProject|listByFirm|exactBindings)/;
  const grow = (value) => {
    /* 이미 긴 목록(>40)은 그대로 둔다 — 늘려도 새로 배우는 게 없고 느리기만 하다. */
    if (!Array.isArray(value) || value.length === 0 || value.length > 40) return value;
    const out = [];
    for (let i = 0; i < times; i += 1) {
      for (const row of value) {
        if (!row || typeof row !== "object" || Array.isArray(row)) { out.push(row); continue; }
        const copy = { ...row };
        for (const key of ["id", "slug", "chatId", "projectId", "agentId"]) {
          if (typeof copy[key] === "string") copy[key] = `${copy[key]}-x${i}`;
        }
        for (const key of ["name", "title", "label"]) {
          if (typeof copy[key] === "string") copy[key] = `${copy[key]} ${i + 1}`;
        }
        out.push(copy);
      }
    }
    return out;
  };
  const wrap = (fn) => async (...args) => grow(await fn(...args));
  const patch = (node, depth) => {
    if (!node || depth > 3) return;
    for (const key of Object.keys(node)) {
      const value = node[key];
      if (typeof value === "function") { if (LIST.test(key)) node[key] = wrap(value.bind(node)); }
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
  const offscreen = [];
  const trapped = [];
  const root = document.querySelector("main") || document.body;
  /* ① 조작이 화면 아래/옆으로 나갔는가 — 스크롤로 닿을 수 있으면 결함이 아니다. */
  const scrollableAncestor = (el) => {
    let node = el.parentElement;
    while (node && node !== document.body) {
      const cs = getComputedStyle(node);
      if (/auto|scroll/.test(cs.overflowY) && node.scrollHeight > node.clientHeight + 4) return true;
      if (/auto|scroll/.test(cs.overflowX) && node.scrollWidth > node.clientWidth + 4) return true;
      node = node.parentElement;
    }
    const doc = document.documentElement;
    return doc.scrollHeight > doc.clientHeight + 4 || doc.scrollWidth > doc.clientWidth + 4;
  };
  for (const el of root.querySelectorAll('button:not([disabled]), a[href], [role="button"], input, select')) {
    const r = el.getBoundingClientRect();
    if (r.width < 8 || r.height < 8) continue;
    const outside = r.right > innerWidth + 2 || r.left < -2 || r.top > innerHeight + 2 || r.bottom < -2;
    if (!outside) continue;
    if (scrollableAncestor(el)) continue;
    offscreen.push({
      el: el.tagName.toLowerCase() + (typeof el.className === "string" && el.className.trim() ? "." + el.className.trim().split(/\\s+/).slice(0, 2).join(".") : ""),
      label: (el.getAttribute("aria-label") || el.textContent || "").replace(/\\s+/g, " ").trim().slice(0, 26),
      at: Math.round(r.top),
    });
  }
  /* ② 넘침이 hidden 인데 내용이 더 있는 목록 — 스크롤도 못 한다. */
  for (const el of root.querySelectorAll("*")) {
    const cs = getComputedStyle(el);
    if (!/hidden|clip/.test(cs.overflowY)) continue;
    if (el.scrollHeight <= el.clientHeight + 8) continue;
    const r = el.getBoundingClientRect();
    if (r.width < 40 || r.height < 40) continue;
    const inner = [...el.querySelectorAll("*")].some((child) => {
      const ccs = getComputedStyle(child);
      return /auto|scroll/.test(ccs.overflowY) && child.scrollHeight > child.clientHeight + 4;
    });
    if (inner) continue;
    trapped.push({
      el: el.tagName.toLowerCase() + (typeof el.className === "string" && el.className.trim() ? "." + el.className.trim().split(/\\s+/).slice(0, 2).join(".") : ""),
      hidden: el.scrollHeight - el.clientHeight,
      box: Math.round(r.width) + "x" + Math.round(r.height),
    });
  }
  return {
    offscreen: offscreen.slice(0, 8),
    offscreenCount: offscreen.length,
    trapped: trapped.slice(0, 6),
    trappedCount: trapped.length,
    pageOverflowX: Math.max(0, document.documentElement.scrollWidth - innerWidth),
    rows: root.querySelectorAll("li, [role='listitem'], [class*='row'], [class*='card'], [class*='item'], [class*='Row'], [class*='Card']").length,
    /*
     * ★"0건" 을 말하기 전에 **늘린 행이 실제로 화면에 들어갔는지** 본다.
     *   안 들어갔으면 이 화면은 재지 못한 것이고, 0 은 부재의 증거가 아니다.
     */
    /* ★이 문자열은 **템플릿 리터럴 안**이다 — 역슬래시를 하나만 쓰면 JS 가 먼저 먹어
       \s 가 s 로, \b 가 백스페이스로 바뀐다. 그래서 늘린 행이 있는데도 '없다' 가 됐다. */
    planted: /\\s(4[0-9]|5[0-9]|60)(\\s|$)/.test(root.innerText || ""),
    sample: (root.innerText || "").replace(/\\s+/g, " ").trim().slice(0, 120),
  };
})()`;

async function main() {
  if (!fs.existsSync(path.join(distDir, "one.html"))) throw new Error(`dist 가 없습니다: ${distDir} — npm run build:renderer`);
  const { server, baseUrl } = await startStaticRenderer(distDir);
  const browser = await chromium.launch();

  /* ★자체 확인 — 화면 밖 조작과 갇힌 목록을 잡는가. */
  {
    const p = await browser.newPage();
    await p.setContent(`<main>
      <div style="position:absolute;left:3000px;top:10px"><button>화면 밖 단추</button></div>
      <div style="height:80px;overflow:hidden"><div style="height:900px">가둔 목록</div></div>
    </main>`);
    const v = await p.evaluate(AUDIT);
    await p.close();
    if (!v.offscreenCount) throw new Error(`화면 밖 조작을 못 잡습니다: ${JSON.stringify(v)}`);
    if (!v.trappedCount) throw new Error(`갇힌 목록을 못 잡습니다: ${JSON.stringify(v)}`);
  }

  const SIZES = [{ width: 1440, height: 980 }, { width: 1024, height: 720 }];
  const screens = process.env.MR_QA_ALL ? builtScreens(distDir) : [
    { label: "one", url: "/one.html", wait: "main" },
    { label: "workspace", url: "/workspace.html", wait: "main" },
    { label: "index", url: "/index.html", wait: "main" },
    { label: "library/agents", url: "/library/agents.html", wait: "main" },
    { label: "library/mcps", url: "/library/mcps.html", wait: "main" },
    { label: "automation", url: "/automation.html", wait: "main" },
    { label: "marketplace", url: "/marketplace.html", wait: "main" },
    { label: "prompts", url: "/prompts.html", wait: "main" },
  ];
  const report = [];
  for (const size of SIZES) {
    for (const screen of screens) {
      const context = await browser.newContext({ viewport: size, locale: "ko-KR" });
      await context.addInitScript(setupMockAgentlasBridge, mockBridgeOptions({ oneConversation: true, teamRoster: true }));
      await context.addInitScript(MULTIPLY_ROWS, 60);
      await context.addInitScript(() => {
        window.localStorage.setItem("agentlas.locale", "ko");
        window.localStorage.setItem("agentlas.work.firstRunOnboarding.v3", "1");
      });
      const page = await context.newPage();
      try {
        await page.goto(`${baseUrl}${screen.url}`, { waitUntil: "domcontentloaded" });
        await page.waitForSelector(screen.wait, { timeout: 15000 });
        await page.waitForTimeout(1400);
        report.push({ screen: `${screen.label} ${size.width}x${size.height}`, ...(await page.evaluate(AUDIT)) });
      } catch (cause) {
        report.push({ screen: `${screen.label} ${size.width}x${size.height}`, error: String((cause && cause.message) || cause).slice(0, 160) });
      }
      await context.close();
    }
  }
  await browser.close();
  server.close();

  let total = 0;
  for (const row of report) {
    if (row.error) { console.log(`■ ${row.screen} — 열지 못함: ${row.error}`); continue; }
    if (!row.planted) { console.log(`■ ${row.screen} — ★늘린 행이 화면에 없다: 이 화면은 재지 못했다 (행 ${row.rows}개)`); continue; }
    const n = row.offscreenCount + row.trappedCount + (row.pageOverflowX ? 1 : 0);
    if (!n) { console.log(`■ ${row.screen} — 행 ${row.rows}개, 괜찮음`); continue; }
    total += n;
    console.log(`■ ${row.screen} — 행 ${row.rows}개 / 화면 밖 조작 ${row.offscreenCount} / 갇힌 목록 ${row.trappedCount}${row.pageOverflowX ? ` / 가로 ${row.pageOverflowX}px` : ""}`);
    for (const o of row.offscreen) console.log(`   화면 밖 <${o.el}> "${o.label}" top ${o.at}`);
    for (const t of row.trapped) console.log(`   갇힘 ${t.hidden}px <${t.el}> ${t.box}`);
  }
  console.log(`\n목록이 길 때 깨진 자리 ${total}건`);
  const out = path.join(root, "docs", "qa-many-rows.json");
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify(report, null, 2));
  console.log(`기록: ${path.relative(root, out)}`);
}

main().catch((cause) => { console.error(cause); process.exit(1); });
