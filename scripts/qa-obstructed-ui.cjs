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
      /*
       * ★없는 파일에 스트림을 열면 서버가 통째로 죽는다(ENOENT 는 비동기 error 이벤트로 온다).
       *   이 저장소는 여러 세션이 공유해서 dist/renderer 가 순회 도중 다시 만들어질 수 있다 —
       *   그때 검사 전체가 중단되면 "훑었다"가 거짓이 된다. 없는 것은 404 로 답하고 계속한다.
       */
      if (!fs.existsSync(file)) {
        res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
        res.end("not found");
        return;
      }
      res.writeHead(200, { "content-type": MIME[path.extname(file)] || "application/octet-stream" });
      const stream = fs.createReadStream(file);
      stream.on("error", () => { res.destroy(); });
      stream.pipe(res);
    });
    server.listen(0, "127.0.0.1", () => resolve({ server, baseUrl: `http://127.0.0.1:${server.address().port}` }));
  });
}

// 페이지 안에서 돈다. 자기충족적이어야 한다.
function auditObstruction(scopeSelector) {
  const CLIP_SLACK = 2;      // 서브픽셀 반올림 여유
  const clipped = [];
  const covered = [];
  const painted = [];
  /** DOM 순서 — 나중에 오는 것이 (같은 층이면) 위에 그려진다. */
  const order = new Map();
  [...document.querySelectorAll("*")].forEach((node, i) => order.set(node, i));
  const stackRank = (node) => {
    let z = 0;
    for (let cur = node; cur && cur !== document.body; cur = cur.parentElement) {
      const s = getComputedStyle(cur);
      const v = parseInt(s.zIndex, 10);
      if (Number.isFinite(v) && s.position !== "static") { z = v; break; }
    }
    return z;
  };
  /** 조상 중 잘라내는(scroll/hidden) 상자 전부 안에 그 점이 들어 있는가. */
  const visibleInClippers = (node, x, y) => {
    for (let cur = node.parentElement; cur && cur !== document.documentElement; cur = cur.parentElement) {
      const s = getComputedStyle(cur);
      if (s.overflow === "visible" && s.overflowX === "visible" && s.overflowY === "visible") continue;
      const r = cur.getBoundingClientRect();
      if (x < r.left - 1 || x > r.right + 1 || y < r.top - 1 || y > r.bottom + 1) return false;
    }
    return true;
  };
  const paintsAbove = (layer, target) => {
    const lz = stackRank(layer), tz = stackRank(target);
    if (lz !== tz) return lz > tz;
    return (order.get(layer) ?? 0) > (order.get(target) ?? 0);
  };
  const label = (el) => (el.innerText || el.textContent || "").trim().replace(/\s+/g, " ").slice(0, 60);
  const describe = (el) => `${el.tagName.toLowerCase()}${el.id ? "#" + el.id : ""}`
    + `${(el.className || "").toString().trim() ? "." + (el.className || "").toString().trim().split(/\s+/)[0] : ""}`;

  /*
   * ★모달을 잴 때는 **모달 안**만 본다. 모달이 뒤 화면을 덮는 것은 결함이 아니라 모달이
   *   하는 일이다 — 처음에 그걸 안 갈라서 가림 212건이 나왔고 전부 오탐이었다.
   */
  const scope = scopeSelector ? document.querySelector(scopeSelector) : document.body;
  if (!scope) return { clipped: [], covered: [], missingScope: scopeSelector };
  /*
   * 위에 떠 있는 물체들 — 자리 잡힌(positioned) 요소 중 실제로 보이는 것.
   * pointer-events 를 안 받아도 **그려지기는 한다**. 그것이 이 검사의 요점이다.
   */
  const floaters = [...scope.querySelectorAll("*")].filter((node) => {
    const style = getComputedStyle(node);
    if (!["absolute", "fixed", "sticky"].includes(style.position)) return false;
    if (style.display === "none" || style.visibility === "hidden" || Number(style.opacity) < 0.5) return false;
    const r = node.getBoundingClientRect();
    if (r.width < 8 || r.height < 8) return false;
    // 배경도 글자도 없는 순수 레이아웃 상자는 무엇도 가리지 않는다.
    const paints = style.backgroundImage !== "none"
      || (style.backgroundColor && !/rgba\(0, 0, 0, 0\)|transparent/.test(style.backgroundColor))
      || (node.tagName === "IMG" || node.tagName === "SVG" || node.tagName === "CANVAS");
    return paints;
  });
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

    /*
     * ②-b 덮임 — **그려진 것**으로 잰다.
     *
     * ★왜 따로 필요한가 (QA 실측 2026-09-08): 마스코트 로봇이 "Not now" 라벨 위에
     *   그려져 글자가 "Not n" 까지만 읽혔는데, 그 로봇은 pointer-events 를 받지 않는다.
     *   그래서 elementFromPoint(아래 ②)는 **원리적으로 통과시킨다** — 클릭은 실제로
     *   통과되고 기능도 살아 있다. 안 보이는 것은 글자뿐이다.
     *   "누를 수 있는가"와 "읽을 수 있는가"는 다른 질문이고, 사람이 겪는 것은 후자다.
     */
    for (const layer of floaters) {
      if (layer === el || el.contains(layer) || layer.contains(el)) continue;
      /*
       * ★겹친다고 다 덮는 것이 아니다 — **위에 그려져야** 덮는다 (실측 2026-09-08).
       *   처음엔 겹치기만 하면 셌더니, 화면 전체를 차지하는 <main> 이 뒤에 깔린 것까지
       *   "100% 덮음"으로 나왔다(104건 중 상당수). 그건 배경이지 덮개가 아니다.
       *   쌓임 순서를 z-index → DOM 순서로 근사한다(같은 층이면 나중에 오는 것이 위).
       */
      if (!paintsAbove(layer, el)) continue;
      const lr = layer.getBoundingClientRect();
      const overlapW = Math.min(rect.right, lr.right) - Math.max(rect.left, lr.left);
      const overlapH = Math.min(rect.bottom, lr.bottom) - Math.max(rect.top, lr.top);
      if (overlapW <= 2 || overlapH <= 2) continue;
      // 글자 면적의 15% 이상을 덮을 때만 — 모서리 1~2px 겹침은 사고가 아니다.
      if ((overlapW * overlapH) / Math.max(1, rect.width * rect.height) < 0.15) continue;
      painted.push({
        el: describe(el), text,
        by: describe(layer),
        cover: Math.round(100 * (overlapW * overlapH) / Math.max(1, rect.width * rect.height)),
      });
      break;
    }

    // ② 가림 — 글자 한가운데를 찍는다.
    /*
     * ★찍는 점은 **그 글자 안에** 있어야 한다 (실측 2026-09-08).
     *   예전에는 뷰포트 경계로 clamp 했는데, 화면 아래로 반쯤 걸친 요소를 잴 때 그 점이
     *   요소 밖(맨 아래 가장자리)으로 밀려 **엉뚱한 이웃**이 잡혔다. 좁은 창의 긴 목록에서
     *   사이드바 항목 18건이 그렇게 "가림"으로 잡혔다 — 실제로는 겹치지 않는다.
     *   점이 요소 밖으로 나가면 그 요소는 이 방법으로 잴 수 없으므로 건너뛴다.
     */
    const x = Math.min(window.innerWidth - 1, Math.max(0, rect.left + Math.min(rect.width / 2, 40)));
    const y = Math.min(window.innerHeight - 1, Math.max(0, rect.top + rect.height / 2));
    if (x < rect.left || x > rect.right || y < rect.top || y > rect.bottom) continue;
    /*
     * ★잘라내는 조상 안에서도 보이는 점이어야 한다 (실측 2026-09-08).
     *   사이드바처럼 `overflow-y: auto` 로 **스크롤되는 목록**의 마지막 항목은 rect 가
     *   접힌 선 아래까지 이어진다. 그 자리를 찍으면 그 아래에 있는 **다른 영역**(발 부분)이
     *   잡혀 "가렸다"로 보고된다 — 실제로는 잘려서 안 보일 뿐 겹치지 않는다.
     *   이 한 줄이 없어서 화면 6개에서 18건이 거짓으로 잡혔다.
     */
    if (!visibleInClippers(el, x, y)) continue;
    const top = document.elementFromPoint(x, y);
    // 범위를 정했다면, 그 범위 밖의 물건이 잡히는 것은 이 검사의 관심사가 아니다.
    const outsideScope = scopeSelector && top && !scope.contains(top);
    if (top && top !== el && !el.contains(top) && !top.contains(el) && !outsideScope) {
      covered.push({ el: describe(el), text, by: describe(top), byText: label(top).slice(0, 40) });
    }
  }
  /*
   * ★"빈 자리" — 자리는 차지하는데 사람에게 보여 주는 것이 아무것도 없는 영역.
   *   오너 2026-09-07: "아무것도 안떠서 되는지 안 되는지 알 수 없잖아".
   *   목록이 비었을 때 **왜 비었는지** 한 줄도 없으면, 사람은 고장으로 읽는다.
   *   글자·그림·입력요소가 하나도 없이 넓은 면적을 차지한 컨테이너만 센다.
   */
  const blank = [];
  const MIN_AREA = 120 * 90;
  for (const el of scope.querySelectorAll("main, section, aside, [role=region], [role=list], [role=listbox], [role=tabpanel]")) {
    const style = getComputedStyle(el);
    if (style.display === "none" || style.visibility === "hidden" || Number(style.opacity) === 0) continue;
    const rect = el.getBoundingClientRect();
    if (rect.width * rect.height < MIN_AREA) continue;
    if (rect.bottom < 0 || rect.top > window.innerHeight) continue;
    if ((el.innerText || "").trim()) continue;
    if (el.querySelector("img, svg, canvas, video, input, textarea, select, button, webview, iframe")) continue;
    blank.push({
      el: describe(el),
      w: Math.round(rect.width), h: Math.round(rect.height),
      label: el.getAttribute("aria-label") || "",
    });
  }
  return { clipped, covered, painted, blank };
}

