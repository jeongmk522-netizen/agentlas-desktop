#!/usr/bin/env node
"use strict";

// 색상 마이그레이션(하드코딩 색 리터럴 5,648곳 -> 디자인 토큰) 이후 대비 회귀를 잡는
// 임시 감사 스크립트. dist/renderer 정적 산출물 + mock 브리지 + playwright 로 4개
// 화면(One 홈, 열린 One 대화, 결과 레일이 열린 Work 채팅, Settings)을 띄우고, 화면의
// 모든 텍스트 노드에 대해 계산된 color 와 가장 가까운 불투명 조상 background-color
// 사이의 WCAG 대비비를 잰다. 3.0 미만(큰 텍스트 하한)과 "글자색==배경색"(완전히
// 안 보임) 쌍을 报告한다.
//
// 공유 체크아웃 주의: 다른 세션이 build:renderer 로 dist/renderer 를 지웠다 다시 채울
// 수 있다. COLOUR_QA_DIST 로 스냅샷 디렉터리를 지정할 수 있다(qa-agentlas-one-grid.cjs,
// qa-work-grid.cjs 관행과 동일).

const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const { chromium } = require("playwright");
const { setupMockAgentlasBridge, mockBridgeOptions } = require("./lib/mock-agentlas-bridge.cjs");

const root = path.resolve(__dirname, "..");
const distDir = process.env.COLOUR_QA_DIST
  ? path.resolve(process.env.COLOUR_QA_DIST)
  : path.join(root, "dist", "renderer");
const outDir = path.join(root, "output", "playwright", "colour-migration");
const MIN_CONTRAST = 3.0;

const MIME = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8", ".json": "application/json; charset=utf-8",
  ".png": "image/png", ".svg": "image/svg+xml", ".woff2": "font/woff2", ".txt": "text/plain; charset=utf-8",
};

function resolveAsset(rawUrl) {
  let pathname = decodeURIComponent((rawUrl || "/").split("?")[0]);
  const nestedNext = pathname.match(/^\/.+\/(_next\/.+)$/);
  if (nestedNext) pathname = `/${nestedNext[1]}`;
  if (pathname === "/") pathname = "/index.html";
  const direct = path.join(distDir, pathname.replace(/^\//, ""));
  if (fs.existsSync(direct) && fs.statSync(direct).isFile()) return direct;
  if (!path.extname(pathname)) {
    const html = path.join(distDir, `${pathname.replace(/^\//, "")}.html`);
    if (fs.existsSync(html)) return html;
  }
  return path.join(distDir, "404.html");
}

function startServer() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const file = resolveAsset(req.url);
      res.writeHead(file.endsWith("404.html") ? 404 : 200, { "content-type": MIME[path.extname(file)] || "application/octet-stream" });
      fs.createReadStream(file).pipe(res);
    });
    server.listen(0, "127.0.0.1", () => resolve({ server, baseUrl: `http://127.0.0.1:${server.address().port}` }));
  });
}

// self-contained (addInitScript serializes this alone)
function installOneMockFixture(screen) {
  window.localStorage.setItem("agentlas.locale", "ko");
  const api = window.agentlas;
  const now = "2026-09-05T03:30:00.000Z";
  const chatId = "chat_contrast_001";
  const conversation = {
    id: chatId, taskId: null, projectId: null, firmId: null, agentId: "agent-one",
    kind: "user", originSurface: "one", title: "거실 공기청정기 비교",
    archivedAt: null, createdAt: now, updatedAt: now,
    hiredAgents: [{ slug: "product-researcher", name: "제품 리서처", source: "firm-node", hiredAt: now }],
  };
  const history = [
    { id: "message_user_1", role: "user", text: "거실 공기청정기를 바꾸고 싶은데 뭐부터 봐야 할지 모르겠어.", createdAt: now },
    { id: "message_assistant_1", role: "assistant", text: "먼저 거실 크기와 예산만 알면 후보를 크게 줄일 수 있어요. 지난번 가전 선택에서는 **소음과 관리 편의**를 중요하게 보셨는데, 이번에도 같은 기준을 적용할까요?", createdAt: now },
    { id: "message_user_2", role: "user", text: "응. 25평 거실이고 50만원 아래였으면 좋겠어.", createdAt: now },
    { id: "message_assistant_2", role: "assistant", text: "좋아요. 이번에는 **25평·50만원 이하·소음·필터 관리**를 기준으로 비교할게요.", createdAt: now },
  ];
  api.chats.listRecent = async () => (screen === "conversation" ? [conversation] : []);
  api.chats.get = async (id) => (screen === "conversation" && id === chatId ? conversation : null);
  api.invoke.activeChats = async () => [];
  api.invoke.latestReceipt = async () => null;
  api.invoke.latestOneSurface = async () => null;
  api.invoke.history = async (id) => (screen === "conversation" && id === chatId ? history : []);
  api.oneTeamPreflight.getForChat = async () => null;
  api.oneTeamPreflight.prepare = async () => ({ kind: "not_required" });
  api.oneAttachments.forTeam = async () => null;
  api.tasks.listProjections = async () => [];
  api.tasks.list = async () => [];
  api.tasks.get = async () => null;
  api.tasks.findForChat = async () => null;
  api.oneFeatureIntro.getState = async () => null;
  api.oneActivation.getState = async () => null;
  api.oneBriefing.get = async () => null;
}

