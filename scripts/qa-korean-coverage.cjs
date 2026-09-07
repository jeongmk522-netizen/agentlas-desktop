#!/usr/bin/env node
"use strict";
/*
 * 한국어로 켠 화면에 **영어만 남은 글자**가 있는지 훑는다.
 *
 * ★왜 (QA 실측 2026-09-08): "New task" 가 한국어 화면에 그대로 떴다. 소스를 뒤져 보면
 *   그 문구는 전부 locale 삼항으로 감싸여 있다 — 즉 "번역이 없다"가 아니라 **번역을
 *   안 거치는 자리가 따로 있다**는 뜻이다. 한 문자열을 쫓는 대신 화면을 훑는다.
 *
 * 판정: 보이는 텍스트 노드 중 한글이 하나도 없고 라틴 글자가 있는 것.
 *   고유명사·제품명·모델 id·코드·숫자·단위는 영어가 정상이므로 통과시킨다.
 *
 * 이 스크립트는 감사 도구다(게이트 아님) — 목록을 뽑아 사람이 판단한다.
 */
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const { chromium } = require("playwright");
const { setupMockAgentlasBridge, mockBridgeOptions } = require("./lib/mock-agentlas-bridge.cjs");

const root = path.resolve(__dirname, "..");
const distDir = process.env.KO_QA_DIST ? path.resolve(process.env.KO_QA_DIST) : path.join(root, "dist", "renderer");
const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8", ".json": "application/json; charset=utf-8",
  ".png": "image/png", ".svg": "image/svg+xml", ".woff2": "font/woff2", ".txt": "text/plain; charset=utf-8" };

function resolveAsset(rawUrl) {
  let pathname = decodeURIComponent((rawUrl || "/").split("?")[0]);
  const nested = pathname.match(/^\/.+\/(_next\/.+)$/);
  if (nested) pathname = `/${nested[1]}`;
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

function setKorean() { window.localStorage.setItem("agentlas.locale", "ko"); }

// 페이지 안에서 돈다. 자기충족적이어야 한다.
function collectEnglishOnly() {
  const HANGUL = /[가-힣ᄀ-ᇿ㄰-㆏]/;
  const LATIN = /[A-Za-z]/;
  const out = [];
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  let node;
  while ((node = walker.nextNode())) {
    const text = (node.nodeValue || "").trim();
    if (!text || text.length < 2) continue;
    if (HANGUL.test(text) || !LATIN.test(text)) continue;
    const el = node.parentElement;
    if (!el) continue;
    const style = getComputedStyle(el);
    if (style.display === "none" || style.visibility === "hidden" || style.opacity === "0") continue;
    const rect = el.getBoundingClientRect();
    if (rect.width < 1 || rect.height < 1) continue;
    // 코드/모노 글꼴 자리는 원문이 정상이다.
    if (/mono/i.test(style.fontFamily)) continue;
    out.push({
      text: text.slice(0, 80),
      tag: el.tagName.toLowerCase(),
      cls: (el.className || "").toString().split(" ")[0].slice(0, 40),
      testid: el.getAttribute("data-testid") || el.closest("[data-testid]")?.getAttribute("data-testid") || "",
    });
  }
  return out;
}

/** 영어가 정상인 것들 — 제품명·기술 용어·식별자·단위. 이유가 있어야 목록에 오른다. */
const ALLOWED = [
  /^(Agentlas|One|Work|Science|Hub|Cargo|Codex|Claude|Claude Code|Anthropic|OpenAI|Google|Antigravity|Grok|Kimi|Cursor|Ollama|LM Studio|MLX|BYOK|xAI|OpenRouter|DeepSeek|MiniMax|GLM|Upstage)$/i,
  /^(MCP|CLI|API|URL|ID|AI|UI|OS|PDF|CSV|JSON|YAML|HTML|CSS|SQL|GPU|CPU|RAM|SSH|HTTP|HTTPS|IP|DNS|PR|QA)$/,
  /^v?\d+(\.\d+)*[a-z0-9.\-]*$/i,          // 버전·숫자
  /^[\d.,\s]+(px|MB|GB|KB|ms|s|K|%)?$/i,   // 수치·단위
  /^[\p{P}\p{S}\s]+$/u,                    // 기호만
  /^(opus|sonnet|haiku|fable|gpt|o\d|gemini|flash|pro|max|mini|nano)[\w.\-]*$/i, // 모델 이름
];
const allowed = (text) => ALLOWED.some((re) => re.test(text.trim()));

async function main() {
  if (!fs.existsSync(path.join(distDir, "one.html"))) throw new Error(`dist 가 없습니다: ${distDir} — npm run build:renderer`);
  const { server, baseUrl } = await startServer();
  const browser = await chromium.launch();
  const SCREENS = [
    { label: "One 홈", url: "/one.html", wait: "main" },
    { label: "Work 채팅", url: "/workspace/task.html?id=chat-1", wait: '[data-chat-input="true"]' },
    { label: "설정", url: "/settings.html", wait: "main" },
    { label: "대시보드", url: "/index.html", wait: "main" },
    { label: "프로젝트 목록", url: "/projects.html", wait: "main" },
    { label: "라이브러리·MCP", url: "/library/mcps.html", wait: "main" },
  ];
  const report = [];
  for (const screen of SCREENS) {
    const context = await browser.newContext({ viewport: { width: 1440, height: 980 }, locale: "ko-KR" });
    await context.addInitScript(setupMockAgentlasBridge, mockBridgeOptions());
    await context.addInitScript(setKorean);
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    try {
      await page.goto(`${baseUrl}${screen.url}`, { waitUntil: "domcontentloaded" });
      await page.waitForSelector(screen.wait, { timeout: 15000 });
      await page.waitForTimeout(900);
      const found = (await page.evaluate(collectEnglishOnly)).filter((row) => !allowed(row.text));
      // 같은 문구가 여러 번 나오면 한 번만 센다.
      const uniq = [...new Map(found.map((r) => [r.text, r])).values()];
      report.push({ screen: screen.label, count: uniq.length, rows: uniq, pageErrors: errors });
    } catch (error) {
      report.push({ screen: screen.label, error: String(error).split("\n")[0], pageErrors: errors });
    }
    await page.close();
    await context.close();
  }
  await browser.close();
  server.close();

  console.log("=== 한국어 화면에 남은 영어 문구 ===\n");
  let total = 0;
  for (const r of report) {
    if (r.error) { console.log(`[${r.screen}] 열지 못함 — ${r.error}`); continue; }
    total += r.count;
    console.log(`[${r.screen}] ${r.count}건${r.pageErrors.length ? `  (페이지 오류 ${r.pageErrors.length})` : ""}`);
    for (const row of r.rows) console.log(`   ${JSON.stringify(row.text)}   <${row.tag}${row.cls ? "." + row.cls : ""}>${row.testid ? " testid=" + row.testid : ""}`);
  }
  console.log(`\n합계 ${total}건`);
  const outFile = path.join(root, "output", "korean-coverage.json");
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  fs.writeFileSync(outFile, JSON.stringify(report, null, 2));
  console.log(`보고서: ${outFile}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
