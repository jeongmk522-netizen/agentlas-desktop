#!/usr/bin/env node
"use strict";
/*
 * **닿을 수 없는 내용**을 훑는다.
 *
 * ★왜: 잘림 검사는 글자 한 줄이 상자보다 넓은 것을 본다. 그런데 더 나쁜 것이 있다 —
 *   상자 안에 내용이 더 있는데 넘침이 hidden 이라 **스크롤도 안 되는** 경우다.
 *   화면엔 아무 표시가 없고, 사용자는 그 아래에 뭐가 있는지조차 모른다.
 *
 * 세 가지를 잰다:
 *   ① 갇힌 내용 — scrollHeight > clientHeight 인데 overflow-y 가 hidden/clip.
 *   ② 옆으로 새는 화면 — 문서가 창보다 넓다(가로 스크롤바가 생긴다).
 *   ③ 스크롤은 되는데 **표시가 없는** 긴 목록은 여기서 보지 않는다(별개 문제).
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

const AUDIT = `(() => {
  const trapped = [];
  for (const el of document.querySelectorAll("*")) {
    const cs = getComputedStyle(el);
    const hiddenY = cs.overflowY === "hidden" || cs.overflowY === "clip";
    const hiddenX = cs.overflowX === "hidden" || cs.overflowX === "clip";
    const overY = el.scrollHeight - el.clientHeight;
    const overX = el.scrollWidth - el.clientWidth;
    if (!(hiddenY && overY > 6) && !(hiddenX && overX > 6)) continue;
    const r = el.getBoundingClientRect();
    if (r.width < 24 || r.height < 16) continue;
    if (cs.visibility === "hidden" || cs.display === "none") continue;
    // 일부러 잘라 쓰는 자리는 제외한다: 한 줄 말줄임, 여러 줄 말줄임, 애니메이션 마스크.
    if (cs.textOverflow === "ellipsis") continue;
    if (cs.webkitLineClamp && cs.webkitLineClamp !== "none") continue;
    if (Number(cs.opacity) < 0.05) continue;
    /*
     * ★안쪽에 **스크롤되는 자식**이 있으면 그 내용은 갇힌 게 아니다.
     *   대시보드의 <main> 이 그렇다: 자신은 overflow hidden 이지만 .dashboard-scroll 이
     *   실제로 스크롤한다. 이걸 안 빼면 멀쩡한 화면이 "749px 갇힘" 으로 보인다.
     */
    const scrollableChild = [...el.querySelectorAll("*")].some((child) => {
      const ccs = getComputedStyle(child);
      return (/auto|scroll/.test(ccs.overflowY) && child.scrollHeight > child.clientHeight + 4)
        || (/auto|scroll/.test(ccs.overflowX) && child.scrollWidth > child.clientWidth + 4);
    });
    if (scrollableChild) continue;
    // 가로만 넘치고 한 줄짜리 글자면 말줄임 없이 잘린 것 — 그건 obstructed-ui 가 본다.
    const text = (el.textContent || "").replace(/\\s+/g, " ").trim();
    trapped.push({
      el: el.tagName.toLowerCase() + (typeof el.className === "string" && el.className.trim()
        ? "." + el.className.trim().split(/\\s+/).slice(0, 2).join(".") : ""),
      axis: hiddenY && overY > 6 ? "세로" : "가로",
      hidden: hiddenY && overY > 6 ? overY : overX,
      box: Math.round(r.width) + "x" + Math.round(r.height),
      text: text.slice(0, 44),
    });
  }
  /*
   * ★세 번째 계열 — 상자 밖으로 **그려지는데 스크롤할 길이 없는** 내용.
   *   One 의 코드 블록이 그랬다: 대화 열은 710px 인데 말풍선이 2,681px 로 자라
   *   1,971px 이 열 밖으로 나갔고, 조상 어디에도 가로 스크롤이 없어 그 뒤는
   *   읽을 방법이 아예 없었다. 조상의 overflow 가 hidden 이 아니라 visible 이라
   *   위의 ① 검사로는 안 잡힌다 — 잘림은 더 위에서 일어난다.
   */
  const spilled = [];
  const clipperOf = (el) => {
    let node = el.parentElement;
    while (node && node !== document.body) {
      const cs = getComputedStyle(node);
      if (cs.overflowX !== "visible" || cs.overflowY !== "visible") return node;
      node = node.parentElement;
    }
    return document.documentElement;
  };
  const scrollableBetween = (el, stop) => {
    let node = el;
    while (node && node !== stop) {
      const cs = getComputedStyle(node);
      if (/auto|scroll/.test(cs.overflowX) && node.scrollWidth > node.clientWidth + 4) return true;
      node = node.parentElement;
    }
    if (stop) {
      const cs = getComputedStyle(stop);
      if (/auto|scroll/.test(cs.overflowX) && stop.scrollWidth > stop.clientWidth + 4) return true;
    }
    return false;
  };
  for (const el of document.querySelectorAll("*")) {
    const cs = getComputedStyle(el);
    if (cs.display === "none" || cs.visibility === "hidden" || Number(cs.opacity) < 0.05) continue;
    if (cs.position === "fixed" || cs.position === "absolute") continue;
    const text = (el.textContent || "").replace(/\s+/g, " ").trim();
    if (!text) continue;
    const r = el.getBoundingClientRect();
    if (r.width < 24 || r.height < 10) continue;
    const clipper = clipperOf(el);
    const cr = clipper === document.documentElement
      ? { left: 0, right: innerWidth }
      : clipper.getBoundingClientRect();
    const over = Math.round(Math.max(r.right - cr.right, cr.left - r.left));
    if (over <= 8) continue;
    if (scrollableBetween(el, clipper)) continue;   // 스크롤로 닿을 수 있으면 결함이 아니다
    spilled.push({
      el: el.tagName.toLowerCase() + (typeof el.className === "string" && el.className.trim()
        ? "." + el.className.trim().split(/\s+/).slice(0, 2).join(".") : ""),
      over,
      box: Math.round(r.width) + "x" + Math.round(r.height),
      text: text.slice(0, 40),
    });
  }
  const doc = document.documentElement;
  return {
    trapped,
    spilled,
    pageOverflowX: Math.max(0, doc.scrollWidth - innerWidth),
  };
})()`;

async function main() {
  if (!fs.existsSync(path.join(distDir, "one.html"))) throw new Error(`dist 가 없습니다: ${distDir} — npm run build:renderer`);
  const { server, baseUrl } = await startStaticRenderer(distDir);
  const browser = await chromium.launch();

  /* ★0 건을 보고하기 전에 검사기가 뭔가를 잡는지 본다. */
  {
    const p = await browser.newPage();
    await p.setContent(`<div style="width:200px;height:40px;overflow:hidden">
      <p>가둔 내용</p><p>여기는 절대 못 본다</p><p>더 있다</p></div>
      <div style="width:3000px;height:10px"></div>
      <div style="width:300px;overflow:hidden">
        <div style="width:900px">밖으로 새어 나가는 내용인데 스크롤이 없다</div>
      </div>`);
    const v = await p.evaluate(AUDIT);
    await p.close();
    if (!v.trapped.length) throw new Error("갇힌 내용 검사기가 심어 둔 고장을 못 잡습니다");
    if (v.pageOverflowX < 100) throw new Error(`가로 넘침 검사기가 심어 둔 고장을 못 잡습니다(${v.pageOverflowX})`);
    if (!v.spilled.length) throw new Error(`새어 나감 검사기가 심어 둔 고장을 못 잡습니다: ${JSON.stringify(v.spilled)}`);
  }

  const SIZES = [{ width: 1440, height: 980 }, { width: 1180, height: 820 }];
  const screens = process.env.UC_QA_ALL ? builtScreens(distDir) : [
    { label: "one", url: "/one.html", wait: "main" },
    { label: "workspace/task", url: "/workspace/task.html?id=chat-1", wait: '[data-chat-input="true"]' },
    { label: "index", url: "/index.html", wait: "main" },
    { label: "settings", url: "/settings.html", wait: "main" },
  ];
  const report = [];
  for (const size of SIZES) {
    for (const screen of screens) {
      const context = await browser.newContext({ viewport: size, locale: "ko-KR" });
      await context.addInitScript(setupMockAgentlasBridge, mockBridgeOptions());
      await context.addInitScript(() => {
        window.localStorage.setItem("agentlas.locale", "ko");
        window.localStorage.setItem("agentlas.work.firstRunOnboarding.v3", "1");
      });
      const page = await context.newPage();
      try {
        await page.goto(`${baseUrl}${screen.url}`, { waitUntil: "domcontentloaded" });
        await page.waitForSelector(screen.wait, { timeout: 15000 });
        await page.waitForTimeout(700);
        report.push({ screen: screen.label, size: `${size.width}x${size.height}`, ...(await page.evaluate(AUDIT)) });
      } catch (cause) {
        report.push({ screen: screen.label, size: `${size.width}x${size.height}`, error: String((cause && cause.message) || cause).slice(0, 180) });
      }
      await context.close();
    }
  }
  await browser.close();
  server.close();

  let trappedTotal = 0;
  let overflowScreens = 0;
  for (const row of report) {
    if (row.error) { console.log(`\n■ ${row.screen} (${row.size}) — 열지 못함: ${row.error}`); continue; }
    if (!row.trapped.length && !row.pageOverflowX && !(row.spilled || []).length) continue;
    trappedTotal += row.trapped.length + (row.spilled || []).length;
    if (row.pageOverflowX) overflowScreens += 1;
    console.log(`\n■ ${row.screen} (${row.size})`);
    if (row.pageOverflowX) console.log(`   화면이 창보다 ${row.pageOverflowX}px 넓다 — 가로 스크롤이 생긴다`);
    for (const t of row.trapped.slice(0, 10)) {
      console.log(`   갇힘(${t.axis} ${t.hidden}px) <${t.el}> ${t.box} "${t.text}"`);
    }
    if (row.trapped.length > 10) console.log(`   … 그 외 ${row.trapped.length - 10}건`);
    for (const t of (row.spilled || []).slice(0, 10)) {
      console.log(`   밖으로 새어 ${t.over}px, 스크롤 없음 <${t.el}> ${t.box} "${t.text}"`);
    }
    if ((row.spilled || []).length > 10) console.log(`   … 그 외 ${row.spilled.length - 10}건`);
  }
  console.log(`\n갇힌 내용 ${trappedTotal}건 / 옆으로 새는 화면 ${overflowScreens}개`);
  const out = path.join(root, "docs", "qa-unreachable-content.json");
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify(report, null, 2));
  console.log(`기록: ${path.relative(root, out)}`);
}

main().catch((cause) => { console.error(cause); process.exit(1); });