function newPage(context, label) {
  return context.newPage().then((page) => {
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.__qaErrors = errors;
    page.__qaLabel = label;
    return page;
  });
}

async function gotoTask(page, baseUrl) {
  await page.goto(`${baseUrl}/workspace/task.html?id=chat-1`, { waitUntil: "domcontentloaded" });
  await page.locator('[data-chat-input="true"]').waitFor({ state: "visible", timeout: 20000 });
}

async function startRun(page, prompt) {
  const runs = () => page.evaluate(() => window.__qa.calls.filter((c) => c.name === "invoke.run"));
  const before = (await runs()).length;
  await page.locator('[data-chat-input="true"]').fill(prompt);
  await page.locator(".chat-input-send-button").click();
  await page.waitForFunction((n) => window.__qa.calls.filter((c) => c.name === "invoke.run").length > n, before, { timeout: 20000 });
  const runId = (await runs()).at(-1).payload.runId;
  await page.waitForFunction((channel) => (window.__agentlasEventRegistry?.[channel] || []).length > 0, `invoke:${runId}`);
  return runId;
}

function emitOn(page, runId) {
  return (payload) => page.evaluate(([channel, event]) => {
    for (const handler of [...(window.__agentlasEventRegistry?.[channel] || [])]) handler(event);
  }, [`invoke:${runId}`, payload]);
}

// Runs inside the browser page. Self-contained.
function auditContrast() {
  function parseColor(str) {
    if (!str) return null;
    const m = str.match(/rgba?\(([^)]+)\)/);
    if (!m) return null;
    const parts = m[1].split(",").map((s) => parseFloat(s.trim()));
    return { r: parts[0], g: parts[1], b: parts[2], a: parts.length > 3 ? parts[3] : 1 };
  }
  function relLuminance(c) {
    const chan = [c.r, c.g, c.b].map((v) => {
      const x = v / 255;
      return x <= 0.03928 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4);
    });
    return 0.2126 * chan[0] + 0.7152 * chan[1] + 0.0722 * chan[2];
  }
  function contrastRatio(c1, c2) {
    const l1 = relLuminance(c1);
    const l2 = relLuminance(c2);
    const lighter = Math.max(l1, l2);
    const darker = Math.min(l1, l2);
    return (lighter + 0.05) / (darker + 0.05);
  }
  // 반투명 배경(예: var(--fill-1) = rgba(..,0.09))을 조상 배경과 알파 합성해야 실제로
  // 화면에 보이는 색이 나온다 — 합성 없이 첫 번째 alpha>0 조상의 원색만 쓰면(이전 버전의
  // 버그) 9% 불투명 올리브색이 화면엔 거의 흰색인데 계산은 진한 올리브로 잘못 잡아
  // 대비비를 심하게 과소평가한다(오탐).
  function compositeOver(fg, bgOpaque) {
    const a = fg.a;
    return {
      r: fg.r * a + bgOpaque.r * (1 - a),
      g: fg.g * a + bgOpaque.g * (1 - a),
      b: fg.b * a + bgOpaque.b * (1 - a),
      a: 1,
    };
  }
  function findBackground(el) {
    const layers = [];
    let node = el;
    while (node) {
      const cs = getComputedStyle(node);
      const bg = parseColor(cs.backgroundColor);
      if (bg && bg.a > 0.001) {
        layers.push({ color: bg, node });
        if (bg.a >= 0.999) break;
      }
      node = node.parentElement;
    }
    let composited = { r: 255, g: 255, b: 255, a: 1 };
    for (let i = layers.length - 1; i >= 0; i--) composited = compositeOver(layers[i].color, composited);
    const bgNode = layers.length ? layers[0].node : document.documentElement;
    return { color: composited, node: bgNode, translucentChain: layers.some((l) => l.color.a < 0.999) };
  }
  function selectorFor(el) {
    if (!el || el === document.documentElement) return "html";
    let sel = el.tagName.toLowerCase();
    if (el.id) sel += `#${el.id}`;
    else if (el.className && typeof el.className === "string" && el.className.trim()) {
      sel += `.${el.className.trim().split(/\s+/).slice(0, 2).join(".")}`;
    }
    return sel;
  }
  const results = { lowContrast: [], invisible: [], checked: 0 };
  const all = document.body.querySelectorAll("*");
  for (const el of all) {
    let hasDirectText = false;
    for (const child of el.childNodes) {
      if (child.nodeType === 3 && child.textContent && child.textContent.trim().length > 0) { hasDirectText = true; break; }
    }
    if (!hasDirectText) continue;
    const rect = el.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) continue;
    const cs = getComputedStyle(el);
    if (cs.visibility === "hidden" || cs.display === "none") continue;
    if (parseFloat(cs.opacity || "1") < 0.05) continue;
    const textColor = parseColor(cs.color);
    if (!textColor) continue;
    const { color: bgColor, node: bgNode, translucentChain } = findBackground(el);
    results.checked += 1;
    const textStr = el.textContent.trim().slice(0, 60);
    const bgStr = `rgb(${Math.round(bgColor.r)}, ${Math.round(bgColor.g)}, ${Math.round(bgColor.b)})${translucentChain ? " (composited)" : ""}`;
    // "완전히 안 보임" = 합성된 배경색과 글자색이 채널별로 거의 같음(1 이내). 문자열
    // 비교는 rgba() vs rgb() 서식 차이로 오탐/누락이 나서 숫자 비교로 판정한다.
    const nearlyEqual = textColor.a >= 0.999 &&
      Math.abs(textColor.r - bgColor.r) < 1.5 &&
      Math.abs(textColor.g - bgColor.g) < 1.5 &&
      Math.abs(textColor.b - bgColor.b) < 1.5;
    if (nearlyEqual) {
      results.invisible.push({ selector: selectorFor(el), bgSelector: selectorFor(bgNode), text: textStr, color: cs.color, background: bgStr });
      continue;
    }
    const ratio = contrastRatio(textColor, bgColor);
    if (ratio < 3.0) {
      results.lowContrast.push({
        selector: selectorFor(el),
        bgSelector: selectorFor(bgNode),
        text: textStr,
        color: cs.color,
        background: bgStr,
        ratio: Math.round(ratio * 100) / 100,
      });
    }
  }
  return results;
}

