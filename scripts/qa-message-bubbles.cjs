#!/usr/bin/env node
"use strict";
/*
 * **말풍선**을 잰다 — 대화 내용을 실제로 넣어서.
 *
 * ★왜 (2026-09-08): 지금까지의 모든 화면 훑기는 One/Work 채팅을 **빈 대화** 상태로만
 *   봤다. mock 브리지의 invoke.history 가 빈 배열이었기 때문이다. 제품의 한가운데인
 *   말풍선이 한 번도 측정된 적이 없었다는 뜻이다. "0건" 이 그래서 나왔던 것이다.
 *
 * 무엇을 넣나 — 실제로 자주 깨지는 내용들:
 *   ① 끊기지 않는 아주 긴 토큰(URL·해시) — 가로로 새어 나가는 대표 원인
 *   ② 긴 한국어 문단 — 줄바꿈·행간
 *   ③ 코드 블록의 긴 줄 — 가로 스크롤이 있어야 정상
 *   ④ 표 — 좁은 폭에서 넘침
 *   ⑤ 아주 긴 한 단어(띄어쓰기 없는 한글) — 한국어에서 실제로 생긴다
 *
 * 무엇을 재나: 말풍선이 대화 열보다 넓은가, 글자가 잘리는가, 가로 스크롤이 생기는가.
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

const LONG_TOKEN = "https://example.com/" + "a1b2c3d4e5".repeat(24) + "?token=" + "f".repeat(64);
const LONG_HANGUL_WORD = "아주".repeat(90);
const CODE_LINE = "const veryLongVariableName = someFunction(" + "argument, ".repeat(30) + "end);";
const at = (n) => new Date(Date.UTC(2026, 8, 8, 1, n)).toISOString();

const TRANSCRIPT = [
  { id: "m1", role: "user", text: `이 주소 좀 봐줘 ${LONG_TOKEN}`, createdAt: at(1) },
  { id: "m2", role: "assistant", text: `확인했습니다. 링크는 ${LONG_TOKEN} 입니다.`, createdAt: at(2) },
  { id: "m3", role: "user", text: LONG_HANGUL_WORD, createdAt: at(3) },
  {
    id: "m4", role: "assistant", createdAt: at(4),
    text: "긴 한국어 문단입니다. " + "이 문장은 줄바꿈과 행간이 제대로 잡히는지 보기 위해 충분히 길게 씁니다. ".repeat(6),
  },
  { id: "m5", role: "assistant", text: "```js\n" + CODE_LINE + "\n```", createdAt: at(5) },
  {
    id: "m6", role: "assistant", createdAt: at(6),
    text: "| 항목 | 값 | 설명 |\n|---|---|---|\n| 아주아주아주 긴 항목 이름 | 1234567890 | 설명이 길게 들어가는 칸입니다 |\n| 두 번째 | 2 | 짧음 |",
  },
  { id: "m7", role: "user", text: "짧게", createdAt: at(7) },
  /* 링크 두 가지 — 마크다운 링크와 맨 주소. 둘 다 눌러서 열 수 있어야 한다. */
  { id: "m8", role: "assistant", text: "자세한 것은 [문서](https://example.com/docs) 를 보세요.", createdAt: at(8) },
  { id: "m9", role: "assistant", text: "맨 주소도 씁니다: https://example.com/plain/link", createdAt: at(9) },
  /*
   * ★아주 넓은 그림 — 대화 열보다 훨씬 큰 이미지가 열을 밀어내는지 본다.
   *   모델이 만든 차트·스크린샷은 실제로 이 크기로 온다.
   */
  {
    id: "m10", role: "assistant", text: "만든 그림입니다.", createdAt: at(10),
    imageDataUrls: [
      "data:image/svg+xml;utf8," + encodeURIComponent(
        '<svg xmlns="http://www.w3.org/2000/svg" width="3200" height="240"><rect width="3200" height="240" fill="#dde"/><text x="20" y="140" font-size="90">wide</text></svg>',
      ),
    ],
  },
];

/*
 * ★대화를 열면 **가장 최근 말**이 보여야 한다. 위에서부터 보이면 사용자는 며칠 전
 *   대화를 다시 읽으며 스크롤을 내려야 한다. 긴 대화를 넣어 실제로 확인한다.
 */
const LONG_TRANSCRIPT = Array.from({ length: 60 }, (_, i) => ({
  id: `L${i}`,
  role: i % 2 === 0 ? "user" : "assistant",
  text: i === 59
    ? "마지막메시지표식-LAST"
    : `${i + 1}번째 메시지입니다. ` + "내용을 채우기 위한 문장을 몇 개 더 붙입니다. ".repeat(2),
  createdAt: new Date(Date.UTC(2026, 8, 8, 1, i)).toISOString(),
}));

