#!/usr/bin/env node
"use strict";
/*
 * 키보드만으로 화면을 걸어 본다 — Tab 을 실제로 눌러서.
 *
 * ★왜: 지금까지의 검사는 "이름이 있나 / 눌러지나" 를 **소스에서** 봤다. 그런데 키보드
 *   사용자가 실제로 겪는 것은 다르다: 초점이 **안 보이는 곳으로 사라지고**, 어디에
 *   있는지 **표시가 안 나고**, 화면 밖으로 나가도 따라가지 않는다.
 *   이건 소스로는 못 잰다. 눌러 봐야 한다.
 *
 * 세 가지를 잰다:
 *   ① 사라짐  — 초점이 간 물건이 크기 0 이거나 화면 밖에 있다.
 *   ② 안 보임 — 초점이 갔는데 겉모습이 **하나도 안 변한다**(테두리·그림자·배경 전부 동일).
 *   ③ 갇힘    — Tab 을 눌러도 초점이 안 움직인다(같은 물건에 머문다).
 *
 * 프로그램으로 focus() 를 부르면 :focus-visible 이 안 걸린다 — 그래서 **진짜 Tab 키**를
 * 누른다. 그러지 않으면 "초점 표시 없음" 이 전부 오탐이 된다.
 *
 * 감사 도구다(게이트 아님).
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
      if (!fs.existsSync(file)) { res.writeHead(404, { "content-type": "text/plain" }); res.end("not found"); return; }
      res.writeHead(200, { "content-type": MIME[path.extname(file)] || "application/octet-stream" });
      const stream = fs.createReadStream(file);
      stream.on("error", () => res.destroy());
      stream.pipe(res);
    });
    server.listen(0, "127.0.0.1", () => resolve({ server, baseUrl: `http://127.0.0.1:${server.address().port}` }));
  });
}

/*
 * ★초점을 뺀 겉모습을 blur() 로 재면 안 된다 — blur 는 Tab 순회를 문서 처음으로
 *   되돌려 검사가 같은 자리를 영원히 돈다(첫 판이 그랬다).
 *   그래서 **걷기 전에** 모든 초점 대상의 평상시 겉모습을 미리 적어 둔다.
 */
const TABBABLE = 'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"]),[contenteditable="true"]';

const STAMP = `(() => {
  const sel = ${JSON.stringify("a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex=\"-1\"]),[contenteditable=\"true\"]")};
  /*
   * ★초점 표시는 그 물건 자신이 아니라 **감싼 상자**가 낼 수 있다
   *   (.composer:focus-within, .chat-input-shell:focus-within). 자기 것만 보면
   *   멀쩡한 입력창 6개를 전부 "표시 없음" 으로 읽는다 — 첫 판이 그랬다.
   *   그래서 자신 + 위로 3겹까지 함께 본다.
   */
  const one = (el) => { const cs = getComputedStyle(el);
    return [cs.outlineStyle, cs.outlineWidth, cs.outlineColor, cs.boxShadow, cs.backgroundColor, cs.borderColor, cs.borderWidth, cs.filter, cs.opacity].join("|"); };
  const style = (el) => { const parts = []; let node = el;
    for (let i = 0; i < 4 && node && node.nodeType === 1; i += 1) { parts.push(one(node)); node = node.parentElement; }
    return parts.join("//"); };
  const map = {};
  let n = 0;
  for (const el of document.querySelectorAll(sel)) {
    const key = String(n++);
    el.setAttribute("data-kbqa", key);
    map[key] = style(el);
  }
  return map;
})()`;

const READ_FOCUS = `(() => {
  const el = document.activeElement;
  if (!el || el === document.body || el === document.documentElement) return null;
  const rect = el.getBoundingClientRect();
  const one = (node) => { const cs = getComputedStyle(node);
    return [cs.outlineStyle, cs.outlineWidth, cs.outlineColor, cs.boxShadow, cs.backgroundColor, cs.borderColor, cs.borderWidth, cs.filter, cs.opacity].join("|"); };
  const styleOf = (start) => { const parts = []; let node = start;
    for (let i = 0; i < 4 && node && node.nodeType === 1; i += 1) { parts.push(one(node)); node = node.parentElement; }
    return parts.join("//"); };
  const label = (el.getAttribute("aria-label") || el.textContent || el.getAttribute("title") || "").replace(/\\s+/g, " ").trim().slice(0, 40);
  const id = el.tagName.toLowerCase()
    + (el.id ? "#" + el.id : "")
    + (el.className && typeof el.className === "string" ? "." + el.className.trim().split(/\\s+/).slice(0, 2).join(".") : "");
  return {
    key: el.getAttribute("data-kbqa"),
    type: (el.tagName === "INPUT" ? (el.getAttribute("type") || "text") : el.tagName.toLowerCase()),
    id, label,
    rect: { x: Math.round(rect.x), y: Math.round(rect.y), w: Math.round(rect.width), h: Math.round(rect.height) },
    style: styleOf(el),
  };
})()`;

