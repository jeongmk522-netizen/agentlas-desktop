#!/usr/bin/env node
// 3 sizes x 3 zooms visual sweep of the One product screens (home, conversation, settings, team/org
// rail). Follows the startServer + mock-agentlas-bridge fixture pattern used by
// scripts/qa-agentlas-one-fidelity.cjs and scripts/qa-agentlas-one-task-families.cjs, but drives its
// own small self-contained fixture (installOneGridFixture) instead of reusing the private one from
// qa-agentlas-one-fidelity.cjs, because that function is not exported and is designed for its own
// mode set.
//
// Zoom approach: we use `document.documentElement.style.zoom` (Chromium-only CSS zoom), NOT
// page.setViewportSize + deviceScaleFactor. Rationale: deviceScaleFactor changes pixel density, not
// the effective CSS layout viewport that a real "Cmd/Ctrl +/-" browser zoom changes; `style.zoom`
// changes effective layout width the same way real zoom does (at zoom 1.25, 960px viewport behaves
// like a 768px-wide layout), which is what actually causes squeeze/overflow regressions.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const { chromium } = require("playwright");
const {
  mockBridgeOptions,
  preloadMethodPaths,
  setupMockAgentlasBridge,
} = require("./lib/mock-agentlas-bridge.cjs");

const root = path.resolve(__dirname, "..");
// AGENTLAS_QA_DIST_DIR lets a run point at a snapshot copy of dist/renderer instead of the live
// build output — this is a shared checkout, and another session's `npm run build:renderer` rm's and
// repopulates dist/renderer mid-run, which races a long sweep into serving 404s partway through.
const distDir = process.env.AGENTLAS_QA_DIST_DIR
  ? path.resolve(process.env.AGENTLAS_QA_DIST_DIR)
  : path.join(root, "dist", "renderer");
const outDir = path.join(root, "output", "playwright", "one-grid");

function resolveAsset(rawUrl) {
  let pathname = decodeURIComponent((rawUrl || "/").split("?")[0]);
  const nestedNext = pathname.match(/^\/.+\/(_next\/.+)$/);
  if (nestedNext) pathname = `/${nestedNext[1]}`;
  if (pathname === "/") pathname = "/index.html";
  const direct = path.join(distDir, pathname);
  if (fs.existsSync(direct) && fs.statSync(direct).isFile()) return direct;
  if (!path.extname(pathname)) {
    const html = path.join(distDir, `${pathname}.html`);
    if (fs.existsSync(html)) return html;
  }
  return path.join(distDir, "404.html");
}

function startServer() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const file = resolveAsset(req.url);
      const mime = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".png": "image/png" };
      res.writeHead(file.endsWith("404.html") ? 404 : 200, { "content-type": mime[path.extname(file)] || "application/octet-stream" });
      fs.createReadStream(file).pipe(res);
    });
    server.listen(0, "127.0.0.1", () => resolve({ server, baseUrl: `http://127.0.0.1:${server.address().port}` }));
  });
}

