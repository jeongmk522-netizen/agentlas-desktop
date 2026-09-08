#!/usr/bin/env node
"use strict";
/*
 * **실패했는데 "됐습니다" 라고 말하는 자리**를 훑는다.
 *
 * ★왜: 이 저장소가 가장 크게 데었던 계열이다 — 실패를 사실로 승격시키는 것.
 *   "저장됨", "복사됨", "추가했습니다" 는 사용자가 그 뒤로 아무것도 확인하지 않게
 *   만든다. 그래서 거짓 성공은 침묵보다 나쁘다.
 *
 * 어떻게: 바꾸는 성격의 브리지 메서드를 **전부 거절**하게 만들고 단추를 눌러 본 뒤,
 *   화면에 성공 문구가 새로 나타나면 지적한다. 아무것도 성공할 수 없는 상태이므로
 *   그 문구는 반드시 거짓이다.
 *
 * ★기준선을 먼저 찍는다 — 원래 화면에 있던 "완료" 같은 낱말을 새 문구로 오인하면
 *   목록이 통째로 오탐이 된다.
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

const SUCCESS = /저장했|저장됨|저장 완료|복사했|복사됨|추가했|추가됨|삭제했|삭제됨|연결했|연결됨|보냈습니다|완료했|완료됨|성공|적용했|적용됨|올렸습니다|발행했|설치했|설치됨|saved|copied|added|removed|deleted|connected|published|installed|applied|done|success/i;

const BREAK_MUTATIONS = (token) => {
  const MUTATING = /^(save|create|update|delete|remove|run|start|stop|cancel|install|uninstall|publish|approve|reject|import|export|connect|disconnect|toggle|add|apply|retry|pair|revoke|rename|archive|unarchive|submit|send|define|clear|move|reorder|upload|prepare|activate|deactivate|enable|disable|set[A-Z])/;
  const patch = (node, depth) => {
    if (!node || depth > 3) return;
    for (const key of Object.keys(node)) {
      const value = node[key];
      if (typeof value === "function") {
        if (MUTATING.test(key)) node[key] = async () => { throw new Error(token); };
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
  // 클립보드도 실패하게 만든다 — "복사됨" 이 가장 흔한 거짓 성공이다.
  try {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      get: () => ({ writeText: async () => { throw new Error(token); }, write: async () => { throw new Error(token); } }),
    });
  } catch { /* 못 바꾸면 그 항목만 못 잰다 */ }
};

/*
 * ★화면 글자 전체를 보면 안 된다 — 단추 라벨("이미 설치했습니다"), 상태 뱃지("연결됨"),
 *   언어 전환으로 새로 나타난 영어 낱말까지 전부 "거짓 성공" 으로 읽힌다(첫 판 3건이
 *   전부 그랬다). **알림을 내는 자리**만 본다.
 */
/*
 * ★화면 글자 전체를 보면 안 된다 — 단추 라벨("이미 설치했습니다"), 상태 뱃지("연결됨"),
 *   언어 전환으로 새로 나타난 영어 낱말까지 전부 "거짓 성공" 으로 읽힌다(첫 판 3건이
 *   전부 그랬다). 그렇다고 role="status" 만 보면 그 표식이 없는 알림을 놓친다.
 *   **누를 수 없는 잎 요소의 글자**만 본다 — 알림은 여기 들어오고 라벨은 빠진다.
 */
const PAGE_WORDS = `(() => {
  const out = [];
  for (const el of document.querySelectorAll("*")) {
    if (el.children.length) continue;
    if (el.closest('button, a, [role="button"], [role="tab"], label, option, select, textarea, input')) continue;
    const text = (el.textContent || "").trim();
    if (text) out.push(text);
  }
  return out.join(" ").replace(/\s+/g, " ").trim();
})()`;

