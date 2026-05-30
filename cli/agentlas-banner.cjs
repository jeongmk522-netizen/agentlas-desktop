"use strict";
/*
 * Agentlas terminal splash — small dinosaur mascot (Chrome-dino style) + wordmark + status.
 */
const path = require("node:path");
const os = require("node:os");

// Small T-Rex (side view, facing right) — eye is ●.
const DINO_ART = [
  "          ▟████▙",
  "          █●  ▜█▙",
  "   ▖      ████████",
  "   ▜█▄▄▄▄▄███",
  "    ▀▀▀█▌ █▌",
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

// Just the mascot lines (used by the onboarding wizard header).
function renderMascot(ui) {
  const c = ui.c;
  if (!ui.enabled) {
    ui.line("  🦖 Agentlas");
    return;
  }
  for (let i = 0; i < DINO_ART.length; i++) {
    const row = DINO_ART[i];
    ui.line("   " + (i === 1 ? c.text(row).split("●").join(c.emerald("●")) : c.text(row)));
  }
}

// Main splash. ctx = { ui, version, runtimeLabel, subjectLabel, permission, cwd }
function renderBanner(ctx) {
  const ui = ctx.ui;
  const c = ui.c;
  const cols = ui.out.columns || 80;
  const version = ctx.version || readVersion();

  if (!ui.enabled || cols < 40) {
    ui.line(`🦖 Agentlas v${version}`);
    renderStatus(ctx);
    return;
  }

  ui.line("");
  renderMascot(ui);
  ui.line("");
  ui.line("   " + c.bold(c.emerald(WORDMARK)) + (version ? "  " + c.dim("v" + version) : ""));
  ui.line("");
  renderStatus(ctx);
  ui.line("");
  ui.line(
    "   " +
      c.faint("/help") +
      c.dim(" " + ui.t("banner.help") + " · ") +
      c.faint("/exit") +
      c.dim(" " + ui.t("banner.quit") + " · ") +
      c.faint("Ctrl-C") +
      c.dim(" " + ui.t("banner.interrupt")),
  );
  ui.line("");
}

// runtime · subject · permission · working folder
function renderStatus(ctx) {
  const ui = ctx.ui;
  const c = ui.c;
  const parts = [];
  if (ctx.subjectLabel) parts.push(c.emerald("◆ ") + c.bold(c.text(ctx.subjectLabel)));
  if (ctx.runtimeLabel) parts.push(c.dim("runtime ") + c.blue(ctx.runtimeLabel));
  if (ctx.permission) parts.push(c.dim("perm ") + permColor(c, ctx.permission)(ctx.permission));
  if (ctx.cwd) parts.push(c.dim("cwd ") + c.lime(shorten(ctx.cwd)));
  if (parts.length) ui.line("   " + parts.join(c.faint("  ·  ")));
}

function permColor(c, p) {
  if (p === "full") return c.pink;
  if (p === "write") return c.amber;
  return c.green; // read
}

module.exports = { renderBanner, renderStatus, renderMascot, readVersion, shorten, DINO_ART };