// Self-contained (playwright addInitScript serializes this function body alone — no outer closures).
function installOneGridFixture(screen) {
  window.localStorage.setItem("agentlas.locale", "ko");
  const api = window.agentlas;
  const now = "2026-09-05T03:30:00.000Z";
  const taskId = "task_grid_comparison_001";
  const chatId = "chat_grid_comparison_001";
  const runId = "run_grid_comparison_001";
  const hasTask = screen === "conversation";

  const task = {
    id: taskId,
    version: 5,
    title: "서울 강남 소형 사무실 인테리어 업체 비교",
    projectId: null,
    firmId: null,
    status: "completed",
    originChatId: chatId,
    createdAt: "2026-09-05T03:10:00.000Z",
    updatedAt: now,
    archivedAt: null,
    participants: [],
  };
  const conversation = {
    id: chatId,
    taskId,
    projectId: null,
    firmId: null,
    agentId: "agent-one",
    kind: "user",
    originSurface: "one",
    title: task.title,
    archivedAt: null,
    createdAt: "2026-09-05T03:00:00.000Z",
    updatedAt: now,
    hiredAgents: [
      { slug: "interior-researcher", name: "인테리어 리서처", source: "firm-node", hiredAt: now },
      { slug: "estimate-verifier", name: "견적 검증자", source: "installed", hiredAt: now },
    ],
  };
  const longNarrative = [
    "요청하신 강남 지역 20평 내외 소형 사무실 인테리어 업체 세 곳을 비교했습니다. 예산 5천만원, 공사 기간 3주 이내라는 조건을 기준으로 삼았고, 최근 1년 안에 완료한 유사 규모 사무실 시공 사례가 있는 업체만 우선 검토했습니다. 세 업체 모두 사업자등록 상태가 정상이고 실내건축공사업 등록이 확인되어 법적으로 문제가 없었습니다.",
    "가장 먼저 살펴본 업체는 견적가가 가장 낮았지만, 최근 후기에서 마감재 교체 지연 사례가 두 건 발견되어 일정 리스크가 있었습니다. 두 번째 업체는 예산 상한에 가장 근접했지만 포함 항목이 넓어 추가 비용 발생 가능성이 낮았고, 담당 PM이 배정되어 진행 상황을 주간 단위로 보고받을 수 있었습니다. 세 번째 업체는 공사 기간이 가장 짧다고 홍보했지만 실제 계약서상 보장 조항이 없어 신뢰도가 낮았습니다.",
    "종합하면 총비용, 일정 준수 이력, 계약서상 보장 범위를 함께 고려했을 때 두 번째 업체가 가장 안정적인 선택입니다. 다만 최종 계약 전에는 반드시 현장 실측을 통해 정확한 견적을 다시 받아보시고, 하자보수 기간과 조건을 계약서에 명시하도록 요청하시는 것을 권장드립니다. 계약금 지급 전 사업자등록증과 실내건축공사업 등록증 원본 확인도 잊지 마세요.",
  ];
  const blocks = ["block_comparison", "block_table", "block_narrative", "block_sources"];
  const surface = {
    contractVersion: "1.0.0",
    manifestId: "manifest_grid_comparison_001",
    taskId,
    title: "가장 안정적인 선택: 두 번째 업체(예산 안에서 보장 범위가 가장 넓음)",
    summary: "예산 5천만원과 공사 기간 3주 조건을 기준으로 세 업체를 비교했고, 계약서상 보장 범위와 일정 준수 이력이 가장 좋은 업체를 골랐어요.",
    layoutProfile: "comparison",
    surfaceState: { value: "ready", summary: "검증된 비교 결과", readOnly: true, lastSyncedAt: now },
    blocks: [
      {
        blockId: blocks[0], type: "Comparison", title: "추천 업체",
        recommendedOptionRef: "option_b",
        options: [
          { optionRef: "option_a", title: "A 인테리어", subtitle: "4,200만원 · 공사 4주", strengths: ["가격이 가장 낮음"], limitations: ["최근 일정 지연 후기 2건"] },
          { optionRef: "option_b", title: "B 스튜디오", subtitle: "4,900만원 · 공사 3주", strengths: ["전담 PM 배정", "주간 보고"], limitations: ["예산 상한에 근접"] },
          { optionRef: "option_c", title: "C 디자인", subtitle: "4,600만원 · 공사 2주 홍보", strengths: ["공사 기간이 짧다고 홍보"], limitations: ["계약서상 기간 보장 조항 없음"] },
        ],
      },
      {
        blockId: blocks[1], type: "Table", title: "전체 비교",
        columns: [
          { columnId: "vendor", label: "업체" }, { columnId: "price", label: "견적가" },
          { columnId: "duration", label: "공사 기간" }, { columnId: "risk", label: "리스크" },
        ],
        featuredColumnIds: ["vendor", "price", "duration"],
        rows: [
          { rowId: "row_a", cells: [{ columnId: "vendor", value: "A 인테리어" }, { columnId: "price", value: "4,200만원" }, { columnId: "duration", value: "4주" }, { columnId: "risk", value: "일정 지연 이력" }] },
          { rowId: "row_b", cells: [{ columnId: "vendor", value: "**B 스튜디오**" }, { columnId: "price", value: "4,900만원" }, { columnId: "duration", value: "3주" }, { columnId: "risk", value: "낮음" }] },
          { rowId: "row_c", cells: [{ columnId: "vendor", value: "C 디자인" }, { columnId: "price", value: "4,600만원" }, { columnId: "duration", value: "2주(미보장)" }, { columnId: "risk", value: "계약서 보장 없음" }] },
        ],
      },
      { blockId: blocks[2], type: "Narrative", title: "선택 이유", paragraphs: longNarrative },
      { blockId: blocks[3], type: "SourceList", title: "확인한 출처", sources: [
        { sourceRef: "source_reg_a", title: "A 인테리어 사업자등록 상태", publisher: "국세청", verificationStatus: "verified", claimRefs: ["claim_reg_a"] },
        { sourceRef: "source_reg_b", title: "B 스튜디오 사업자등록 상태", publisher: "국세청", verificationStatus: "verified", claimRefs: ["claim_reg_b"] },
        { sourceRef: "source_review", title: "최근 시공 후기 모음", publisher: "네이버 카페", verificationStatus: "partially_verified", claimRefs: ["claim_review"] },
      ] },
    ],
    primaryAction: { actionId: "action_open_work", intent: "open_work", label: "비교표 저장", targetRef: taskId, enabled: true },
    secondaryActions: [],
    evidence: [
      { evidenceRef: "evidence_reg", kind: "source", verificationStatus: "verified", label: "사업자등록 상태" },
    ],
    fallback: { markdown: "비교 결과와 출처를 Work에서 확인할 수 있습니다.", artifacts: [] },
    recomposition: {
      desktop: { blockOrder: blocks, tableStrategy: "full_table", comparisonStrategy: "matrix", timelineStrategy: "adaptive" },
      mobile: { blockOrder: blocks, tableStrategy: "featured_cards_then_sheet", comparisonStrategy: "recommended_then_alternatives", timelineStrategy: "vertical" },
    },
  };
  const receipt = {
    runId, chatId, status: "completed",
    startedAt: "2026-09-05T03:12:00.000Z", updatedAt: now, finishedAt: now,
    eventCount: 14, resultFolder: "/tmp/agentlas-one-grid", errorMessage: null,
  };
  const profile = { contractVersion: "1.0.0", oneId: `one_${"1".repeat(32)}`, version: 1, displayName: "One", role: "내 비서이자 팀장", profileContext: "", preferredLocale: "ko", timeZone: "Asia/Seoul", operatingPrinciples: [], createdAt: now, updatedAt: now };
  const projection = {
    contractVersion: "1.0.0", taskId, canonicalVersion: task.version, oneId: profile.oneId,
    projectionSurface: "one", projectionMode: "summary",
    display: { title: task.title, summary: surface.summary },
    status: { value: "completed", source: "authoritative_event", asOf: now },
    sync: { connection: "online", lastSyncedAt: now, authoritativeHostRef: "desktop:local", executionAuthorityAvailable: true, mutationMode: "direct", queuedOperationCount: 0 },
    truth: { mayStartExecution: false, mayClaimNewCompletion: true },
    references: { teamRunId: runId, manifestId: surface.manifestId, decisionIds: [], artifactIds: [], receiptIds: [runId] },
    availableActions: [{ actionId: "action_open_work", intent: "open_work", label: "Work에서 열기", targetRef: taskId, enabled: true }],
    pendingOperations: [],
  };
  const history = [
    { id: "message_user_1", role: "user", text: "강남 소형 사무실 인테리어 업체 좀 비교해줘. 20평, 예산 5천만원, 3주 안에 끝났으면 좋겠어.", createdAt: "2026-09-05T03:11:00.000Z" },
    { id: "message_assistant_1", role: "assistant", text: `${surface.title}\n\n${longNarrative.join("\n\n")}`, createdAt: "2026-09-05T03:29:00.000Z" },
  ];

  // Org rail state — several members with long Korean status lines, near-capacity slots, so the
  // "team/org rail" screen exercises the squeeze scenario (a memory notes a chat column crushed to
  // 46px flowed Korean text 17 lines tall; the rail is the narrowest realistic column in the app).
  const orgNow = new Date().toISOString();
  const orgMembers = [
    { id: "m1", agentSlug: "interior-researcher", installedAgentId: "m1", displayName: "인테리어 리서처", nameEn: "Interior Researcher", icon: "one-fox", source: "local", sortOrder: 0, leaseExpiresAt: null, addedAt: orgNow, updatedAt: orgNow, archivedAt: null, statusKind: "active", statusLine: "강남 소형 사무실 업체 세 곳의 사업자등록 상태와 최근 시공 후기를 교차 확인하는 중입니다", statusLineEn: "Cross-checking business registration and recent reviews for three vendors", lastActivityAt: orgNow, pendingCount: 1, pendingKind: "review", unreadCount: 2, unreadGeneration: 1, creditState: "ok", completionSummary: { produced: [], pending: [] }, autoSelectTools: true, collaborationStyle: "default", title: "인테리어 리서처", description: "", identityEditable: true, runtimeSelection: null, revision: 1 },
    { id: "m2", agentSlug: "estimate-verifier", installedAgentId: "m2", displayName: "견적 검증자", nameEn: "Estimate Verifier", icon: "one-owl", source: "installed", sortOrder: 1, leaseExpiresAt: null, addedAt: orgNow, updatedAt: orgNow, archivedAt: null, statusKind: "quiet", statusLine: "세 업체 계약서 보장 조항을 비교 완료", statusLineEn: "Finished comparing warranty clauses across three vendors", lastActivityAt: orgNow, pendingCount: 0, pendingKind: "review", unreadCount: 0, unreadGeneration: 1, creditState: "ok", completionSummary: { produced: [], pending: [] }, autoSelectTools: true, collaborationStyle: "default", title: "견적 검증자", description: "", identityEditable: true, runtimeSelection: null, revision: 1 },
    { id: "m3", agentSlug: "chief-of-staff", installedAgentId: "m3", displayName: "Chief of Staff", nameEn: "Chief of Staff", icon: "one-puppy", source: "local", sortOrder: 2, leaseExpiresAt: null, addedAt: orgNow, updatedAt: orgNow, archivedAt: null, statusKind: "quiet", statusLine: "이번 주 처리한 일 세 건을 정리했어요", statusLineEn: "Summarized three items handled this week", lastActivityAt: orgNow, pendingCount: 0, pendingKind: "review", unreadCount: 1, unreadGeneration: 1, creditState: "ok", completionSummary: { produced: [], pending: [] }, autoSelectTools: true, collaborationStyle: "default", title: "Chief of Staff", description: "", identityEditable: false, runtimeSelection: null, revision: 1 },
  ];
  const orgState = { schemaVersion: 1, revision: 3, generatedAt: orgNow, members: orgMembers, slots: { used: 3, capacity: 4, available: 1, includesOne: true, recommended: 4, hardMax: 8, cores: 10, totalMemGB: 32, userSet: false } };

  api.oneProfile.get = async () => profile;
  api.oneOrg.get = async () => orgState;
  api.oneSuggestions.getState = async () => ({ contractVersion: "1.0.0", version: 1, suggestions: [], reviewRequests: [], suppressions: [], patternFeedback: [], taskArbitrations: [], createdAt: now, updatedAt: now });
  api.oneMemory.getState = async () => ({ contractVersion: "1.0.0", version: 1, candidates: [], memories: [], suppressions: [], createdAt: now, updatedAt: now });
  api.oneFeatureIntro.getState = async () => null;
  api.oneActivation.getState = async () => null;
  api.oneBriefing.get = async () => null;
  api.oneTeamPreflight.getForChat = async () => null;
  api.oneTeamPreflight.prepare = async () => ({ kind: "not_required" });
  api.oneAttachments.forTeam = async () => null;
  api.tasks.listProjections = async () => (hasTask ? [projection] : []);
  api.tasks.getProjection = async (id) => (hasTask && id === taskId ? projection : null);
  api.tasks.list = async () => (hasTask ? [task] : []);
  api.tasks.get = async (id) => (id === taskId ? task : null);
  api.tasks.findForChat = async (id) => (id === chatId ? task : null);
  api.chats.listRecent = async () => [conversation];
  api.chats.get = async (id) => (id === chatId ? conversation : null);
  api.invoke.activeChats = async () => [];
  api.invoke.latestReceipt = async () => (hasTask ? receipt : null);
  api.invoke.latestOneSurface = async () => (hasTask ? { manifest: surface } : null);
  api.invoke.attach = async () => null;
  api.invoke.history = async (id) => (hasTask && id === chatId ? history : []);
}

