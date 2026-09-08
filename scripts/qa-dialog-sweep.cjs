#!/usr/bin/env node
"use strict";
/*
 * **대화상자를 실제로 열어서** 잰다.
 *
 * ★왜: 지금까지의 화면 훑기는 전부 "열려 있는 화면"만 봤다. qa-obstructed-ui 는 스스로
 *   "모달 자체의 가림은 따로 재야 한다"고 적어 두었고, 오너가 사진으로 보낸 결함
 *   (마스코트가 대화상자 단추를 덮어 'Not now' 가 'Not n' 으로 보임)이 바로 그 자리였다.
 *   대화상자는 열어야 존재하므로, 여는 것부터 자동화한다.
 *
 * 무엇을 하나:
 *   ① 화면의 단추를 하나씩 누른다.
 *   ② role="dialog" / aria-modal 이 새로 생기면 그 안을 잰다 — 잘림·가림·닫는 길.
 *   ③ Escape 로 닫고 다음으로. 안 닫히면 그것도 지적(나가는 길이 없다).
 *
 * ★네이티브 대화상자(window.confirm)는 **누르면 세션이 멈춘다.** 그래서 미리 가로채
 *   "취소"로 답하게 만든다 — 파괴적인 길로도 들어가지 않는다.
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

/** 열려 있는 대화상자를 찾아 그 안을 잰다. 페이지 안에서 돈다. */
const AUDIT_DIALOG = `(() => {
  const dialogs = [...document.querySelectorAll('[role="dialog"], [role="alertdialog"], dialog[open], [aria-modal="true"]')]
    .filter((el) => {
      const cs = getComputedStyle(el);
      if (cs.display === "none" || cs.visibility === "hidden") return false;
      const r = el.getBoundingClientRect();
      return r.width > 40 && r.height > 40;
    });
  if (!dialogs.length) return null;
  const el = dialogs[dialogs.length - 1];
  const rect = el.getBoundingClientRect();
  const clipped = [];
  const covered = [];
  const paintsAbove = (a, b) => {
    const za = Number(getComputedStyle(a).zIndex) || 0;
    const zb = Number(getComputedStyle(b).zIndex) || 0;
    if (za !== zb) return za > zb;
    return !!(b.compareDocumentPosition(a) & Node.DOCUMENT_POSITION_FOLLOWING);
  };
  for (const node of el.querySelectorAll("*")) {
    const cs = getComputedStyle(node);
    if (cs.display === "none" || cs.visibility === "hidden") continue;
    const r = node.getBoundingClientRect();
    if (r.width < 6 || r.height < 6) continue;
    const text = (node.textContent || "").replace(/\\s+/g, " ").trim();
    const own = [...node.childNodes].some((c) => c.nodeType === 3 && c.textContent.trim());
    if (own && node.scrollWidth > node.clientWidth + 1 && cs.overflowX !== "auto" && cs.overflowX !== "scroll") {
      clipped.push({ text: text.slice(0, 40), have: node.clientWidth, need: node.scrollWidth, ellipsis: cs.textOverflow === "ellipsis" });
    }
    // 조작 요소가 다른 것에 덮였는가 — 대화상자 밖의 떠 있는 물건이 대표적.
    const interactive = node.matches("button, a[href], input, select, textarea, [role='button']");
    if (!interactive) continue;
    const cx = Math.round(r.x + r.width / 2), cy = Math.round(r.y + r.height / 2);
    if (cx < 0 || cy < 0 || cx > innerWidth || cy > innerHeight) {
      covered.push({ text: text.slice(0, 30), by: "화면 밖", box: Math.round(r.width) + "x" + Math.round(r.height) });
      continue;
    }
    const hit = document.elementFromPoint(cx, cy);
    if (!hit || node === hit || node.contains(hit) || hit.contains(node)) continue;
    if (!paintsAbove(hit, node)) continue;
    covered.push({
      text: text.slice(0, 30),
      by: hit.tagName.toLowerCase() + (typeof hit.className === "string" && hit.className.trim()
        ? "." + hit.className.trim().split(/\\s+/).slice(0, 2).join(".") : ""),
      byText: (hit.textContent || "").replace(/\\s+/g, " ").trim().slice(0, 24),
    });
  }
  const closers = [...el.querySelectorAll('button, [role="button"]')].filter((b) => {
    const label = ((b.getAttribute("aria-label") || "") + " " + (b.textContent || "")).toLowerCase();
    return /close|닫기|취소|cancel|나중에|not now|돌아가/.test(label);
  }).length;
  /*
   * ★팝오버(모델 고르기 같은 것)는 닫는 단추가 없는 게 정상이다 — Escape 와 바깥 클릭으로
   *   닫힌다. 모달(aria-modal / alertdialog)만 "닫는 단추" 를 요구한다.
   *   구분 안 하면 멀쩡한 드롭다운 8개가 전부 지적으로 뜬다(첫 판이 그랬다).
   */
  const modal = el.getAttribute("aria-modal") === "true" || el.getAttribute("role") === "alertdialog";
  return {
    modal,
    label: (el.getAttribute("aria-label") || el.querySelector("h1,h2,h3,strong")?.textContent || "").replace(/\\s+/g, " ").trim().slice(0, 40),
    box: Math.round(rect.width) + "x" + Math.round(rect.height),
    offscreen: rect.top < -2 || rect.left < -2 || rect.bottom > innerHeight + 2 || rect.right > innerWidth + 2,
    closers,
    clipped, covered,
  };
})()`;