async function main() {
  if (!fs.existsSync(path.join(distDir, "one.html"))) throw new Error(`dist 가 없습니다: ${distDir} — npm run build:renderer`);
  const { server, baseUrl } = await startServer();
  const browser = await chromium.launch();
  /*
   * ★손으로 고른 6개가 아니라 **빌드된 화면 전부**를 훑는다 (2026-09-08).
   *   고른 화면만 재면 안 고른 화면의 결함은 영원히 "0건"으로 보인다.
   *   화면이 열리지 않거나 특정 상태가 필요한 것은 그 사실을 그대로 적는다 —
   *   "열지 못함"은 통과가 아니다.
   */
  const builtRoutes = fs.readdirSync(distDir, { recursive: true })
    .filter((name) => typeof name === "string" && name.endsWith(".html") && !name.startsWith("404"))
    .map((name) => ({
      label: name.replace(/\.html$/, ""),
      url: `/${name}`,
      wait: "body",
    }));
  const SCREENS_ALL = builtRoutes;
  const SCREENS = [
    { label: "One 홈", url: "/one.html", wait: "main" },
    { label: "Work 채팅", url: "/workspace/task.html?id=chat-1", wait: '[data-chat-input="true"]' },
    { label: "설정", url: "/settings.html", wait: "main" },
    { label: "대시보드", url: "/index.html", wait: "main" },
    { label: "프로젝트 목록", url: "/projects.html", wait: "main" },
    { label: "라이브러리·MCP", url: "/library/mcps.html", wait: "main" },
  ];
  // 한 크기만 재는 것은 "봤다"가 아니다 — 좁은 창에서만 나는 결함이 이 계열의 대부분이다.
  // ★1920 을 넣는다. QA 가 그 크기에서만 마스코트 겹침을 재현했고, 내 목록엔 없었다
  // — 없는 크기에서 나는 결함은 "0건"으로 보인다(2026-09-08).
  const SIZES = [{ width: 1920, height: 1055 }, { width: 1440, height: 980 }, { width: 1180, height: 820 }, { width: 1024, height: 720 }];
  const report = [];
  /*
   * ★두 언어를 모두 잰다. 영어가 대체로 더 길다("Not now" vs "나중에", "Settings" vs "설정")
   *   — 한 언어만 재면 긴 쪽에서만 나는 잘림을 원리적으로 못 본다.
   */
  for (const lang of ["ko", "en"]) {
  for (const size of SIZES) {
    for (const screen of (process.env.UI_QA_ALL ? SCREENS_ALL : SCREENS)) {
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
  for (const lang of ["ko", "en"]) for (const size of [...SIZES, { width: 900, height: 640 }]) scienceRounds.push({ lang, size });  // SIZES 에 1920 포함
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
  let clip = 0, cover = 0, blankCount = 0, paintedCount = 0;
  for (const r of report) {
    if (r.error) { console.log(`[${r.screen} ${r.size}] 열지 못함 — ${r.error}`); continue; }
    if (!r.clipped.length && !r.covered.length && !(r.blank || []).length && !(r.painted || []).length) continue;
    console.log(`[${r.screen} ${r.size}]`);
    for (const c of r.clipped) {
      clip++;
      console.log(`   잘림${c.ellipsis ? "(…표시)" : "★(말없이)"}  ${JSON.stringify(c.text)}  ${c.have}px 자리에 ${c.need}px  <${c.el}>`);
    }
    for (const c of (r.painted || [])) {
      paintedCount++;
      console.log(`   ★덮임  ${JSON.stringify(c.text)}  위에 <${c.by}> 가 ${c.cover}% 그려짐  <${c.el}>`);
    }
    for (const c of (r.blank || [])) {
      blankCount++;
      console.log(`   ★빈 자리  <${c.el}> ${c.w}x${c.h}px${c.label ? `  aria="${c.label}"` : ""} — 글자도 그림도 없다`);
    }
    for (const c of r.covered) {
      cover++;
      console.log(`   ★가림  ${JSON.stringify(c.text)}  ← <${c.by}> ${JSON.stringify(c.byText)}  <${c.el}>`);
    }
    console.log("");
  }
  console.log(`잘림 ${clip}건 / 가림 ${cover}건 / 덮임 ${paintedCount}건 / 빈 자리 ${blankCount}건`);
  const outFile = path.join(root, "output", "obstructed-ui.json");
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  fs.writeFileSync(outFile, JSON.stringify(report, null, 2));
  console.log(`보고서: ${outFile}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