const SIZES = [
  { label: "960", width: 960, height: 700 },
  { label: "1280", width: 1280, height: 800 },
  { label: "1728", width: 1728, height: 1117 },
];
const ZOOMS = [0.8, 1.0, 1.25];

const SCREENS = [
  { name: "home", screen: "home", query: "" },
  { name: "conversation", screen: "conversation", query: "?task=task_grid_comparison_001" },
  { name: "settings", screen: "settings", query: "", afterLoad: "openSettings" },
  { name: "team", screen: "team", query: "" },
];

async function findClippedText(page) {
  // Single-line ellipsis truncation (overflow:hidden + white-space:nowrap + text-overflow:ellipsis)
  // is a deliberate, standard UI pattern for compact rails/labels, not a defect on its own — flag it
  // only when the box is so narrow that even the ellipsis form is unreadable (fewer than ~3
  // characters' worth of width). Screen-reader-only text (the classic clip-rect(0 0 0 0) 1x1px
  // pattern) is intentionally invisible and must not be reported as clipped either.
  return page.evaluate(() => {
    const clipped = [];
    const all = document.querySelectorAll("body *");
    for (const el of all) {
      const style = window.getComputedStyle(el);
      if (style.overflow !== "hidden" && style.overflowX !== "hidden") continue;
      if (!el.textContent || !el.textContent.trim()) continue;
      const hasDirectText = [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim());
      if (!hasDirectText) continue;
      if (el.clientWidth <= 2 && el.clientHeight <= 2) continue; // sr-only visually-hidden text
      if (el.scrollWidth > el.clientWidth + 2 && el.clientWidth > 0) {
        const isEllipsis = style.textOverflow === "ellipsis" && style.whiteSpace === "nowrap";
        const fontSize = parseFloat(style.fontSize) || 10;
        const unreadableEvenWithEllipsis = el.clientWidth < fontSize * 2.2;
        if (isEllipsis && !unreadableEvenWithEllipsis) continue; // intentional, legible truncation
        clipped.push({
          tag: el.tagName.toLowerCase(),
          className: typeof el.className === "string" ? el.className.slice(0, 80) : "",
          text: el.textContent.trim().slice(0, 60),
          scrollWidth: el.scrollWidth,
          clientWidth: el.clientWidth,
          isEllipsis,
        });
      }
    }
    return clipped.slice(0, 20);
  });
}