const SCROLL_AUDIT = `(() => {
  const marker = [...document.querySelectorAll("*")].reverse()
    .find((el) => (el.textContent || "").includes("마지막메시지표식-LAST") && el.children.length === 0);
  if (!marker) return { note: "마지막 메시지를 화면에서 못 찾음" };
  const r = marker.getBoundingClientRect();
  return {
    lastVisible: r.top >= -4 && r.bottom <= innerHeight + 4,
    top: Math.round(r.top),
    bottom: Math.round(r.bottom),
    viewport: innerHeight,
  };
})()`;

/*
 * ★대화를 **못 읽었을 때** 화면이 뭐라고 하는가.
 *   비어 있는 대화와 "못 읽었다"가 구별되지 않으면, 사용자는 자기 대화가 사라진 줄 안다.
 *   이 저장소에서 반복해 온 계열이다 — 실패를 사실로 만들지 않는다.
 */
const FAILURE_AUDIT = `(() => {
  const text = (document.body.innerText || "").replace(/\s+/g, " ");
  const saysSomething = /못 읽|불러오지 못|실패|다시 시도|오류|could not|failed|retry/i.test(text);
  const saysEmpty = /아직 대화가 없|대화를 시작|무엇을 도와|시작해 보세|start a conversation|no messages/i.test(text);
  return { saysSomething, saysEmpty, sample: text.slice(0, 160) };
})()`;

const AUDIT = `(() => {
  const out = { overflow: [], clipped: [], unselectable: [], badLinks: [], pageOverflowX: Math.max(0, document.documentElement.scrollWidth - innerWidth), bubbles: 0 };
  /* 대화 열 — 말풍선들의 공통 조상 중 가장 좁은 것을 기준으로 삼는다. */
  const nodes = [...document.querySelectorAll("*")].filter((el) => {
    const t = (el.textContent || "");
    return t.includes("f".repeat(20)) || t.includes("아주아주아주아주아주아주아주아주아주아주");
  });
  if (!nodes.length) return { ...out, note: "심은 내용이 화면에 없다 — 대화가 안 그려졌다" };
  for (const el of document.querySelectorAll("[data-role], [class*='message'], [class*='bubble'], [class*='Message'], [class*='Bubble']")) {
    const r = el.getBoundingClientRect();
    if (r.width < 20 || r.height < 12) continue;
    const cs = getComputedStyle(el);
    if (cs.display === "none" || cs.visibility === "hidden") continue;
    out.bubbles += 1;
    const parent = el.parentElement;
    if (parent) {
      const pr = parent.getBoundingClientRect();
      if (r.right > pr.right + 2 || r.left < pr.left - 2) {
        out.overflow.push({
          el: el.tagName.toLowerCase() + (typeof el.className === "string" && el.className.trim() ? "." + el.className.trim().split(/\\s+/).slice(0, 2).join(".") : ""),
          over: Math.round(Math.max(r.right - pr.right, pr.left - r.left)),
          text: (el.textContent || "").replace(/\\s+/g, " ").trim().slice(0, 36),
        });
      }
    }
  }
  /* 글자가 상자보다 넓은데 가로 스크롤도 말줄임도 없는 자리. */
  for (const el of document.querySelectorAll("*")) {
    const cs = getComputedStyle(el);
    if (cs.display === "none" || cs.visibility === "hidden") continue;
    const own = [...el.childNodes].some((c) => c.nodeType === 3 && c.textContent.trim());
    if (!own) continue;
    if (el.scrollWidth <= el.clientWidth + 1) continue;
    if (cs.overflowX === "auto" || cs.overflowX === "scroll") continue;
    if (cs.textOverflow === "ellipsis") continue;
    const r = el.getBoundingClientRect();
    if (r.width < 24) continue;
    out.clipped.push({
      el: el.tagName.toLowerCase() + (typeof el.className === "string" && el.className.trim() ? "." + el.className.trim().split(/\\s+/).slice(0, 2).join(".") : ""),
      have: el.clientWidth, need: el.scrollWidth,
      text: (el.textContent || "").replace(/\\s+/g, " ").trim().slice(0, 36),
    });
  }
  /*
   * ★답을 **복사할 수 없으면** 도구로서 반쪽이다. user-select:none 이 걸린 말풍선은
   *   드래그해도 잡히지 않는다.
   */
  /* ★Work 와 One 의 본문 클래스 이름이 다르다 — 한쪽만 보면 그 화면은 못 잰다. */
  const bodies = [...document.querySelectorAll(
    "[class*='messageBody'], [class*='message-body'], [data-role] [class*='body'], [class*='bubble'] > div, [class*='chat-message'] [class*='text']",
  )];
  out.bodyCount = bodies.length;
  for (const el of bodies) {
    const cs = getComputedStyle(el);
    if (cs.userSelect === "none" || cs.webkitUserSelect === "none") {
      out.unselectable.push({
        el: el.tagName.toLowerCase() + (typeof el.className === "string" && el.className.trim() ? "." + el.className.trim().split(/\s+/).slice(0, 2).join(".") : ""),
        text: (el.textContent || "").replace(/\s+/g, " ").trim().slice(0, 30),
      });
    }
  }
  /*
   * ★대화 안의 링크가 **앱 자신을 다른 곳으로 끌고 가면** 지금 보던 것이 통째로 사라진다.
   *   바깥 주소는 새 창이나 시스템 브라우저로 가야 한다.
   */
  const anchors = [...document.querySelectorAll("[class*='message'] a[href], [data-role] a[href]")];
  out.anchorCount = anchors.length;
  /*
   * ★맨 주소가 링크가 되는지 값으로 확인한다. 이걸 안 세면 자동 링크가 사라져도
   *   "링크 문제 0건" 으로 보인다 — 실제로 처음엔 링크가 하나도 없었는데 0건이었다.
   */
  out.plainUrlLinked = anchors.some((a) => (a.getAttribute("href") || "").includes("plain/link"));
  /*
   * ★넓은 그림이 열을 밀어내는지 — 그림은 부모보다 커질 수 있는 대표 요소다.
   *   그린 개수도 함께 적는다: 0장이면 이 검사는 아무것도 안 본 것이다.
   */
  const images = [...document.querySelectorAll("img")].filter((img) => {
    const r = img.getBoundingClientRect();
    return r.width > 8 && r.height > 8;
  });
  out.imageCount = images.length;
  out.wideImages = images
    .filter((img) => {
      const parent = img.parentElement;
      if (!parent) return false;
      return img.getBoundingClientRect().width > parent.getBoundingClientRect().width + 2;
    })
    .map((img) => ({ w: Math.round(img.getBoundingClientRect().width), src: (img.getAttribute("src") || "").slice(0, 24) }))
    .slice(0, 4);
  for (const a of anchors) {
    const href = a.getAttribute("href") || "";
    if (!/^https?:/i.test(href)) continue;
    const target = a.getAttribute("target") || "";
    const handled = a.hasAttribute("data-external") || typeof a.onclick === "function";
    if (target !== "_blank" && !handled) {
      out.badLinks.push({ href: href.slice(0, 40), text: (a.textContent || "").trim().slice(0, 24) });
    }
  }
  return out;
})()`;