const HAS_DIALOG = `(() => !!document.querySelector('[role="dialog"], [role="alertdialog"], dialog[open], [aria-modal="true"]'))()`;

async function sweepScreen(page, baseUrl, screen, size) {
  const findings = [];
  let opened = 0;
  const buttons = await page.evaluate(`(() => {
    const out = [];
    let n = 0;
    for (const el of document.querySelectorAll('button:not([disabled]), [role="button"]')) {
      const r = el.getBoundingClientRect();
      if (r.width < 6 || r.height < 6) continue;
      if (r.x < 0 || r.y < 0 || r.x > innerWidth - 2 || r.y > innerHeight - 2) continue;
      el.setAttribute("data-dlgqa", String(n));
      out.push({ key: String(n), label: (el.getAttribute("aria-label") || el.textContent || "").replace(/\\s+/g, " ").trim().slice(0, 30) });
      n += 1;
    }
    return out;
  })()`);
  for (const button of buttons) {
    const target = page.locator(`[data-dlgqa="${button.key}"]`);
    try {
      if (await target.count() === 0) continue;
      await target.first().click({ timeout: 1500, noWaitAfter: true });
    } catch { continue; }
    await page.waitForTimeout(220);
    let verdict = null;
    try { verdict = await page.evaluate(AUDIT_DIALOG); } catch { verdict = null; }
    if (verdict) {
      opened += 1;
      await page.keyboard.press("Escape");
      await page.waitForTimeout(180);
      let stillOpen = false;
      try { stillOpen = await page.evaluate(HAS_DIALOG); } catch { stillOpen = false; }
      /*
       * ★닫은 뒤 초점이 어디로 가는가. body 로 떨어지면 키보드 사용자는 **문서 맨 위부터
       *   다시 Tab** 해야 한다. 공용 레이어(useDismissibleLayer)는 연 단추로 되돌려 주는데,
       *   손으로 쓴 Escape 처리는 대부분 그러지 않는다.
       */
      let focusLost = false;
      if (!stillOpen) {
        try {
          focusLost = await page.evaluate(`(() => {
            const el = document.activeElement;
            return !el || el === document.body || el === document.documentElement;
          })()`);
        } catch { focusLost = false; }
      }
      const problems = [];
      if (verdict.offscreen) problems.push("창 밖으로 나감");
      if (verdict.clipped.some((c) => !c.ellipsis)) problems.push(`글자 잘림 ${verdict.clipped.filter((c) => !c.ellipsis).length}`);
      if (verdict.covered.length) problems.push(`가림 ${verdict.covered.length}`);
      if (verdict.modal && !verdict.closers) problems.push("닫는 단추 없음");
      if (stillOpen) problems.push("Escape 로 안 닫힘");
      if (focusLost) problems.push("닫은 뒤 초점을 잃음");
      if (problems.length) findings.push({ opener: button.label, dialog: verdict.label, box: verdict.box, problems, detail: { clipped: verdict.clipped.filter((c) => !c.ellipsis).slice(0, 4), covered: verdict.covered.slice(0, 4) } });
      if (stillOpen) {
        // 못 닫으면 화면을 다시 연다 — 그 상태로 다음 단추를 누르면 그 뒤가 전부 오염된다.
        await page.goto(`${baseUrl}${screen.url}`, { waitUntil: "domcontentloaded" });
        await page.waitForSelector(screen.wait, { timeout: 15000 }).catch(() => {});
        await page.waitForTimeout(500);
        await page.evaluate(`(() => { let n = 0; for (const el of document.querySelectorAll('button:not([disabled]), [role="button"]')) el.setAttribute("data-dlgqa", String(n++)); })()`);
      }
    }
    // 화면이 바뀌었으면 되돌린다.
    if (!page.url().includes(screen.url.split("?")[0])) {
      await page.goto(`${baseUrl}${screen.url}`, { waitUntil: "domcontentloaded" });
      await page.waitForSelector(screen.wait, { timeout: 15000 }).catch(() => {});
      await page.waitForTimeout(500);
      await page.evaluate(`(() => { let n = 0; for (const el of document.querySelectorAll('button:not([disabled]), [role="button"]')) el.setAttribute("data-dlgqa", String(n++)); })()`);
    }
  }
  return { findings, opened, tried: buttons.length };
}