async function findOffscreenPrimaryButtons(page) {
  // Hover/focus-reveal action buttons (opacity:0; pointer-events:none until an ancestor is
  // :hover/:focus-within) are a standard, accessible affordance pattern, not a reachability bug —
  // exclude any button whose own or ancestor chain's computed opacity/pointer-events currently hide
  // it, since that is its correct at-rest state.
  //
  // Viewport reference: use window.innerWidth/innerHeight, NOT document.documentElement.clientWidth/
  // clientHeight. Under the Chromium-only `document.documentElement.style.zoom` this harness uses to
  // emulate zoom, clientWidth/clientHeight scale by 1/zoom (e.g. a 700px-tall window reports
  // clientHeight 875 at zoom 0.8), while getBoundingClientRect() — what `rect` below is built from —
  // stays in physical/device pixels (unchanged by zoom, same frame as elementFromPoint). Comparing a
  // physical-space rect against a zoom-scaled clientHeight is an apples-to-oranges bug that produced
  // spurious "outOfViewport" findings at every zoom != 1 cell in an earlier draft of this harness
  // (verified: a 700px window reports clientHeight 875 at zoom 0.8 and 560 at zoom 1.25, while
  // window.innerHeight and getBoundingClientRect both stay at 700 regardless of zoom).
  return page.evaluate(() => {
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    function intentionallyHidden(el) {
      let node = el;
      while (node && node !== document.body) {
        const style = window.getComputedStyle(node);
        if (parseFloat(style.opacity) < 0.05 || style.pointerEvents === "none") return true;
        node = node.parentElement;
      }
      return false;
    }
    const candidates = [...document.querySelectorAll("button")].filter((btn) => {
      const style = window.getComputedStyle(btn);
      return style.display !== "none" && style.visibility !== "hidden" && btn.offsetParent !== null && !intentionallyHidden(btn);
    });
    const bad = [];
    for (const btn of candidates) {
      const rect = btn.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) continue;
      const cx = rect.left + rect.width / 2;
      const cy = rect.top + rect.height / 2;
      const outOfViewport = cx < 0 || cy < 0 || cx > vw || cy > vh;
      let notClickable = false;
      if (!outOfViewport) {
        const top = document.elementFromPoint(cx, cy);
        notClickable = !top || (!btn.contains(top) && top !== btn);
      }
      if (outOfViewport || notClickable) {
        bad.push({
          text: (btn.textContent || btn.getAttribute("aria-label") || "").trim().slice(0, 40),
          outOfViewport,
          notClickable,
          rect: { x: Math.round(rect.left), y: Math.round(rect.top), w: Math.round(rect.width), h: Math.round(rect.height) },
        });
      }
    }
    return bad.slice(0, 20);
  });
}

