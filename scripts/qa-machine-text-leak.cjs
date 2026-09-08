#!/usr/bin/env node
"use strict";
/*
 * 엔진이 낸 **기계 문자열이 화면에 그대로 뜨는지** 훑는다.
 *
 * ★왜: 엔진의 오류 문구 중 상당수가 사람 문장이 아니라 식별자다 —
 *   `untrusted-site-publish-ipc-sender`, `native-publish-approval-contract-invalid`,
 *   `goal_contract_not_created` 같은 것들. 그게 그대로 뜨면 사용자는 무엇을 해야
 *   하는지 알 수 없다. 어떤 자리가 엔진 문구를 **그대로** 보여 주는지 실제로 잰다.
 *
 * 어떻게: 바꾸는 성격의 브리지 메서드를 전부 **정해진 기계 토큰**으로 거절하게 만들고,
 *   화면의 단추를 눌러 본 뒤 그 토큰이 화면 글자에 나타나는지 본다.
 *   나타나면 그 자리는 엔진 문구를 사람 문장으로 옮기지 않고 그대로 흘리고 있다.
 *
 * ★읽기는 건드리지 않는다 — 화면이 안 그려지면 아무것도 못 잰다.
 * 감사 도구다(게이트 아님).
 */
const fs = require("node:fs");
const path = require("node:path");
const { chromium } = require("playwright");
const { setupMockAgentlasBridge, mockBridgeOptions } = require("./lib/mock-agentlas-bridge.cjs");
const { resolveDistDir, startStaticRenderer, builtScreens } = require("./lib/qa-static-renderer.cjs");

const root = path.resolve(__dirname, "..");
const distDir = resolveDistDir(root);
const TOKEN = "machine-token-probe-9f3a2";

const BREAK_MUTATIONS = (token) => {
  const MUTATING = /^(save|create|update|delete|remove|set[A-Z]|run|start|stop|cancel|install|uninstall|publish|approve|reject|import|export|connect|disconnect|toggle|add|apply|retry|pair|revoke|rename|archive|unarchive|submit|send|define|clear|move|reorder|upload|prepare|activate|deactivate|enable|disable)/;
  const patch = (node, depth) => {
    if (!node || depth > 3) return;
    for (const key of Object.keys(node)) {
      const value = node[key];
      if (typeof value === "function") {
        if (MUTATING.test(key)) {
          node[key] = async () => { throw new Error(token); };
        }
      } else if (value && typeof value === "object") {
        patch(value, depth + 1);
      }
    }
  };
  const install = () => {
    if (!window.agentlas) return false;
    patch(window.agentlas, 0);
    return true;
  };
  if (!install()) {
    let current;
    Object.defineProperty(window, "agentlas", {
      configurable: true,
      get: () => current,
      set: (value) => { current = value; if (value) patch(value, 0); },
    });
  }
};

async function sweepScreen(page, token) {
  const leaks = [];
  const buttons = await page.evaluate(`(() => {
    let n = 0;
    const out = [];
    for (const el of document.querySelectorAll('button:not([disabled]), [role="button"]')) {
      const r = el.getBoundingClientRect();
      if (r.width < 6 || r.height < 6) continue;
      if (r.x < 0 || r.y < 0 || r.x > innerWidth - 2 || r.y > innerHeight - 2) continue;
      el.setAttribute("data-mtqa", String(n));
      out.push({ key: String(n), label: (el.getAttribute("aria-label") || el.textContent || "").replace(/\\s+/g, " ").trim().slice(0, 30) });
      n += 1;
    }
    return out;
  })()`);
  for (const button of buttons) {
    const target = page.locator(`[data-mtqa="${button.key}"]`);
    try {
      if (await target.count() === 0) continue;
      await target.first().click({ timeout: 1200, noWaitAfter: true });
    } catch { continue; }
    await page.waitForTimeout(180);
    let shown = false;
    try {
      shown = await page.evaluate((t) => (document.body.innerText || "").includes(t), token);
    } catch { continue; }
    if (shown) {
      const where = await page.evaluate((t) => {
        const node = [...document.querySelectorAll("*")].reverse()
          .find((el) => el.children.length === 0 && (el.textContent || "").includes(t));
        return node ? (node.parentElement?.textContent || node.textContent || "").replace(/\s+/g, " ").trim().slice(0, 120) : "";
      }, token);
      leaks.push({ opener: button.label, shown: where });
      await page.keyboard.press("Escape");
      await page.waitForTimeout(120);
    }
  }
  return { leaks, tried: buttons.length };
}

async function main() {
  if (!fs.existsSync(path.join(distDir, "one.html"))) throw new Error(`dist 가 없습니다: ${distDir} — npm run build:renderer`);
  const { server, baseUrl } = await startStaticRenderer(distDir);
  const browser = await chromium.launch();

  /* ★검사기 자체 확인 — 토큰을 화면에 그리면 잡는가. */
  {
    const p = await browser.newPage();
    await p.setContent(`<button onclick="document.getElementById('o').textContent='실패: ${TOKEN}'">누르기</button><div id="o"></div>`);
    const { leaks } = await sweepScreen(p, TOKEN);
    await p.close();
    if (!leaks.length) throw new Error("검사기가 심어 둔 유출을 못 잡습니다 — 이 실행의 0건은 의미가 없습니다");
  }

  const screens = process.env.MT_QA_ALL ? builtScreens(distDir) : [
    { label: "one", url: "/one.html", wait: "main" },
    { label: "workspace/task", url: "/workspace/task.html?id=chat-1", wait: '[data-chat-input="true"]' },
    { label: "index", url: "/index.html", wait: "main" },
    { label: "settings", url: "/settings.html", wait: "main" },
  ];
  const report = [];
  for (const screen of screens) {
    const context = await browser.newContext({ viewport: { width: 1440, height: 980 }, locale: "ko-KR" });
    await context.addInitScript(setupMockAgentlasBridge, mockBridgeOptions({ oneConversation: true }));
    await context.addInitScript(BREAK_MUTATIONS, TOKEN);
    await context.addInitScript(() => {
      window.localStorage.setItem("agentlas.locale", "ko");
      window.localStorage.setItem("agentlas.work.firstRunOnboarding.v3", "1");
      window.confirm = () => true;   // 확인 대화상자는 통과시켜야 그 뒤 실패를 볼 수 있다
      window.alert = () => undefined;
      window.prompt = () => null;
    });
    const page = await context.newPage();
    try {
      await page.goto(`${baseUrl}${screen.url}`, { waitUntil: "domcontentloaded" });
      await page.waitForSelector(screen.wait, { timeout: 15000 });
      await page.waitForTimeout(800);
      report.push({ screen: screen.label, ...(await sweepScreen(page, TOKEN)) });
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
    if (!row.leaks.length) { console.log(`■ ${row.screen} — 단추 ${row.tried}개, 유출 0건`); continue; }
    total += row.leaks.length;
    console.log(`■ ${row.screen} — 단추 ${row.tried}개, 유출 ${row.leaks.length}건`);
    for (const leak of row.leaks) console.log(`   [${leak.opener}] → "${leak.shown}"`);
  }
  console.log(`\n기계 문자열이 그대로 뜬 자리 ${total}건`);
  const out = path.join(root, "docs", "qa-machine-text-leak.json");
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify(report, null, 2));
  console.log(`기록: ${path.relative(root, out)}`);
}

main().catch((cause) => { console.error(cause); process.exit(1); });