async function auditPage(page, label) {
  const result = await page.evaluate(auditContrast);
  result.label = label;
  result.pageErrors = page.__qaErrors || [];
  return result;
}

// 사용자 말풍선 배경/글자색을 명시적으로 잡아 좌표 계산 없이 그대로 보고한다.
async function userBubbleEvidence(page, matchText) {
  return page.evaluate((needle) => {
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    let node;
    while ((node = walker.nextNode())) {
      if (node.textContent && node.textContent.includes(needle)) {
        let el = node.parentElement;
        // 텍스트를 감싼 요소 자신의 배경이 투명이면 배경을 든 조상까지 몇 단계 더 오른다.
        for (let i = 0; i < 5 && el; i++) {
          const cs = getComputedStyle(el);
          if (cs.backgroundColor && cs.backgroundColor !== "rgba(0, 0, 0, 0)") {
            return { found: true, tag: el.tagName.toLowerCase(), className: el.className, color: cs.color, backgroundColor: cs.backgroundColor, ownTextColor: getComputedStyle(node.parentElement).color };
          }
          el = el.parentElement;
        }
        return { found: true, tag: node.parentElement?.tagName.toLowerCase(), className: node.parentElement?.className, color: getComputedStyle(node.parentElement).color, backgroundColor: "transparent(walked 5 ancestors, none opaque)" };
      }
    }
    return { found: false };
  }, matchText);
}

