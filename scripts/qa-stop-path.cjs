#!/usr/bin/env node
"use strict";
/*
 * **멈출 수 있는가** 를 잰다 — 실행이 안 끝나는 상황을 만들어서.
 *
 * ★왜: 실행이 길어지거나 걸렸을 때 사용자가 할 수 있는 유일한 일이 "멈추기" 다.
 *   그 길이 화면에 없거나, 눌러도 아무 일이 없거나, 눌렀는데 계속 "실행 중" 이면
 *   사용자는 앱을 강제로 끄는 수밖에 없다.
 *
 * 어떻게: invoke.run 을 **끝나지 않게** 만들고 글을 보낸 뒤,
 *   ① 멈추는 조작이 화면에 나타나는가
 *   ② 눌렀을 때 엔진에 취소가 실제로 나가는가(호출을 센다)
 *   ③ 취소가 실패해도 화면이 그 사실을 말하는가
 *
 * ★이 도구가 지금 재는 것과 못 재는 것 (2026-09-08):
 *   - 잰다: **보내고 나서 실행이 시작되기까지의 창**. mock 의 run() 을 6초 늦춰 만든다.
 *     이 창에서 Work 는 "전송 중..." 만 보여 주고 **멈추는 조작이 없다**. 런타임이
 *     차갑게 시작하면 실제로 몇 초씩 걸리는 구간이라 사용자가 갇힌다.
 *   - 못 잰다: **실행이 시작된 뒤** 오래 도는 상태. mock 은 run() 이 끝나는 즉시
 *     답을 넣어 그 상태를 만들 수 없다. 그러니 여기서 "멈추는 단추가 없다" 를
 *     제품 전체의 결론으로 읽으면 안 된다.
 *   - 고치지 않은 이유: 시작 중 취소는 엔진이 **취소 가능한 시작**을 갖고 있어야 한다.
 *     렌더러만 고쳐 "취소했다" 고 말하면 Main 에는 실행이 남아 더 나쁘다(반쪽 수리).
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

const HANG_RUN = (cancelBehaviour) => {
  window.__cancelCalls = 0;
  const patch = (api) => {
    if (!api || !api.invoke) return false;
    /*
     * ★"실행이 안 끝난다" 를 run() 프라미스를 멈춰서 흉내내면 안 된다 (첫 판의 오류).
     *   실제 제품에서 run() 은 **시작만 하고 곧 끝난다** — 진행은 이벤트로 온다.
     *   프라미스를 멈추면 화면은 "전송 중" 단계에 갇히고, 그건 실제로는 없는 상태다.
     *   그래서 run() 은 그대로 두고 **끝났다는 이벤트만 오지 않게** 한다.
     */
    /*
     * ★끝나는 이벤트를 **가로채서 버린다.** mock 은 run() 직후 종료 이벤트를 쏘는데,
     *   그러면 "오래 도는 실행" 을 흉내낼 수 없다. 이벤트 구독 자리에서 종료 계열만
     *   막으면 화면은 진짜로 "도는 중" 에 머문다.
     */
    /*
     * ★답이 **늦게 오는** 상태를 만든다. mock 은 run() 이 끝나는 즉시 답을 넣어
     *   "도는 중" 이 0초라 멈추는 단추를 볼 틈이 없다. 6초 늦춰 그 창을 연다.
     */
    const originalRun = api.invoke.run.bind(api.invoke);
    api.invoke.run = async (payload) => {
      await new Promise((resolve) => setTimeout(resolve, 6000));
      return originalRun(payload);
    };
    const events = window.agentlasEvents;
    if (events && typeof events.on === "function" && !events.__qaWrapped) {
      const originalOn = events.on.bind(events);
      events.on = (channel, handler) => originalOn(channel, (...args) => {
        const payload = args[0];
        const kind = payload && (payload.kind || payload.type || payload.status);
        if (typeof kind === "string" && /completed|failed|cancelled|interrupted|terminal|done|end/i.test(kind)) return;
        return handler(...args);
      });
      events.__qaWrapped = true;
    }
    const names = ["cancel", "stop", "abort"];
    for (const name of names) {
      if (typeof api.invoke[name] === "function") {
        api.invoke[name] = async () => {
          window.__cancelCalls += 1;
          if (cancelBehaviour === "fail") throw new Error("cancel_refused_by_engine");
          return { ok: true };
        };
      }
    }
    return true;
  };
  if (!patch(window.agentlas)) {
    let current;
    Object.defineProperty(window, "agentlas", {
      configurable: true, get: () => current,
      set: (value) => { current = value; patch(value); },
    });
  }
};