async function main() {
  if (!fs.existsSync(path.join(distDir, "one.html"))) throw new Error(`dist 가 없습니다: ${distDir} — npm run build:renderer`);
  const { server, baseUrl } = await startStaticRenderer(distDir);
  const browser = await chromium.launch();

  /* ★0 건을 보고하기 전에 검사기가 뭔가를 잡는지 본다. */
  {
    const p = await browser.newPage();
    await p.setContent(`<div role="dialog" aria-label="심은 결함" style="position:fixed;left:20px;top:20px;width:300px;height:160px;background:#fff;z-index:1">
      <div style="width:80px;overflow:hidden;white-space:nowrap">아주 긴 글자가 들어가서 잘린다</div>
      <button style="position:absolute;left:10px;top:100px;width:120px;height:40px">확인</button>
      </div>
      <div style="position:fixed;left:20px;top:110px;width:200px;height:60px;background:red;z-index:9">덮개</div>`);
    const v = await p.evaluate(AUDIT_DIALOG);
    await p.close();
    if (!v) throw new Error("대화상자 검사기가 대화상자를 못 찾습니다");
    if (!v.clipped.length) throw new Error("잘림 검사기가 심은 고장을 못 잡습니다");
    if (!v.covered.length) throw new Error("가림 검사기가 심은 고장을 못 잡습니다");
    if (v.closers !== 0) throw new Error("닫는 단추 판정이 이상합니다");
  }

  const SIZES = process.env.DLG_QA_SIZES === "grid"
    ? [{ width: 1920, height: 1055 }, { width: 1440, height: 980 }, { width: 1180, height: 820 }]
    : [{ width: 1440, height: 980 }];
  const screens = process.env.DLG_QA_ONE
    ? [{ label: process.env.DLG_QA_ONE, url: `/${process.env.DLG_QA_ONE}.html`, wait: "body" }]
    : process.env.DLG_QA_ALL ? builtScreens(distDir) : [
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
        /*
         * ★네이티브 대화상자를 누르면 브라우저가 통째로 멈춘다 — 순회가 거기서 끝난다.
         *   전부 "취소" 로 답하게 가로챈다. 파괴적인 길로도 들어가지 않는다.
         */
        window.confirm = () => false;
        window.alert = () => undefined;
        window.prompt = () => null;
      });
      const page = await context.newPage();
      try {
        await page.goto(`${baseUrl}${screen.url}`, { waitUntil: "domcontentloaded" });
        await page.waitForSelector(screen.wait, { timeout: 15000 });
        await page.waitForTimeout(700);
        report.push({ screen: screen.label, size: `${size.width}x${size.height}`, ...(await sweepScreen(page, baseUrl, screen, size)) });
      } catch (cause) {
        report.push({ screen: screen.label, size: `${size.width}x${size.height}`, error: String((cause && cause.message) || cause).slice(0, 180) });
      }
      await context.close();
    }
  }
  await browser.close();
  server.close();

  let total = 0;
  let openedTotal = 0;
  for (const row of report) {
    if (row.error) { console.log(`\n■ ${row.screen} (${row.size}) — 열지 못함: ${row.error}`); continue; }
    openedTotal += row.opened;
    total += row.findings.length;
    console.log(`\n■ ${row.screen} (${row.size}) — 단추 ${row.tried}개를 눌러 대화상자 ${row.opened}개를 열었고, 지적 ${row.findings.length}건`);
    for (const f of row.findings) {
      console.log(`   [${f.opener}] → "${f.dialog}" ${f.box} — ${f.problems.join(", ")}`);
      for (const c of f.detail.clipped) console.log(`       잘림 "${c.text}" ${c.have}px 자리에 ${c.need}px`);
      for (const c of f.detail.covered) console.log(`       가림 "${c.text}" ← ${c.by} "${c.byText ?? ""}"`);
    }
  }
  console.log(`\n대화상자 ${openedTotal}개를 열었고 지적 ${total}건`);
  const out = path.join(root, "docs", "qa-dialog-sweep.json");
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify(report, null, 2));
  console.log(`기록: ${path.relative(root, out)}`);
}

main().catch((cause) => { console.error(cause); process.exit(1); });
