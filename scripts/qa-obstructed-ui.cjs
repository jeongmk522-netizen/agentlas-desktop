#!/usr/bin/env node
"use strict";
/*
 * 글자가 **잘리거나 가려진** 자리를 훑는다.
 *
 * ★왜 (QA 실측 2026-09-08): "마스코트 로봇이 대화상자 단추를 덮어 'Not now' 가
 *   'Not n' 로 보인다", "좌하단 계정 줄이 N 배지에 가려 v1.1.8 이 v1..8 로 보인다".
 *   둘 다 한 건씩 사람이 눈으로 찾아 올린 것이다. 같은 계열은 기계가 훑을 수 있다.
 *
 * 두 가지를 잰다:
 *   ① 잘림  — 글자를 담은 상자가 제 내용보다 좁다(scrollWidth > clientWidth).
 *   ② 가림  — 글자 한가운데를 찍었을 때 **다른 물건**이 잡힌다(elementFromPoint).
 *
 * ★가림 판정의 함정: 자기 자손·조상이 잡히는 것은 정상이다. 그리고 포인터를 안 받는
 *   물건(pointer-events:none)은 elementFromPoint 에 안 잡히므로, 그런 것으로 덮인
 *   경우는 이 방법으로 못 본다 — 그건 이 도구의 한계로 적어 둔다(0 은 부재의 증거가 아니다).
 *
 * 감사 도구다(게이트 아님). 목록을 뽑아 사람이 판단한다.
 */
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const { chromium } = require("playwright");
const { setupMockAgentlasBridge, mockBridgeOptions } = require("./lib/mock-agentlas-bridge.cjs");

const root = path.resolve(__dirname, "..");
const distDir = process.env.UI_QA_DIST ? path.resolve(process.env.UI_QA_DIST) : path.join(root, "dist", "renderer");
const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8", ".json": "application/json", ".png": "image/png",
  ".svg": "image/svg+xml", ".woff2": "font/woff2", ".txt": "text/plain; charset=utf-8" };

function resolveAsset(rawUrl) {
  let p = decodeURIComponent((rawUrl || "/").split("?")[0]);
  const nested = p.match(/^\/.+\/(_next\/.+)$/);
  if (nested) p = `/${nested[1]}`;
  if (p === "/") p = "/index.html";
  const direct = path.join(distDir, p.replace(/^\//, ""));
  if (fs.existsSync(direct) && fs.statSync(direct).isFile()) return direct;
  if (!path.extname(p)) {
    const html = path.join(distDir, `${p.replace(/^\//, "")}.html`);
    if (fs.existsSync(html)) return html;
  }
  return path.join(distDir, "404.html");
}

function startServer() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const file = resolveAsset(req.url);
      res.writeHead(200, { "content-type": MIME[path.extname(file)] || "application/octet-stream" });
      fs.createReadStream(file).pipe(res);
    });
    server.listen(0, "127.0.0.1", () => resolve({ server, baseUrl: `http://127.0.0.1:${server.address().port}` }));
  });
}

// 페이지 안에서 돈다. 자기충족적이어야 한다.
function auditObstruction(scopeSelector) {
  const CLIP_SLACK = 2;      // 서브픽셀 반올림 여유
  const clipped = [];
  const covered = [];
  const label = (el) => (el.innerText || el.textContent || "").trim().replace(/\s+/g, " ").slice(0, 60);
  const describe = (el) => `${el.tagName.toLowerCase()}${el.id ? "#" + el.id : ""}`
    + `${(el.className || "").toString().trim() ? "." + (el.className || "").toString().trim().split(/\s+/)[0] : ""}`;

  /*
   * ★모달을 잴 때는 **모달 안**만 본다. 모달이 뒤 화면을 덮는 것은 결함이 아니라 모달이
   *   하는 일이다 — 처음에 그걸 안 갈라서 가림 212건이 나왔고 전부 오탐이었다.
   */
  const scope = scopeSelector ? document.querySelector(scopeSelector) : document.body;
  if (!scope) return { clipped: [], covered: [], missingScope: scopeSelector };
  for (const el of scope.querySelectorAll("*")) {
    const style = getComputedStyle(el);
    if (style.display === "none" || style.visibility === "hidden" || Number(style.opacity) === 0) continue;
    const rect = el.getBoundingClientRect();
    if (rect.width < 4 || rect.height < 4) continue;
    // 화면 밖은 이 검사 대상이 아니다(스크롤로 도달하는 자리).
    if (rect.bottom < 0 || rect.top > window.innerHeight || rect.right < 0 || rect.left > window.innerWidth) continue;
    const text = label(el);
    if (!text) continue;
    // 글자를 직접 담은 잎사귀만 본다 — 조상까지 세면 같은 사고가 여러 번 잡힌다.
    const ownsText = [...el.childNodes].some((n) => n.nodeType === 3 && (n.nodeValue || "").trim());
    if (!ownsText) continue;

    // ① 잘림 — 넘치는데 그것을 보여 줄 방법이 없을 때만 결함이다.
    const hidesOverflow = style.overflowX !== "visible";
    const ellipsis = style.textOverflow === "ellipsis";
    if (hidesOverflow && el.scrollWidth > el.clientWidth + CLIP_SLACK) {
      clipped.push({ el: describe(el), text, need: el.scrollWidth, have: el.clientWidth, ellipsis });
    }

    // ② 가림 — 글자 한가운데를 찍는다.
    const x = Math.min(window.innerWidth - 1, Math.max(0, rect.left + Math.min(rect.width / 2, 40)));
    const y = Math.min(window.innerHeight - 1, Math.max(0, rect.top + rect.height / 2));
    const top = document.elementFromPoint(x, y);
    // 범위를 정했다면, 그 범위 밖의 물건이 잡히는 것은 이 검사의 관심사가 아니다.
    const outsideScope = scopeSelector && top && !scope.contains(top);
    if (top && top !== el && !el.contains(top) && !top.contains(el) && !outsideScope) {
      covered.push({ el: describe(el), text, by: describe(top), byText: label(top).slice(0, 40) });
    }
  }
  return { clipped, covered };
}

