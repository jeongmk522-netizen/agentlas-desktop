"use strict";
/*
 * 보스턴테리어 brand splash — openclaw의 LOBSTER_ASCII 배너에 대응하는 Agentlas 버전.
 * paw 마크(크림슨) + AGENTLAS 워드마크(에메랄드) + 상태 헤더(런타임·에이전트·권한·cwd).
 */
const path = require("node:path");
const os = require("node:os");

// 강아지 발바닥: 토우 빈 4개 + 큰 패드. (보스턴테리어 paw 마크 ASCII화)
const PAW_ART = [
  "   ▟██▙   ▟██▙   ▟██▙   ▟██▙ ",
  "   ▜██▛   ▜██▛   ▜██▛   ▜██▛ ",
  "        ▗▄▄▄▄▄▄▄▄▄▄▖        ",
  "      ▟████████████████▙      ",
  "     ▜██████████████████▛     ",
  "       ▜██████████████▛       ",
];

const WORDMARK = "A G E N T L A S";

function readVersion() {
  try {
    return require(path.join(__dirname, "..", "package.json")).version || "";
  } catch {
    return "";
  }
}

function shorten(p) {
  if (!p) return "";
  const home = os.homedir();
  return p.startsWith(home) ? "~" + p.slice(home.length) : p;
}

// 메인 splash. ctx = { ui, runtimeLabel, subjectLabel, permission, cwd, tagline }
function renderBanner(ctx) {
  const ui = ctx.ui;
  const c = ui.c;
  const cols = ui.out.columns || 80;
  const version = ctx.version || readVersion();

  // 좁은 터미널 / 비-rich → 한 줄 배너
  if (!ui.enabled || cols < 40) {
    ui.line(`🐾 Agentlas ${version}  —  ${ctx.tagline || "로컬 에이전트 플랫폼"}`);
    renderStatus(ctx);
    return;
  }

  ui.line("");
  for (const row of PAW_ART) ui.line("  " + c.paw(row));
  ui.line("");
  ui.line("  " + c.bold(c.emerald(WORDMARK)) + (version ? "  " + c.dim(version) : ""));
  ui.line("  " + c.dim(ctx.tagline || "보스턴테리어 터미널 — 로컬 에이전트 플랫폼"));
  ui.line("");
  renderStatus(ctx);
  ui.line("");
  ui.line(
    "  " +
      c.faint("/help") +
      c.dim(" 로 명령 · ") +
      c.faint("/exit") +
      c.dim(" 로 종료 · ") +
      c.faint("Ctrl-C") +
      c.dim(" 로 턴 중단"),
  );
  ui.line("");
}

// 런타임 · 대상 · 권한 · 작업폴더 한 줄.
function renderStatus(ctx) {
  const ui = ctx.ui;
  const c = ui.c;
  const parts = [];
  if (ctx.subjectLabel) parts.push(c.paw("🐾 ") + c.bold(c.text(ctx.subjectLabel)));
  if (ctx.runtimeLabel) parts.push(c.dim("runtime ") + c.blue(ctx.runtimeLabel));
  if (ctx.permission) parts.push(c.dim("perm ") + permColor(c, ctx.permission)(ctx.permission));
  if (ctx.cwd) parts.push(c.dim("cwd ") + c.lime(shorten(ctx.cwd)));
  ui.line("  " + parts.join(c.faint("  ·  ")));
}

function permColor(c, p) {
  if (p === "full") return c.pink;
  if (p === "write") return c.amber;
  return c.green; // read
}

module.exports = { renderBanner, renderStatus, readVersion, shorten, PAW_ART };