async function walkScreen(page, size) {
  const resting = await page.evaluate(STAMP);
  const steps = [];
  const seen = new Set();
  let stuck = 0;
  let last = null;
  for (let i = 0; i < 200; i += 1) {
    await page.keyboard.press("Tab");
    const now = await page.evaluate(READ_FOCUS);
    if (!now) { if (last === null) continue; break; }
    const key = now.key ?? `${now.id}@${now.rect.x},${now.rect.y}`;
    /*
     * ★<input type="time"> 같은 native 컨트롤은 **한 물건 안에 칸이 여럿**이라
     *   Tab 이 시·분·오전오후 사이를 움직인다. 이걸 "갇힘"으로 읽으면 브라우저가
     *   원래 하는 일을 결함으로 보고한다 — 첫 판이 그랬다(자동화 새로 만들기 화면).
     *   같은 이유로 이 계열은 초점 표시도 브라우저가 칸 단위로 그린다.
     */
    const SEGMENTED = new Set(["time", "date", "datetime-local", "month", "week", "number"]);
    if (key === last) { if (!SEGMENTED.has(now.type)) { stuck += 1; if (stuck >= 3) { steps.push({ ...now, verdict: "갇힘" }); break; } } continue; }
    stuck = 0;
    if (seen.has(key)) break;   // 한 바퀴 돌았다
    seen.add(key);
    last = key;

    const invisible = now.rect.w < 2 || now.rect.h < 2;
    const offscreen = now.rect.x + now.rect.w < 0 || now.rect.y + now.rect.h < 0
      || now.rect.x > size.width || now.rect.y > size.height;
    const before = now.key != null ? resting[now.key] : undefined;
    const noIndicator = !invisible && !offscreen && before !== undefined && before === now.style
      && !["time", "date", "datetime-local", "month", "week", "color", "file", "range", "checkbox", "radio"].includes(now.type);
    if (invisible || offscreen || noIndicator) {
      steps.push({ ...now, verdict: invisible ? "크기 0" : offscreen ? "화면 밖" : "초점 표시 없음" });
    }
  }
  return { steps, visited: seen.size, tabbable: Object.keys(resting).length };
}

async function main() {
  if (!fs.existsSync(path.join(distDir, "one.html"))) throw new Error(`dist 가 없습니다: ${distDir} — npm run build:renderer`);
  const { server, baseUrl } = await startServer();
  const browser = await chromium.launch();

  /* ★0 건을 보고하기 전에 이 검사기가 뭔가를 잡을 수 있는지 본다. */
  {
    const probe = await browser.newPage();
    await probe.setContent(`<style>*{outline:none!important;box-shadow:none!important}</style>
      <button id="p1">보임</button>
      <button id="p2" style="width:0;height:0;padding:0;border:0;overflow:hidden">숨음</button>`);
    const { steps: found } = await walkScreen(probe, { width: 800, height: 600 });
    await probe.close();
    const kinds = new Set(found.map((f) => f.verdict));
    if (!kinds.has("초점 표시 없음") || !kinds.has("크기 0")) {
      throw new Error(`검사기가 심어 둔 고장을 못 잡습니다: ${JSON.stringify(found)} — 이 실행의 "0건" 은 의미가 없습니다`);
    }
  }

  const SCREENS = process.env.KB_QA_ALL
    ? fs.readdirSync(distDir, { recursive: true })
        .filter((n) => typeof n === "string" && n.endsWith(".html") && !n.startsWith("404"))
        .map((n) => ({ label: n.replace(/\.html$/, ""), url: `/${n}`, wait: "body" }))
    : [
        { label: "One 홈", url: "/one.html", wait: "main" },
        { label: "Work 채팅", url: "/workspace/task.html?id=chat-1", wait: '[data-chat-input="true"]' },
        { label: "대시보드", url: "/index.html", wait: "main" },
        { label: "설정", url: "/settings.html", wait: "main" },
      ];
  /* ★한 크기만 재는 것은 "봤다"가 아니다 — 좁은 창에서만 나는 결함이 이 계열의 대부분이다. */
  const SIZES = process.env.KB_QA_SIZES === "grid"
    ? [{ width: 1920, height: 1055 }, { width: 1440, height: 980 }, { width: 1180, height: 820 }, { width: 1024, height: 720 }]
    : [{ width: 1440, height: 980 }];
  const report = [];
  for (const size of SIZES) {
    for (const screen of SCREENS) {
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
        const walked = await walkScreen(page, size);
        report.push({ screen: screen.label, size: `${size.width}x${size.height}`, ...walked });
      } catch (cause) {
        report.push({ screen: screen.label, size: `${size.width}x${size.height}`, error: String(cause && cause.message || cause).slice(0, 200) });
      }
      await context.close();
    }
  }
  await browser.close();
  server.close();

  let total = 0;
  for (const row of report) {
    if (row.error) { console.log(`\n■ ${row.screen} (${row.size}) — 열지 못함: ${row.error}`); continue; }
    const byKind = {};
    for (const s of row.steps) (byKind[s.verdict] ??= []).push(s);
    total += row.steps.length;
    console.log(`\n■ ${row.screen} (${row.size}) — 초점 대상 ${row.tabbable}개 중 ${row.visited}개를 실제로 밟음, 지적 ${row.steps.length}건`);
    for (const [kind, list] of Object.entries(byKind)) {
      console.log(`   ${kind}: ${list.length}`);
      for (const s of list.slice(0, 12)) console.log(`     - ${s.id} "${s.label}" ${s.rect.w}x${s.rect.h} @${s.rect.x},${s.rect.y}`);
      if (list.length > 12) console.log(`     … 그 외 ${list.length - 12}건`);
    }
  }
  console.log(`\n합계 ${total}건`);
  const out = path.join(root, "docs", "qa-keyboard-journey.json");
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify(report, null, 2));
  console.log(`기록: ${path.relative(root, out)}`);
}

main().catch((cause) => { console.error(cause); process.exit(1); });