const FIND_STOP = `(() => {
  const wanted = /멈추|중지|중단|취소|stop|cancel/i;
  const buttons = [...document.querySelectorAll('button:not([disabled]), [role="button"]')].filter((el) => {
    const r = el.getBoundingClientRect();
    if (r.width < 6 || r.height < 6) return false;
    const label = (el.getAttribute("aria-label") || "") + " " + (el.getAttribute("title") || "") + " " + (el.textContent || "");
    return wanted.test(label);
  });
  return buttons.map((el, i) => {
    el.setAttribute("data-stopqa", String(i));
    return { key: String(i), label: ((el.getAttribute("aria-label") || el.textContent || "").replace(/\\s+/g, " ").trim()).slice(0, 30) };
  });
})()`;

const STATE = `(() => ({
  cancels: window.__cancelCalls || 0,
  text: (document.body.innerText || "").replace(/\\s+/g, " ").trim().slice(0, 400),
}))()`;

async function main() {
  if (!fs.existsSync(path.join(distDir, "one.html"))) throw new Error(`dist 가 없습니다: ${distDir} — npm run build:renderer`);
  const { server, baseUrl } = await startStaticRenderer(distDir);
  const browser = await chromium.launch();

  const SCREENS = [
    { label: "One", url: "/one.html", wait: "main" },
    { label: "Work", url: "/workspace/task.html?id=chat-1", wait: '[data-chat-input="true"]' },
  ];
  const report = [];
  for (const screen of SCREENS) {
    for (const behaviour of ["ok", "fail"]) {
      const context = await browser.newContext({ viewport: { width: 1440, height: 980 }, locale: "ko-KR" });
      await context.addInitScript(setupMockAgentlasBridge, mockBridgeOptions({ oneConversation: true }));
      await context.addInitScript(HANG_RUN, behaviour);
      await context.addInitScript(() => {
        window.localStorage.setItem("agentlas.locale", "ko");
        window.localStorage.setItem("agentlas.work.firstRunOnboarding.v3", "1");
        window.confirm = () => true;
        window.alert = () => undefined;
      });
      const page = await context.newPage();
      try {
        await page.goto(`${baseUrl}${screen.url}`, { waitUntil: "domcontentloaded" });
        await page.waitForSelector(screen.wait, { timeout: 15000 });
        await page.waitForTimeout(900);
        const box = page.locator("textarea").first();
        await box.click();
        await box.fill("끝나지 않는 작업 시험");
        await page.keyboard.press("Enter");
        await page.waitForTimeout(2500);
        const stops = await page.evaluate(FIND_STOP);
        let clicked = false;
        if (stops.length) {
          try {
            await page.locator(`[data-stopqa="${stops[0].key}"]`).first().click({ timeout: 2000 });
            clicked = true;
          } catch { /* 못 눌렀다는 사실도 결과다 */ }
        }
        await page.waitForTimeout(1500);
        const state = await page.evaluate(STATE);
        report.push({
          screen: screen.label,
          behaviour,
          stopButtons: stops.map((s) => s.label),
          clicked,
          cancels: state.cancels,
          saysStopping: /멈추|중지|중단|취소|stopping|cancel/i.test(state.text),
          saysFailure: /못 |못했|실패|다시|could not|failed/i.test(state.text),
          text: state.text.slice(0, 160),
        });
      } catch (cause) {
        report.push({ screen: screen.label, behaviour, error: String((cause && cause.message) || cause).slice(0, 140) });
      }
      await context.close();
    }
  }
  await browser.close();
  server.close();

  let bad = 0;
  for (const row of report) {
    if (row.error) { console.log(`■ ${row.screen} / 취소 ${row.behaviour} — 재지 못함: ${row.error}`); continue; }
    const problems = [];
    if (!row.stopButtons.length) problems.push("보내고 실행이 시작되기까지의 창에 멈추는 조작이 없다");
    else if (!row.clicked) problems.push("멈추는 단추를 누를 수 없었다");
    else if (row.cancels === 0) problems.push("눌렀는데 엔진에 취소가 안 나갔다");
    if (row.behaviour === "fail" && row.cancels > 0 && !row.saysFailure) problems.push("취소가 거절됐는데 화면이 아무 말이 없다");
    if (!problems.length) {
      console.log(`■ ${row.screen} / 취소 ${row.behaviour} — 멈출 수 있다 (단추 "${row.stopButtons[0]}", 취소 호출 ${row.cancels}번)`);
      continue;
    }
    bad += problems.length;
    console.log(`■ ${row.screen} / 취소 ${row.behaviour} — ${problems.join(", ")}`);
    console.log(`     단추: ${row.stopButtons.join(" · ") || "(없음)"} / 취소 호출 ${row.cancels}번`);
    console.log(`     화면: ${row.text}`);
  }
  console.log(`\n멈추는 길에서 어긋난 자리 ${bad}건`);
  const out = path.join(root, "docs", "qa-stop-path.json");
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify(report, null, 2));
  console.log(`기록: ${path.relative(root, out)}`);
}

main().catch((cause) => { console.error(cause); process.exit(1); });
