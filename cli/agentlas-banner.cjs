"use strict";
/*
 * Agentlas brand splash — the Boston Terrier terminal.
 * openclaw's lobster banner / Claude's glyph equivalent: a small mascot + wordmark.
 */
const path = require("node:path");
const os = require("node:os");

// Boston Terrier mascot — pointy bat ears, rounded tuxedo face, button nose, little smile.
const DOG_ART = [
  "    ◢◣     ◢◣",
  "    ██     ██",
  "╭───◥█─────█◤───╮",
  "│   ●       ●   │",
  "│       ▼       │",
  "│     ╲___╱     │",
  "╰───────────────╯",
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

// Main splash. ctx = { ui, version, runtimeLabel, subjectLabel, permission, cwd, tagline }
function renderBanner(ctx) {
  const ui = ctx.ui;
  const c = ui.c;
  const cols = ui.out.columns || 80;
  const version = ctx.version || readVersion();
  const tagline = ctx.tagline || "the Boston Terrier terminal · your AI agents, no GUI";

  // Narrow / no-color → one-line banner
  if (!ui.enabled || cols < 40) {
    ui.line(`🐾 Agentlas ${version}  —  ${tagline}`);
    renderStatus(ctx);
    return;
  }

  ui.line("");
  // mascot in warm white, with crimson nose + emerald eyes accents per line
  for (let i = 0; i < DOG_ART.length; i++) {
    const row = DOG_ART[i];
    let colored;
    if (i === 3) colored = c.text(row).split("●").join(c.emerald("●")); // eyes
    else if (i === 4) colored = c.text(row).split("▼").join(c.paw("▼")); // nose (brand crimson)
    else if (i === 5) colored = c.text(row).split("╲___╱").join(c.pink("╲___╱")); // smile
    else colored = c.text(row);
    ui.line("   " + colored);
  }
  ui.line("");
  ui.line("   " + c.bold(c.emerald(WORDMARK)) + (version ? "  " + c.dim("v" + version) : ""));
  ui.line("   " + c.dim(tagline));
  ui.line("");
  renderStatus(ctx);
  ui.line("");
  ui.line(
    "   " +
      c.faint("/help") +
      c.dim(" for commands · ") +
      c.faint("/exit") +
      c.dim(" to quit · ") +
      c.faint("Ctrl-C") +
      c.dim(" to interrupt"),
  );
  ui.line("");
}

// runtime · subject · permission · working folder
function renderStatus(ctx) {
  const ui = ctx.ui;
  const c = ui.c;
  const parts = [];
  if (ctx.subjectLabel) parts.push(c.paw("🐾 ") + c.bold(c.text(ctx.subjectLabel)));
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

module.exports = { renderBanner, renderStatus, readVersion, shorten, DOG_ART };