async function main() {
  if (!fs.existsSync(path.join(distDir, "one.html"))) throw new Error(`dist 가 없습니다: ${distDir} — npm run build:renderer`);
  const { server, baseUrl } = await startStaticRenderer(distDir);
  const browser = await chromium.launch();

  /* ★0 건을 보고하기 전에 검사기가 뭔가를 잡는지 본다. */
  {
    const p = await browser.newPage();
    await p.setContent(`<div style="width:200px;overflow:hidden"><div class="message" style="width:400px">${"f".repeat(60)}</div></div>`);
    const v = await p.evaluate(AUDIT);
    await p.close();
    if (!v.overflow.length && !v.clipped.length) throw new Error(`검사기가 심은 넘침을 못 잡습니다: ${JSON.stringify(v)}`);
  }

  const SIZES = [{ width: 1440, height: 980 }, { width: 1180, height: 820 }];
  const CASES = [
    { name: "까다로운 내용", transcript: TRANSCRIPT, audit: AUDIT },
    { name: "긴 대화 60개", transcript: LONG_TRANSCRIPT, audit: SCROLL_AUDIT },
    { name: "대화를 못 읽음", transcript: "throw", audit: FAILURE_AUDIT },
  ];
  const SCREENS = [
    { label: "Work 채팅", url: "/workspace/task.html?id=chat-1", wait: '[data-chat-input="true"]' },
    { label: "One 대화", url: "/one.html?chat=one-chat-1", wait: "main" },
  ];
  const report = [];
  for (const size of SIZES) {
    for (const kase of CASES) {
    for (const screen of SCREENS) {
      const context = await browser.newContext({ viewport: size, locale: "ko-KR" });
      await context.addInitScript(setupMockAgentlasBridge, mockBridgeOptions({ oneConversation: true }));
      /*
       * ★대화 내용은 **mock 브리지를 고치지 않고** 그 위에 덧씌운다.
       *   scripts/lib/mock-agentlas-bridge.cjs 는 개인 게이트 허용목록에 바이트가
       *   얼어 있는 파일이라(한 글자만 바꿔도 커밋 검사가 막힌다), 여기서 덮는다.
       *   init 스크립트는 등록 순서대로 도므로 이 조각이 뒤에 온다.
       */
      await context.addInitScript((transcript) => {
        const install = () => {
          const api = window.agentlas;
          if (!api || !api.invoke) return false;
          api.invoke.history = transcript === "throw"
            ? async () => { throw new Error("store read failed"); }
            : async () => transcript;
          return true;
        };
        if (!install()) {
          // 브리지가 아직이면 생길 때 붙인다.
          let current;
          Object.defineProperty(window, "agentlas", {
            configurable: true,
            get: () => current,
            set: (value) => {
              current = value;
              if (value && value.invoke) {
                value.invoke.history = transcript === "throw"
                  ? async () => { throw new Error("store read failed"); }
                  : async () => transcript;
              }
            },
          });
        }
      }, kase.transcript);
      await context.addInitScript(() => {
        window.localStorage.setItem("agentlas.locale", "ko");
        window.localStorage.setItem("agentlas.work.firstRunOnboarding.v3", "1");
      });
      const page = await context.newPage();
      try {
        await page.goto(`${baseUrl}${screen.url}`, { waitUntil: "domcontentloaded" });
        await page.waitForSelector(screen.wait, { timeout: 15000 });
        await page.waitForTimeout(1400);
        report.push({ screen: `${screen.label} · ${kase.name}`, size: `${size.width}x${size.height}`, case: kase.name, ...(await page.evaluate(kase.audit)) });
      } catch (cause) {
        report.push({ screen: `${screen.label} · ${kase.name}`, size: `${size.width}x${size.height}`, case: kase.name, error: String((cause && cause.message) || cause).slice(0, 180) });
      }
      await context.close();
    }
    }
  }
  await browser.close();
  server.close();

  let total = 0;
  for (const row of report) {
    if (row.error) { console.log(`\n■ ${row.screen} (${row.size}) — 열지 못함: ${row.error}`); continue; }
    if (row.case === "대화를 못 읽음") {
      if (!row.saysSomething) {
        total += 1;
        console.log(`\n■ ${row.screen} (${row.size}) — 대화를 못 읽었는데 **아무 말도 없다**${row.saysEmpty ? " (빈 대화처럼 보인다)" : ""}`);
        console.log(`     화면: ${row.sample}`);
      } else {
        console.log(`\n■ ${row.screen} (${row.size}) — 못 읽은 것을 화면이 말한다`);
      }
      continue;
    }
    if (row.case === "긴 대화 60개") {
      const bad = row.note || row.lastVisible === false;
      if (bad) {
        total += 1;
        console.log(`\n■ ${row.screen} (${row.size}) — 열었을 때 마지막 메시지가 안 보인다 ${row.note ? `(${row.note})` : `(top ${row.top}, 화면 높이 ${row.viewport})`}`);
      } else {
        console.log(`\n■ ${row.screen} (${row.size}) — 마지막 메시지가 보인다 (top ${row.top})`);
      }
      continue;
    }
    const plainUrlMissing = row.anchorCount !== undefined && row.plainUrlLinked === false;
    const n = row.overflow.length + row.clipped.length + (row.unselectable || []).length
      + (row.badLinks || []).length + (row.wideImages || []).length
      + (plainUrlMissing ? 1 : 0) + (row.pageOverflowX ? 1 : 0);
    total += n;
    /* ★"0건" 의 의미를 알 수 있게, 무엇을 실제로 봤는지 함께 적는다. */
    console.log(`\n■ ${row.screen} (${row.size}) — 말풍선 ${row.bubbles}개(본문 ${row.bodyCount ?? 0}, 링크 ${row.anchorCount ?? 0}, 그림 ${row.imageCount ?? 0}), 지적 ${n}건${row.note ? ` — ${row.note}` : ""}`);
    if (row.pageOverflowX) console.log(`   화면이 창보다 ${row.pageOverflowX}px 넓다`);
    for (const o of row.overflow.slice(0, 8)) console.log(`   상자 밖으로 ${o.over}px  <${o.el}> "${o.text}"`);
    for (const c of row.clipped.slice(0, 8)) console.log(`   글자 잘림 ${c.have}px 자리에 ${c.need}px  <${c.el}> "${c.text}"`);
    for (const c of (row.unselectable || []).slice(0, 6)) console.log(`   복사 불가(선택 막힘) <${c.el}> "${c.text}"`);
    for (const c of (row.badLinks || []).slice(0, 6)) console.log(`   링크가 앱을 끌고 간다 "${c.text}" → ${c.href}`);
    if (plainUrlMissing) console.log("   맨 주소가 링크가 되지 않는다 — 사용자가 손으로 복사해야 한다");
    for (const im of (row.wideImages || [])) console.log(`   그림이 상자보다 넓다 ${im.w}px "${im.src}…"`);
  }
  console.log(`\n합계 ${total}건`);
  const out = path.join(root, "docs", "qa-message-bubbles.json");
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify(report, null, 2));
  console.log(`기록: ${path.relative(root, out)}`);
}

main().catch((cause) => { console.error(cause); process.exit(1); });
