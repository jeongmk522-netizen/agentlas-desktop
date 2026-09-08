#!/usr/bin/env node
"use strict";
/*
 * 마우스로 만졌을 때 **반응하는가** 를 훑는다 — 실제로 hover 시켜서.
 *
 * ★왜: 초점 검사를 실제로 눌러 보게 만들었더니 소스로는 안 보이던 17자리가 나왔다.
 *   마우스 쪽도 같다. 누를 수 있는 물건이
 *     ① 손가락 커서가 안 뜨고(cursor)          → 누를 수 있는 줄 모른다
 *     ② 올려도 겉모습이 하나도 안 변하고(hover) → 죽은 것처럼 보인다
 *     ③ 꺼져 있는데 이유가 없다(disabled)       → 왜 못 누르는지 알 길이 없다
 *   셋 다 "부드럽지 않다"의 실체다.
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
      if (!fs.existsSync(file)) { res.writeHead(404, { "content-type": "text/plain" }); res.end("not found"); return; }
      res.writeHead(200, { "content-type": MIME[path.extname(file)] || "application/octet-stream" });
      const stream = fs.createReadStream(file);
      stream.on("error", () => res.destroy());
      stream.pipe(res);
    });
    server.listen(0, "127.0.0.1", () => resolve({ server, baseUrl: `http://127.0.0.1:${server.address().port}` }));
  });
}

/** 화면 안에서 누를 수 있는 물건에 번호를 붙이고 평상시 모습을 적어 둔다. */
const STAMP = `(() => {
  const sel = 'button, a[href], [role="button"], [role="tab"], [role="menuitem"], [role="option"], summary';
  const style = (el) => { const cs = getComputedStyle(el);
    return { cursor: cs.cursor, look: [cs.backgroundColor, cs.backgroundImage, cs.color, cs.borderColor, cs.boxShadow, cs.opacity, cs.transform, cs.filter, cs.textDecorationLine, cs.outlineStyle].join("|") }; };
  const out = [];
  let n = 0;
  for (const el of document.querySelectorAll(sel)) {
    const r = el.getBoundingClientRect();
    if (r.width < 4 || r.height < 4) continue;
    if (r.x < 0 || r.y < 0 || r.x > innerWidth - 2 || r.y > innerHeight - 2) continue;
    const cs = getComputedStyle(el);
    if (cs.visibility === "hidden" || cs.display === "none" || Number(cs.opacity) < 0.05) continue;
    // 화면 한가운데 점이 자기 것이어야 hover 를 제대로 받는다.
    const cx = Math.round(r.x + r.width / 2), cy = Math.round(r.y + r.height / 2);
    const hit = document.elementFromPoint(cx, cy);
    if (!hit || !(el === hit || el.contains(hit))) continue;
    const key = String(n++);
    el.setAttribute("data-pfqa", key);
    const s = style(el);
    out.push({
      key, cx, cy,
      tag: el.tagName.toLowerCase(),
      cls: (typeof el.className === "string" ? el.className.trim().split(/\\s+/).slice(0, 2).join(".") : ""),
      label: (el.getAttribute("aria-label") || el.textContent || el.getAttribute("title") || "").replace(/\\s+/g, " ").trim().slice(0, 36),
      disabled: el.hasAttribute("disabled") || el.getAttribute("aria-disabled") === "true",
      /* data-disabled-reason="empty-input" 처럼 **보면 아는** 사유는 화면에 적지 않아도 된다. */
      reason: Boolean(el.getAttribute("title") || el.getAttribute("aria-describedby") || el.getAttribute("data-disabled-reason")),
      cursor: s.cursor, look: s.look,
    });
  }
  return out;
})()`;

const READ_ONE = (key) => `(() => {
  const el = document.querySelector('[data-pfqa="${key}"]');
  if (!el) return null;
  const cs = getComputedStyle(el);
  return { cursor: cs.cursor, look: [cs.backgroundColor, cs.backgroundImage, cs.color, cs.borderColor, cs.boxShadow, cs.opacity, cs.transform, cs.filter, cs.textDecorationLine, cs.outlineStyle].join("|") };
})()`;

