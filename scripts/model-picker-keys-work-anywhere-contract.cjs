#!/usr/bin/env node
"use strict";
/*
 * 모델 드롭다운의 키는 **포커스가 어디에 있든** 같은 답을 낸다 — 계약.
 *
 * ★왜 (QA 실측 2026-09-08): "방향키로 목록이 스크롤되지 않는다", "Esc 가 가끔 안 닫힌다".
 *
 * ★증상은 둘인데 원인은 하나였다. 방향키·Escape 를 **항목(option)** 에서만 처리했다.
 *   열린 뒤 포커스가 항목까지 못 가면 포커스는 트리거에 남는데, 그때
 *     · ArrowDown → 트리거 핸들러가 잡아 activeIndex 를 선택값으로 **되돌리고** 다시 연다
 *                   → 목록이 한 칸도 안 움직인다 ("스크롤이 안 된다"로 보인다)
 *     · Escape    → 트리거 핸들러가 아예 안 보는 키라 아무 일도 안 일어난다
 *   "가끔"인 이유가 이것이다 — 포커스가 항목에 닿았는지에 따라 갈렸다.
 *
 * ★스크롤 배관은 멀쩡했다. 따로 재보니 `focus()` 자체가 목록을 스크롤시킨다(0 → 560px).
 *   그래서 "스크롤을 추가"하는 것이 답이 아니라 **포커스가 도달하게** 하는 것이 답이었다.
 *   원인을 안 재고 스크롤 코드를 넣었으면 증상은 남고 코드만 늘었을 것이다.
 *
 * 이 게이트는 **트리거에 포커스를 둔 채** 키를 눌러 잰다. 그 상태가 옛 결함이 살던 자리다.
 *
 * ★고장 주입은 실측으로 이미 끝났다: 같은 하네스가 수리 **전** 코드에서
 *   "트리거에 포커스 둔 채 Escape → ★안 닫힘" 을 찍었고, 수리 후 "닫힘" 을 찍었다.
 *   즉 이 검사는 옛 고장을 실제로 빨간불로 만든다(합성 고장이 아니라 진짜 옛 코드로).
 */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const { chromium } = require("playwright");
const { setupMockAgentlasBridge, mockBridgeOptions } = require("./lib/mock-agentlas-bridge.cjs");

const root = path.resolve(__dirname, "..");
const distDir = path.join(root, "dist/renderer");
assert.ok(fs.existsSync(path.join(distDir, "index.html")), "dist/renderer 가 없습니다 — npm run build:renderer");
const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8", ".json": "application/json", ".png": "image/png",
  ".svg": "image/svg+xml", ".woff2": "font/woff2" };

function resolveAsset(url) {
  let p = decodeURIComponent((url || "/").split("?")[0]);
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

const TRIGGER = '[data-testid="runtime-model-picker"]';

(async () => {
  const server = http.createServer((q, r) => {
    const file = resolveAsset(q.url);
    r.writeHead(200, { "content-type": MIME[path.extname(file)] || "application/octet-stream" });
    fs.createReadStream(file).pipe(r);
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch();
  let checks = 0;
  const check = async (name, fn) => { await fn(); checks += 1; process.stdout.write(`  ok  ${name}\n`); };

  try {
    const context = await browser.newContext({ viewport: { width: 1440, height: 980 }, locale: "ko-KR" });
    await context.addInitScript(setupMockAgentlasBridge, mockBridgeOptions());
    await context.addInitScript(() => {
      window.localStorage.setItem("agentlas.locale", "ko");
      window.localStorage.setItem("agentlas.work.firstRunOnboarding.v3", "1");
    });
    const page = await context.newPage();
    await page.goto(`${baseUrl}/index.html`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector(TRIGGER, { timeout: 20000 });
    await page.waitForTimeout(500);

    const state = () => page.evaluate(() => {
      const list = document.querySelector('[role="listbox"]');
      if (!list) return { open: false };
      const options = [...list.querySelectorAll('[role="option"]')];
      // 활성 줄은 tabIndex=0 인 것 — 포커스가 어디 있든 화면이 가리키는 줄이다.
      const active = options.findIndex((el) => el.getAttribute("tabindex") === "0");
      return { open: true, count: options.length, active };
    });
    const openPicker = async () => {
      await page.locator(TRIGGER).first().click();
      await page.waitForSelector('[role="listbox"]', { timeout: 5000 });
      await page.waitForTimeout(200);
    };
    const focusTrigger = () => page.evaluate((sel) => document.querySelector(sel)?.focus(), TRIGGER);

    await check("전제 — 드롭다운이 열리고 항목이 둘 이상이다", async () => {
      await openPicker();
      const s = await state();
      assert.equal(s.open, true, "드롭다운을 못 열었습니다 — 이 게이트가 재는 화면이 아닙니다");
      assert.ok(s.count >= 2, `항목이 ${s.count}개라 방향키를 잴 수 없습니다`);
    });

    await check("★트리거에 포커스가 있어도 ArrowDown 이 활성 줄을 움직인다", async () => {
      await focusTrigger();
      const before = (await state()).active;
      await page.keyboard.press("ArrowDown");
      await page.waitForTimeout(120);
      const after = await state();
      assert.equal(after.open, true, "ArrowDown 이 목록을 닫아 버렸습니다");
      assert.notEqual(
        after.active, before,
        `활성 줄이 ${before} 에서 안 움직였습니다 — 트리거 핸들러가 선택값으로 되돌리던 옛 결함입니다`,
      );
    });

    await check("★트리거에 포커스가 있어도 ArrowUp 이 반대로 움직인다", async () => {
      await focusTrigger();
      const before = (await state()).active;
      await page.keyboard.press("ArrowUp");
      await page.waitForTimeout(120);
      const after = await state();
      assert.notEqual(after.active, before, "ArrowUp 이 활성 줄을 안 움직였습니다");
    });

    await check("★트리거에 포커스가 있어도 Escape 가 닫는다", async () => {
      await focusTrigger();
      await page.keyboard.press("Escape");
      await page.waitForTimeout(250);
      assert.equal((await state()).open, false, "Escape 가 닫지 않습니다 — QA 가 '가끔 안 닫힌다'고 한 그 상태입니다");
    });

    await check("항목에 포커스가 있을 때도 Escape 가 닫는다(원래 되던 길이 안 깨졌다)", async () => {
      await openPicker();
      await page.evaluate(() => document.querySelector('[role="option"]')?.focus());
      await page.keyboard.press("Escape");
      await page.waitForTimeout(250);
      assert.equal((await state()).open, false);
    });

    await check("★키를 두 번 처리하지 않는다(root 로 옮기며 생길 수 있는 사고)", async () => {
      await openPicker();
      const before = (await state()).active;
      const count = (await state()).count;
      await page.keyboard.press("ArrowDown");
      await page.waitForTimeout(120);
      const after = (await state()).active;
      assert.equal(
        after, (before + 1) % count,
        `ArrowDown 한 번에 ${before} → ${after} 로 갔습니다 — 두 칸이면 핸들러가 두 번 걸린 것입니다`,
      );
      await page.keyboard.press("Escape");
    });

    process.stdout.write(`\nmodel-picker-keys-work-anywhere-contract: ${checks} checks passed\n`);
  } finally {
    await browser.close();
    server.close();
  }
})().catch((error) => { console.error(error); process.exit(1); });