async function main() {
  if (!fs.existsSync(path.join(distDir, "one.html"))) throw new Error(`dist not found at ${distDir}; run npm run build:renderer first`);
  fs.rmSync(outDir, { recursive: true, force: true });
  fs.mkdirSync(outDir, { recursive: true });
  const { server, baseUrl } = await startServer();
  const browser = await chromium.launch();
  const allResults = [];

  // 1) One 홈
  {
    const homeContext = await browser.newContext({ viewport: { width: 1440, height: 980 } });
    await homeContext.addInitScript(setupMockAgentlasBridge, mockBridgeOptions());
    await homeContext.addInitScript(installOneMockFixture, "home");
    const page = await newPage(homeContext, "one-home");
    await page.goto(`${baseUrl}/one.html`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector("main", { timeout: 10000 });
    await page.waitForTimeout(700);
    await page.screenshot({ path: path.join(outDir, "one-home.png"), fullPage: true });
    allResults.push(await auditPage(page, "one-home"));
    await page.close();
    await homeContext.close();
  }

  // 2) 열린 One 대화
  {
    const convContext = await browser.newContext({ viewport: { width: 1440, height: 980 } });
    await convContext.addInitScript(setupMockAgentlasBridge, mockBridgeOptions());
    await convContext.addInitScript(installOneMockFixture, "conversation");
    const page = await newPage(convContext, "one-conversation");
    await page.goto(`${baseUrl}/one.html?chat=chat_contrast_001`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector("main", { timeout: 10000 });
    await page.waitForTimeout(900);
    await page.screenshot({ path: path.join(outDir, "one-conversation.png"), fullPage: true });
    const audit = await auditPage(page, "one-conversation");
    audit.userBubble = await userBubbleEvidence(page, "거실 공기청정기를 바꾸고 싶은데");
    allResults.push(audit);
    await page.close();
    await convContext.close();
  }

  // 3) 결과 레일이 열린 Work 채팅
  {
    // Work 화면은 별도 fixture 스크립트가 필요 없다 — 기본 mock 브리지의 invoke.run 이 이미 지원한다.
    const workContext = await browser.newContext({ viewport: { width: 1440, height: 980 } });
    await workContext.addInitScript(setupMockAgentlasBridge, mockBridgeOptions());
    const page = await newPage(workContext, "work-result-rail");
    await gotoTask(page, baseUrl);
    const runId = await startRun(page, "긴 한국어 프롬프트로 결과 레일 상태를 확인합니다.");
    const emit = emitOn(page, runId);
    await emit({ kind: "tool-use", tool: { name: "write_file", args: JSON.stringify({ file_path: "/tmp/agentlas-qa-guide.html" }), result: "created" }, id: "fin-t0" });
    await emit({ kind: "final", text: "결과를 아래 결과 탭에서 확인하실 수 있습니다." });
    await page.waitForTimeout(700);
    const railOpen = await page.evaluate(() => !!document.querySelector("aside.chat-right-panel"));
    if (!railOpen) {
      const fileTabBtn = page.locator('[data-right-panel-tab="file"]');
      if (await fileTabBtn.count()) await fileTabBtn.first().click();
    }
    await page.waitForTimeout(400);
    await page.screenshot({ path: path.join(outDir, "work-result-rail.png"), fullPage: true });
    const audit = await auditPage(page, "work-result-rail");
    audit.userBubble = await userBubbleEvidence(page, "긴 한국어 프롬프트로 결과 레일 상태를 확인합니다");
    allResults.push(audit);
    await page.close();
    await workContext.close();
  }

  // 4) Settings
  {
    const settingsContext = await browser.newContext({ viewport: { width: 1440, height: 980 } });
    await settingsContext.addInitScript(setupMockAgentlasBridge, mockBridgeOptions());
    const page = await newPage(settingsContext, "settings");
    await page.goto(`${baseUrl}/settings.html`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector("main", { timeout: 10000 }).catch(() => {});
    await page.waitForTimeout(900);
    await page.screenshot({ path: path.join(outDir, "settings.png"), fullPage: true });
    allResults.push(await auditPage(page, "settings"));
    await page.close();
    await settingsContext.close();
  }

  await browser.close();
  await new Promise((resolve) => server.close(resolve));

  fs.writeFileSync(path.join(outDir, "contrast-report.json"), JSON.stringify(allResults, null, 2));

  console.log("=== 색상 대비 감사 결과 ===");
  for (const r of allResults) {
    console.log(`\n[${r.label}] checked=${r.checked} invisible=${r.invisible.length} lowContrast(<${MIN_CONTRAST})=${r.lowContrast.length} pageErrors=${r.pageErrors.length}`);
    for (const inv of r.invisible) console.log(`  INVISIBLE  ${inv.selector} on ${inv.bgSelector} — "${inv.text}" color=${inv.color} bg=${inv.background}`);
    for (const lc of r.lowContrast) console.log(`  LOW(${lc.ratio})  ${lc.selector} on ${lc.bgSelector} — "${lc.text}" color=${lc.color} bg=${lc.background}`);
    for (const pe of r.pageErrors) console.log(`  PAGE ERROR: ${pe}`);
    if (r.userBubble) console.log(`  USER BUBBLE  <${r.userBubble.tag}.${r.userBubble.className}> color=${r.userBubble.color} background=${r.userBubble.backgroundColor}`);
  }
  console.log(`\nscreenshots + contrast-report.json: ${outDir}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