async function auditScreen(page) {
  const items = await page.evaluate(STAMP);
  const findings = [];
  for (const item of items) {
    if (item.disabled) {
      if (!item.reason) findings.push({ ...item, verdict: "꺼진 이유 없음" });
      continue;   // 꺼진 것은 hover 반응이 없어도 정상이다
    }
    if (item.cursor !== "pointer") findings.push({ ...item, verdict: `손가락 커서 아님(${item.cursor})` });
    await page.mouse.move(item.cx, item.cy);
    /* 전환(transition)이 140ms 인 자리가 있다 — 너무 일찍 재면 "안 변함" 오탐이 난다. */
    await page.waitForTimeout(200);
    const after = await page.evaluate(READ_ONE(item.key));
    if (after && after.look === item.look) findings.push({ ...item, verdict: "올려도 안 변함" });
    await page.mouse.move(2, 2);
  }
  return { findings, total: items.length };
}

async function main() {
  if (!fs.existsSync(path.join(distDir, "one.html"))) throw new Error(`dist 가 없습니다: ${distDir} — npm run build:renderer`);
  const { server, baseUrl } = await startServer();
  const browser = await chromium.launch();

  /* ★0 건을 보고하기 전에 이 검사기가 뭔가를 잡는지 본다. */
  {
    const probe = await browser.newContext({ viewport: { width: 800, height: 600 } });
    const p = await probe.newPage();
    await p.setContent(`<style>button{all:unset;display:block;width:120px;height:30px;background:#eee}
      #ok{cursor:pointer}#ok:hover{background:#ccc}</style>
      <button id="ok">반응함</button><button id="dead">반응없음</button>
      <button id="off" disabled>꺼짐</button>`);
    const { findings } = await auditScreen(p);
    await probe.close();
    const kinds = new Set(findings.map((f) => f.verdict.split("(")[0]));
    for (const need of ["손가락 커서 아님", "올려도 안 변함", "꺼진 이유 없음"]) {
      if (!kinds.has(need)) throw new Error(`검사기가 "${need}" 을 못 잡습니다: ${JSON.stringify(findings)} — 이 실행의 "0건" 은 의미가 없습니다`);
    }
  }

  const SCREENS = process.env.PF_QA_ALL
    ? fs.readdirSync(distDir, { recursive: true })
        .filter((n) => typeof n === "string" && n.endsWith(".html") && !n.startsWith("404"))
        .map((n) => ({ label: n.replace(/\.html$/, ""), url: `/${n}`, wait: "body" }))
    : [
        { label: "One 홈", url: "/one.html", wait: "main" },
        { label: "Work 채팅", url: "/workspace/task.html?id=chat-1", wait: '[data-chat-input="true"]' },
        { label: "대시보드", url: "/index.html", wait: "main" },
        { label: "설정", url: "/settings.html", wait: "main" },
      ];
  const SIZES = process.env.PF_QA_SIZES === "grid"
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
      report.push({ screen: `${screen.label} ${size.width}x${size.height}`, ...(await auditScreen(page)) });
    } catch (cause) {
      report.push({ screen: `${screen.label} ${size.width}x${size.height}`, error: String((cause && cause.message) || cause).slice(0, 180) });
    }
    await context.close();
  }
  }
  await browser.close();
  server.close();

  let total = 0;
  const kindTotals = {};
  for (const row of report) {
    if (row.error) { console.log(`\n■ ${row.screen} — 열지 못함: ${row.error}`); continue; }
    const byKind = {};
    for (const f of row.findings) {
      const kind = f.verdict.split("(")[0];
      (byKind[kind] ??= []).push(f);
      kindTotals[kind] = (kindTotals[kind] ?? 0) + 1;
    }
    total += row.findings.length;
    console.log(`\n■ ${row.screen} — 누를 수 있는 것 ${row.total}개 중 지적 ${row.findings.length}건`);
    for (const [kind, list] of Object.entries(byKind)) {
      console.log(`   ${kind}: ${list.length}`);
      for (const f of list.slice(0, 8)) console.log(`     - <${f.tag}${f.cls ? "." + f.cls : ""}> "${f.label}"`);
      if (list.length > 8) console.log(`     … 그 외 ${list.length - 8}건`);
    }
  }
  console.log(`\n합계 ${total}건 ${JSON.stringify(kindTotals)}`);
  const out = path.join(root, "docs", "qa-pointer-affordance.json");
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify(report, null, 2));
  console.log(`기록: ${path.relative(root, out)}`);
}

main().catch((cause) => { console.error(cause); process.exit(1); });