async function findSqueezedChatColumns(page) {
  // A column narrower than 200px that still carries chat/message PROSE is the defect a prior audit
  // missed with pure overflow checks (46px column flowed Korean text 17 lines tall). Scoped to actual
  // message/thread/conversation-preview containers (not icon shelves like the taskforce rail, whose
  // 74px-per-item horizontal-scroll layout is an intentional, different pattern), and uses
  // `innerText` (rendered text) rather than `textContent` so sr-only clip-rect labels — real, but
  // invisible by design — don't count toward the "crushed" length.
  return page.evaluate(() => {
    const selectors = [
      "[class*='messages']", "[class*='thread']", "[class*='homeConversation']",
      "[class*='sessionList']", "[class*='SessionRow']", "[class*='ConversationList']",
    ];
    const seen = new Set();
    const squeezed = [];
    for (const sel of selectors) {
      for (const el of document.querySelectorAll(sel)) {
        if (seen.has(el)) continue;
        seen.add(el);
        const rect = el.getBoundingClientRect();
        if (rect.width <= 0 || rect.width >= 200) continue;
        const text = (el.innerText || "").trim();
        if (text.length < 40) continue;
        squeezed.push({
          className: typeof el.className === "string" ? el.className.slice(0, 80) : "",
          width: Math.round(rect.width),
          height: Math.round(rect.height),
          textLength: text.length,
          textPreview: text.slice(0, 40),
        });
      }
    }
    return squeezed.slice(0, 20);
  });
}

