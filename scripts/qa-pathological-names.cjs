#!/usr/bin/env node
"use strict";
/*
 * **이름이 길거나 이상할 때** 화면이 버티는지 훑는다.
 *
 * ★왜: 지금까지의 훑기는 mock 이 주는 짧고 얌전한 이름("QA Project", "One CEO")만
 *   봤다. 실제 사용자는 폴더 이름을 그대로 쓰고, 이모지를 넣고, 띄어쓰기 없이 길게
 *   쓴다. 그 순간 목록이 밀리고 단추가 화면 밖으로 나간다 — 실제로 이 저장소가
 *   같은 계열로 여러 번 데었다.
 *
 * 어떻게: 목록 읽기의 **결과만 가로채** 이름 자리를 병리적인 문자열로 바꾼다.
 *   (모양은 그대로 두므로 화면 로직은 정상 동작한다.)
 *   그 뒤 잘림·넘침·화면 밖으로 나감을 잰다.
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

const RENAME_EVERYTHING = (samples) => {
  const NAME_KEYS = ["name", "title", "label", "displayName", "localDisplayName"];
  let n = 0;
  const rename = (value, depth) => {
    if (!value || depth > 4) return value;
    if (Array.isArray(value)) return value.map((row) => rename(row, depth + 1));
    if (typeof value !== "object") return value;
    for (const key of Object.keys(value)) {
      if (NAME_KEYS.includes(key) && typeof value[key] === "string" && value[key].length > 0) {
        value[key] = samples[n++ % samples.length];
      } else if (value[key] && typeof value[key] === "object") {
        rename(value[key], depth + 1);
      }
    }
    return value;
  };
  const wrap = (fn) => async (...args) => rename(await fn(...args), 0);
  const LIST = /^(list|search|get|detect|history|all|status)/;
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

const SAMPLES = [
  "아주아주아주아주아주아주아주아주아주아주아주아주아주긴이름입니다띄어쓰기없음",
  "ThisIsAnExtremelyLongSingleWordProjectNameWithoutAnySpacesAtAllToBreakLayout",
  "🚀🚀🚀 이모지가 잔뜩 들어간 이름 🎉🎉🎉 with mixed English 그리고 한국어",
  "a",
  "이름 안에 <스크립트> 같은 꺾쇠와 \"따옴표\" 그리고 & 기호",
];

const AUDIT = `(() => {
  const clipped = [];
  const spilled = [];
  const root = document.querySelector("main") || document.body;
  for (const el of root.querySelectorAll("*")) {
    const cs = getComputedStyle(el);
    if (cs.display === "none" || cs.visibility === "hidden") continue;
    const own = [...el.childNodes].some((c) => c.nodeType === 3 && c.textContent.trim());
    const r = el.getBoundingClientRect();
    if (r.width < 16 || r.height < 8) continue;
    if (own && el.scrollWidth > el.clientWidth + 1
      && cs.overflowX !== "auto" && cs.overflowX !== "scroll" && cs.textOverflow !== "ellipsis") {
      clipped.push({
        el: el.tagName.toLowerCase() + (typeof el.className === "string" && el.className.trim() ? "." + el.className.trim().split(/\\s+/).slice(0, 2).join(".") : ""),
        have: el.clientWidth, need: el.scrollWidth,
        text: (el.textContent || "").replace(/\\s+/g, " ").trim().slice(0, 30),
      });
    }
    if (r.right > innerWidth + 2 || r.left < -2) {
      spilled.push({
        el: el.tagName.toLowerCase() + (typeof el.className === "string" && el.className.trim() ? "." + el.className.trim().split(/\\s+/).slice(0, 2).join(".") : ""),
        over: Math.round(Math.max(r.right - innerWidth, -r.left)),
        text: (el.textContent || "").replace(/\\s+/g, " ").trim().slice(0, 30),
      });
    }
  }
  /*
   * ★"0건" 을 말하기 전에 **심은 이름이 화면에 실제로 들어갔는지** 본다.
   *   안 들어갔으면 이 실행은 아무것도 재지 않은 것이다.
   */
  const planted = /아주아주아주아주아주|ThisIsAnExtremelyLongSingleWord|🚀🚀🚀/.test(root.innerText || "");
  return {
    planted,
    clipped: clipped.slice(0, 8),
    clippedCount: clipped.length,
    spilled: spilled.slice(0, 8),
    spilledCount: spilled.length,
    pageOverflowX: Math.max(0, document.documentElement.scrollWidth - innerWidth),
  };
})()`;

async function main() {
  if (!fs.existsSync(path.join(distDir, "one.html"))) throw new Error(`dist 가 없습니다: ${distDir} — npm run build:renderer`);
  const { server, baseUrl } = await startStaticRenderer(distDir);
  const browser = await chromium.launch();

  /* ★자체 확인 — 넘치는 이름을 잡는가. */
  {
    const p = await browser.newPage();
    await p.setContent(`<main><div style="width:120px;overflow:hidden;white-space:nowrap">${"가".repeat(60)}</div>
      <div style="position:absolute;left:2000px;width:300px">화면 밖으로 나간 이름</div></main>`);
    const v = await p.evaluate(AUDIT);
    await p.close();
    if (!v.clippedCount && !v.spilledCount) throw new Error(`검사기가 심은 넘침을 못 잡습니다: ${JSON.stringify(v)}`);
  }

  const SIZES = [{ width: 1440, height: 980 }, { width: 1180, height: 820 }];
  const screens = process.env.PN_QA_ALL ? builtScreens(distDir) : [
    { label: "one", url: "/one.html", wait: "main" },
    { label: "workspace", url: "/workspace.html", wait: "main" },
    { label: "index", url: "/index.html", wait: "main" },
    { label: "library/agents", url: "/library/agents.html", wait: "main" },
    { label: "automation/new", url: "/automation/new.html", wait: "body" },
    { label: "marketplace", url: "/marketplace.html", wait: "main" },
  ];
  const report = [];
  for (const size of SIZES) {
    for (const screen of screens) {
      const context = await browser.newContext({ viewport: size, locale: "ko-KR" });
      await context.addInitScript(setupMockAgentlasBridge, mockBridgeOptions({ oneConversation: true }));
      await context.addInitScript(RENAME_EVERYTHING, SAMPLES);
      await context.addInitScript(() => {
        window.localStorage.setItem("agentlas.locale", "ko");
        window.localStorage.setItem("agentlas.work.firstRunOnboarding.v3", "1");
      });
      const page = await context.newPage();
      try {
        await page.goto(`${baseUrl}${screen.url}`, { waitUntil: "domcontentloaded" });
        await page.waitForSelector(screen.wait, { timeout: 15000 });
        await page.waitForTimeout(1200);
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
    if (!row.planted) {
      console.log(`■ ${row.screen} — ★심은 이름이 화면에 없다: 이 화면은 재지 못했다`);
      continue;
    }
    const n = row.clippedCount + row.spilledCount + (row.pageOverflowX ? 1 : 0);
    if (!n) { console.log(`■ ${row.screen} — 긴 이름을 넣어도 깨지지 않음`); continue; }
    total += n;
    console.log(`■ ${row.screen} — 잘림 ${row.clippedCount} / 화면 밖 ${row.spilledCount}${row.pageOverflowX ? ` / 가로 스크롤 ${row.pageOverflowX}px` : ""}`);
    for (const c of row.clipped) console.log(`   잘림 <${c.el}> ${c.have}px 자리에 ${c.need}px "${c.text}"`);
    for (const c of row.spilled) console.log(`   화면 밖 ${c.over}px <${c.el}> "${c.text}"`);
  }
  console.log(`\n긴 이름에서 깨진 자리 ${total}건`);
  const out = path.join(root, "docs", "qa-pathological-names.json");
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify(report, null, 2));
  console.log(`기록: ${path.relative(root, out)}`);
}

main().catch((cause) => { console.error(cause); process.exit(1); });
