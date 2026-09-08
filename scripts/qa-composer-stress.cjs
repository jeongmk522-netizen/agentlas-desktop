#!/usr/bin/env node
"use strict";
/*
 * **작성창에 많이 쓸 때** 화면이 버티는지 잰다 — One 과 Work 둘 다.
 *
 * ★왜: One 쪽은 Electron 게이트가 있는데(qa-one-composer-growth) Work 쪽은 없었다.
 *   그리고 둘 다 "줄이 늘어나는" 경우만 봤다 — 실제로 더 자주 깨지는 것은
 *   **띄어쓰기 없는 아주 긴 한 줄**(붙여넣은 주소·해시)이다.
 *
 * 무엇을 재나:
 *   ① 작성창이 창 높이를 넘게 자라지 않는가(스스로 스크롤해야 한다)
 *   ② 보내기 단추가 화면 안에 남아 있는가
 *   ③ 대화가 아직 보이는가(작성창이 화면을 다 먹지 않았는가)
 *   ④ 가로로 새지 않는가
 *
 * 감사 도구다(게이트 아님).
 */
const fs = require("node:fs");
const path = require("node:path");
const { chromium } = require("playwright");
const { setupMockAgentlasBridge, mockBridgeOptions } = require("./lib/mock-agentlas-bridge.cjs");
const { resolveDistDir, startStaticRenderer } = require("./lib/qa-static-renderer.cjs");

const root = path.resolve(__dirname, "..");
const distDir = resolveDistDir(root);

const CASES = [
  { name: "긴 한 줄(띄어쓰기 없음)", text: "a1b2c3d4e5".repeat(140) },
  { name: "붙여넣은 주소 여러 개", text: Array.from({ length: 12 }, (_, i) => `https://example.com/very/long/path/segment/${i}/${"x".repeat(40)}`).join(" ") },
  { name: "40줄", text: Array.from({ length: 40 }, (_, i) => `${i + 1}번째 줄입니다. 여기에 문장을 조금 더 붙입니다.`).join("\n") },
  { name: "긴 한국어 한 줄", text: "정말".repeat(400) },
];

const AUDIT = `(() => {
  const box = document.querySelector("textarea");
  if (!box) return { note: "작성창을 못 찾음" };
  const br = box.getBoundingClientRect();
  /* 보내기 단추 — 작성창을 감싼 상자 안의 마지막 단추로 본다. */
  const shell = box.closest("form, [class*='composer'], [class*='chat-input']") || box.parentElement;
  const buttons = shell ? [...shell.querySelectorAll("button")] : [];
  const send = buttons.find((b) => /보내|send|submit/i.test((b.getAttribute("aria-label") || "") + " " + (b.getAttribute("title") || "")))
    || buttons[buttons.length - 1] || null;
  const sr = send ? send.getBoundingClientRect() : null;
  /* 대화 영역이 아직 보이는가 — 작성창 위쪽에 남은 높이. */
  const above = Math.round(br.top);
  return {
    composerHeight: Math.round(br.height),
    composerBottom: Math.round(br.bottom),
    viewport: innerHeight,
    overflowY: getComputedStyle(box).overflowY,
    sendVisible: Boolean(sr && sr.top >= -2 && sr.bottom <= innerHeight + 2 && sr.left >= -2 && sr.right <= innerWidth + 2),
    sendBox: sr ? { x: Math.round(sr.x), y: Math.round(sr.y), w: Math.round(sr.width), h: Math.round(sr.height) } : null,
    spaceAbove: above,
    pageOverflowX: Math.max(0, document.documentElement.scrollWidth - innerWidth),
  };
})()`;

async function main() {
  if (!fs.existsSync(path.join(distDir, "one.html"))) throw new Error(`dist 가 없습니다: ${distDir} — npm run build:renderer`);
  const { server, baseUrl } = await startStaticRenderer(distDir);
  const browser = await chromium.launch();

  const SIZES = [{ width: 1440, height: 980 }, { width: 1180, height: 820 }, { width: 1024, height: 720 }];
  const SCREENS = [
    { label: "One", url: "/one.html", wait: "main" },
    { label: "Work", url: "/workspace/task.html?id=chat-1", wait: '[data-chat-input="true"]' },
  ];
  const report = [];
  for (const size of SIZES) {
    for (const screen of SCREENS) {
      for (const kase of CASES) {
        const context = await browser.newContext({ viewport: size, locale: "ko-KR" });
        await context.addInitScript(setupMockAgentlasBridge, mockBridgeOptions({ oneConversation: true }));
        await context.addInitScript(() => {
          window.localStorage.setItem("agentlas.locale", "ko");
          window.localStorage.setItem("agentlas.work.firstRunOnboarding.v3", "1");
        });
        const page = await context.newPage();
        try {
          await page.goto(`${baseUrl}${screen.url}`, { waitUntil: "domcontentloaded" });
          await page.waitForSelector(screen.wait, { timeout: 15000 });
          await page.waitForTimeout(900);
          const box = page.locator("textarea").first();
          await box.click({ timeout: 5000 });
          await box.fill(kase.text);
          await page.waitForTimeout(500);
          report.push({ screen: `${screen.label} ${size.width}x${size.height}`, kase: kase.name, ...(await page.evaluate(AUDIT)) });
        } catch (cause) {
          report.push({ screen: `${screen.label} ${size.width}x${size.height}`, kase: kase.name, error: String((cause && cause.message) || cause).slice(0, 140) });
        }
        await context.close();
      }
    }
  }
  await browser.close();
  server.close();

  let total = 0;
  for (const row of report) {
    if (row.error) { console.log(`■ ${row.screen} / ${row.kase} — 열지 못함: ${row.error}`); continue; }
    if (row.note) { console.log(`■ ${row.screen} / ${row.kase} — ${row.note}`); continue; }
    const problems = [];
    if (row.composerHeight > row.viewport * 0.62) problems.push(`작성창이 창의 ${Math.round((row.composerHeight / row.viewport) * 100)}% 를 먹는다`);
    if (row.composerBottom > row.viewport + 2) problems.push("작성창 아래가 화면 밖으로 나간다");
    if (!row.sendVisible) problems.push("보내기 단추가 화면 밖에 있다");
    if (row.spaceAbove < 90) problems.push(`대화가 보일 자리가 ${row.spaceAbove}px 밖에 없다`);
    if (row.pageOverflowX) problems.push(`가로로 ${row.pageOverflowX}px 샌다`);
    if (!problems.length) { console.log(`■ ${row.screen} / ${row.kase} — 괜찮음 (작성창 ${row.composerHeight}px, 위 여백 ${row.spaceAbove}px)`); continue; }
    total += problems.length;
    console.log(`■ ${row.screen} / ${row.kase} — ${problems.join(", ")}`);
    console.log(`     작성창 ${row.composerHeight}px / 창 ${row.viewport}px, 스크롤 ${row.overflowY}, 보내기 ${JSON.stringify(row.sendBox)}`);
  }
  console.log(`\n작성창 스트레스에서 깨진 자리 ${total}건`);
  const out = path.join(root, "docs", "qa-composer-stress.json");
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify(report, null, 2));
  console.log(`기록: ${path.relative(root, out)}`);
}

main().catch((cause) => { console.error(cause); process.exit(1); });