async function capture(browser, baseUrl, spec) {
  const { screenName, screen, query, afterLoad, size, zoom } = spec;
  const cellName = `${screenName}-${size.label}-${zoom}`;
  const context = await browser.newContext({ viewport: { width: size.width, height: size.height } });
  await context.addInitScript(setupMockAgentlasBridge, mockBridgeOptions({ preloadMethodPaths: preloadMethodPaths(path.join(root, "electron", "preload.ts")) }));
  await context.addInitScript(installOneGridFixture, screen);
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`${baseUrl}/one.html${query}`, { waitUntil: "domcontentloaded", timeout: 20_000 });
  await page.waitForSelector("main", { timeout: 10_000 });
  await page.waitForTimeout(500);
  if (zoom !== 1) {
    await page.evaluate((z) => { document.documentElement.style.zoom = String(z); }, zoom);
    await page.waitForTimeout(150);
  }
  if (afterLoad === "openSettings") {
    // exact:true matters — the org rail's concurrency-slots button also has visible text "설정"
    // (its accessible name is the longer aria-label "동시 에이전트 슬롯 설정", which still contains
    // "설정" as a substring and would wrongly match a non-exact role query, opening the wrong sheet).
    const settingsButton = page.getByRole("button", { name: "설정", exact: true });
    await settingsButton.click({ timeout: 3000 });
    await page.waitForTimeout(200);
  }

  const overflow = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
  }));
  const clippedText = await findClippedText(page);
  const offscreenButtons = await findOffscreenPrimaryButtons(page);
  const squeezedColumns = await findSqueezedChatColumns(page);

  const findings = {
    pageErrors: errors,
    horizontalOverflow: overflow.scrollWidth > overflow.clientWidth + 2 ? overflow : null,
    clippedText,
    offscreenOrUnclickableButtons: offscreenButtons,
    squeezedChatColumns: squeezedColumns,
  };
  const hasFindings = Boolean(
    findings.pageErrors.length ||
    findings.horizontalOverflow ||
    findings.clippedText.length ||
    findings.offscreenOrUnclickableButtons.length ||
    findings.squeezedChatColumns.length,
  );

  await page.screenshot({ path: path.join(outDir, `${cellName}.png`), fullPage: true }).catch(() => {});
  await context.close();
  return { cell: cellName, screen: screenName, size: size.label, zoom, hasFindings, findings };
}