async function sweepScreen(page) {
  /* ★다른 화면으로 넘어가면 그 화면의 원래 글자가 전부 "새 낱말" 이 된다 — 그건 주장이 아니다. */
  const startUrl = page.url().split("?")[0];
  const base = await page.evaluate(PAGE_WORDS);
  const baseWords = new Set(base.split(/\s+/));
  const findings = [];
  const buttons = await page.evaluate(`(() => {
    let n = 0; const out = [];
    for (const el of document.querySelectorAll('button:not([disabled]), [role="button"]')) {
      const r = el.getBoundingClientRect();
      if (r.width < 6 || r.height < 6) continue;
      if (r.x < 0 || r.y < 0 || r.x > innerWidth - 2 || r.y > innerHeight - 2) continue;
      el.setAttribute("data-fsqa", String(n));
      out.push({ key: String(n), label: (el.getAttribute("aria-label") || el.textContent || "").replace(/\\s+/g, " ").trim().slice(0, 30) });
      n += 1;
    }
    return out;
  })()`);
  for (const button of buttons) {
    const target = page.locator(`[data-fsqa="${button.key}"]`);
    try {
      if (await target.count() === 0) continue;
      await target.first().click({ timeout: 1200, noWaitAfter: true });
    } catch { continue; }
    await page.waitForTimeout(200);
    if (page.url().split("?")[0] !== startUrl) {
      await page.goBack({ waitUntil: "domcontentloaded" }).catch(() => {});
      await page.waitForTimeout(400);
      continue;
    }
    let text = "";
    try { text = await page.evaluate(PAGE_WORDS); } catch { continue; }
    const fresh = text.split(/\s+/).filter((w) => !baseWords.has(w));
    const claim = fresh.filter((w) => SUCCESS.test(w));
    if (claim.length) {
      findings.push({ opener: button.label, claim: [...new Set(claim)].slice(0, 6) });
      for (const word of claim) baseWords.add(word);   // 같은 문구를 화면마다 반복 보고하지 않는다
    }
    await page.keyboard.press("Escape").catch(() => {});
    await page.waitForTimeout(90);
  }
  return { findings, tried: buttons.length };
}

async function main() {
  if (!fs.existsSync(path.join(distDir, "one.html"))) throw new Error(`dist 가 없습니다: ${distDir} — npm run build:renderer`);
  const { server, baseUrl } = await startStaticRenderer(distDir);
  const browser = await chromium.launch();

  /* ★자체 확인 — 거짓 성공을 심으면 잡는가. */
  {
    const p = await browser.newPage();
    await p.setContent(`<button onclick="document.getElementById('o').textContent='저장했습니다'">저장</button><div id="o" role="status"></div>`);
    const { findings } = await sweepScreen(p);
    await p.close();
    if (!findings.length) throw new Error("검사기가 심어 둔 거짓 성공을 못 잡습니다 — 이 실행의 0건은 의미가 없습니다");
  }

  const screens = process.env.FS_QA_ALL ? builtScreens(distDir) : [
    { label: "one", url: "/one.html", wait: "main" },
    { label: "workspace/task", url: "/workspace/task.html?id=chat-1", wait: '[data-chat-input="true"]' },
    { label: "index", url: "/index.html", wait: "main" },
    { label: "settings", url: "/settings.html", wait: "main" },
    { label: "library/agents", url: "/library/agents.html", wait: "main" },
  ];
  const report = [];
  for (const screen of screens) {
    const context = await browser.newContext({ viewport: { width: 1440, height: 980 }, locale: "ko-KR" });
    await context.addInitScript(setupMockAgentlasBridge, mockBridgeOptions({ oneConversation: true }));
    await context.addInitScript(BREAK_MUTATIONS, "mutation-always-fails-probe");
    await context.addInitScript(() => {
      window.localStorage.setItem("agentlas.locale", "ko");
      window.localStorage.setItem("agentlas.work.firstRunOnboarding.v3", "1");
      window.confirm = () => true;
      window.alert = () => undefined;
      window.prompt = () => null;
    });
    const page = await context.newPage();
    try {
      await page.goto(`${baseUrl}${screen.url}`, { waitUntil: "domcontentloaded" });
      await page.waitForSelector(screen.wait, { timeout: 15000 });
      await page.waitForTimeout(800);
      report.push({ screen: screen.label, ...(await sweepScreen(page)) });
    } catch (cause) {
      report.push({ screen: screen.label, error: String((cause && cause.message) || cause).slice(0, 160) });
    }
    await context.close();
  }
  await browser.close();
  server.close();

  let total = 0;
  for (const row of report) {
    if (row.error) { console.log(`■ ${row.screen} — 열지 못함: ${row.error}`); continue; }
    if (!row.findings.length) { console.log(`■ ${row.screen} — 단추 ${row.tried}개, 거짓 성공 0건`); continue; }
    total += row.findings.length;
    console.log(`■ ${row.screen} — 단추 ${row.tried}개, 거짓 성공 ${row.findings.length}건`);
    for (const f of row.findings) console.log(`   [${f.opener}] → ${f.claim.join(" · ")}`);
  }
  console.log(`\n아무것도 성공할 수 없는데 "됐다" 고 말한 자리 ${total}건`);
  const out = path.join(root, "docs", "qa-false-success.json");
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify(report, null, 2));
  console.log(`기록: ${path.relative(root, out)}`);
}

main().catch((cause) => { console.error(cause); process.exit(1); });