async function main() {
  if (!fs.existsSync(path.join(distDir, "one.html"))) throw new Error(`dist 가 없습니다: ${distDir} — npm run build:renderer`);
  const { server, baseUrl } = await startServer();
  const browser = await chromium.launch();
  const SCREENS = [
    { label: "One 홈", url: "/one.html", wait: "main" },
    { label: "Work 채팅", url: "/workspace/task.html?id=chat-1", wait: '[data-chat-input="true"]' },
    { label: "설정", url: "/settings.html", wait: "main" },
    { label: "대시보드", url: "/index.html", wait: "main" },
    { label: "프로젝트 목록", url: "/projects.html", wait: "main" },
    { label: "라이브러리·MCP", url: "/library/mcps.html", wait: "main" },
  ];
  // 한 크기만 재는 것은 "봤다"가 아니다 — 좁은 창에서만 나는 결함이 이 계열의 대부분이다.
  const SIZES = [{ width: 1440, height: 980 }, { width: 1180, height: 820 }, { width: 1024, height: 720 }];
  const report = [];
  /*
   * ★두 언어를 모두 잰다. 영어가 대체로 더 길다("Not now" vs "나중에", "Settings" vs "설정")
   *   — 한 언어만 재면 긴 쪽에서만 나는 잘림을 원리적으로 못 본다.
   */
  for (const lang of ["ko", "en"]) {
  for (const size of SIZES) {
    for (const screen of SCREENS) {
      const context = await browser.newContext({ viewport: size, locale: lang === "ko" ? "ko-KR" : "en-US" });
      await context.addInitScript(setupMockAgentlasBridge, mockBridgeOptions());
      await context.addInitScript((locale) => {
        window.localStorage.setItem("agentlas.locale", locale);
        /*
         * ★처음 사용 안내를 닫고 잰다. 안 닫으면 그 오버레이가 대시보드 전체를 덮어
         *   "가림 212건" 이 나오는데, 그건 결함이 아니라 **모달이 하는 일**이다.
         *   첫 실행에서 실제로 그렇게 나왔고, 그대로 보고했다면 212건이 전부 오탐이었다.
         *   모달 자체의 가림은 따로 재야 한다(이 도구의 남은 숙제).
         */
        window.localStorage.setItem("agentlas.work.firstRunOnboarding.v3", "1");
      }, lang);
      const page = await context.newPage();
      try {
        await page.goto(`${baseUrl}${screen.url}`, { waitUntil: "domcontentloaded" });
        await page.waitForSelector(screen.wait, { timeout: 15000 });
        await page.waitForTimeout(800);
        const found = await page.evaluate(auditObstruction, null);
        report.push({ screen: `${screen.label}(${lang})`, size: `${size.width}x${size.height}`, ...found });
      } catch (error) {
        report.push({ screen: `${screen.label}(${lang})`, size: `${size.width}x${size.height}`, error: String(error).split("\n")[0] });
      }
      await page.close();
      await context.close();
    }
  }
  }
  /*
   * ★모달 회차 — QA 가 올린 실제 사고("마스코트가 'Not now' 를 덮어 'Not n' 로 보인다")는
   *   모달 안에서 났다. 위 회차는 모달을 닫고 재므로 그 계열을 원리적으로 못 본다.
   *   그래서 처음 사용 안내를 **열어 둔 채** 그 안만 다시 잰다.
   */
  for (const size of SIZES) {
    const context = await browser.newContext({ viewport: size, locale: "ko-KR" });
    await context.addInitScript(setupMockAgentlasBridge, mockBridgeOptions());
    await context.addInitScript(() => {
      window.localStorage.setItem("agentlas.locale", "ko");
      window.localStorage.removeItem("agentlas.work.firstRunOnboarding.v3");
    });
    const page = await context.newPage();
    try {
      await page.goto(`${baseUrl}/index.html`, { waitUntil: "domcontentloaded" });
      await page.waitForSelector("#work-onboarding-title", { timeout: 15000 });
      await page.waitForTimeout(800);
      const scope = await page.evaluate(() => {
        const title = document.getElementById("work-onboarding-title");
        const dialog = title?.closest("section,div[role=dialog],[aria-modal=true]");
        if (!dialog) return null;
        dialog.setAttribute("data-qa-scope", "modal");
        return "[data-qa-scope=modal]";
      });
      const found = scope ? await page.evaluate(auditObstruction, scope) : { clipped: [], covered: [], missingScope: true };
      report.push({ screen: "처음 사용 안내(모달 안)", size: `${size.width}x${size.height}`, ...found });
    } catch (error) {
      report.push({ screen: "처음 사용 안내(모달 안)", size: `${size.width}x${size.height}`, error: String(error).split("\n")[0] });
    }
    await page.close();
    await context.close();
  }

  /*
   * ★Science 설치 대화상자 — QA 가 올린 실제 사고("마스코트가 'Not now' 를 덮어
   *   'Not n' 로 보인다")가 난 자리다. 이 대화상자는 히어로 이미지 위에 단추 줄이 온다.
   */
  /*
   * ★두 언어를 모두 잰다. QA 가 본 것은 영어("Not now")였고, 한국어("나중에")는 더 짧다 —
   *   한 언어만 재면 긴 쪽에서만 나는 잘림을 원리적으로 못 본다.
   */
  const scienceRounds = [];
  for (const lang of ["ko", "en"]) for (const size of [...SIZES, { width: 900, height: 640 }]) scienceRounds.push({ lang, size });
  for (const { lang, size } of scienceRounds) {
    const context = await browser.newContext({ viewport: size, locale: lang === "ko" ? "ko-KR" : "en-US" });
    await context.addInitScript(setupMockAgentlasBridge, mockBridgeOptions());
    await context.addInitScript((locale) => {
      window.localStorage.setItem("agentlas.locale", locale);
      window.localStorage.setItem("agentlas.work.firstRunOnboarding.v3", "1");
    }, lang);
    const page = await context.newPage();
    try {
      await page.goto(`${baseUrl}/one.html`, { waitUntil: "domcontentloaded" });
      await page.waitForSelector("main", { timeout: 15000 });
      await page.evaluate(() => window.dispatchEvent(new CustomEvent("agentlas:open-science-install")));
      await page.waitForSelector('[data-testid="science-promo-later"]', { timeout: 8000 });
      await page.waitForTimeout(700);
      const scope = await page.evaluate(() => {
        const later = document.querySelector('[data-testid="science-promo-later"]');
        const dialog = later?.closest("section,div[role=dialog],[aria-modal=true]") ?? later?.parentElement?.parentElement;
        if (!dialog) return null;
        dialog.setAttribute("data-qa-scope", "science");
        return "[data-qa-scope=science]";
      });
      const found = scope ? await page.evaluate(auditObstruction, scope) : { clipped: [], covered: [], missingScope: true };
      report.push({ screen: `Science 설치 대화상자(${lang})`, size: `${size.width}x${size.height}`, ...found });
    } catch (error) {
      report.push({ screen: `Science 설치 대화상자(${lang})`, size: `${size.width}x${size.height}`, error: String(error).split("\n")[0] });
    }
    await page.close();
    await context.close();
  }

  await browser.close();
  server.close();

  console.log("=== 잘리거나 가려진 자리 ===\n");
  let clip = 0, cover = 0;
  for (const r of report) {
    if (r.error) { console.log(`[${r.screen} ${r.size}] 열지 못함 — ${r.error}`); continue; }
    if (!r.clipped.length && !r.covered.length) continue;
    console.log(`[${r.screen} ${r.size}]`);
    for (const c of r.clipped) {
      clip++;
      console.log(`   잘림${c.ellipsis ? "(…표시)" : "★(말없이)"}  ${JSON.stringify(c.text)}  ${c.have}px 자리에 ${c.need}px  <${c.el}>`);
    }
    for (const c of r.covered) {
      cover++;
      console.log(`   ★가림  ${JSON.stringify(c.text)}  ← <${c.by}> ${JSON.stringify(c.byText)}  <${c.el}>`);
    }
    console.log("");
  }
  console.log(`잘림 ${clip}건 / 가림 ${cover}건`);
  const outFile = path.join(root, "output", "obstructed-ui.json");
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  fs.writeFileSync(outFile, JSON.stringify(report, null, 2));
  console.log(`보고서: ${outFile}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