async function main() {
  if (!fs.existsSync(path.join(distDir, "one.html"))) throw new Error("dist/renderer/one.html is missing; run npm run build:renderer first");
  fs.rmSync(outDir, { recursive: true, force: true });
  fs.mkdirSync(outDir, { recursive: true });
  const { server, baseUrl } = await startServer();
  const browser = await chromium.launch();
  const results = [];
  try {
    for (const screenSpec of SCREENS) {
      for (const size of SIZES) {
        for (const zoom of ZOOMS) {
          const result = await capture(browser, baseUrl, {
            screenName: screenSpec.name,
            screen: screenSpec.screen,
            query: screenSpec.query,
            afterLoad: screenSpec.afterLoad,
            size,
            zoom,
          });
          results.push(result);
          const marker = result.hasFindings ? "FINDINGS" : "clean";
          console.log(`${result.cell}: ${marker}`);
        }
      }
    }
  } finally {
    await browser.close().catch(() => {});
    await new Promise((resolve) => server.close(resolve));
  }
  const summaryPath = path.join(outDir, "summary.json");
  fs.writeFileSync(summaryPath, `${JSON.stringify({ recordedAt: new Date().toISOString(), results }, null, 2)}\n`);
  const withFindings = results.filter((r) => r.hasFindings);
  console.log(`\nAgentlas One grid sweep: ${results.length} cells, ${withFindings.length} with findings.`);
  console.log(`Summary: ${summaryPath}`);
  if (withFindings.length) {
    for (const r of withFindings) {
      console.log(`\n-- ${r.cell} --`);
      console.log(JSON.stringify(r.findings, null, 2).slice(0, 2000));
    }
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
