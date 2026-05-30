"use strict";
/*
 * First-run onboarding wizard (openclaw-style): language → default runtime → default permission.
 * Runs once; result is saved to cli-prefs.json. Re-run anytime with `agentlas setup`.
 */
const i18n = require("./agentlas-i18n.cjs");
const banner = require("./agentlas-banner.cjs");

// req = { ui, rl, helpers }  → Promise<{ onboarded, lang, runtime, permission }>
async function runOnboard({ ui, rl, helpers }) {
  const H = helpers;
  const c = ui.c;
  const ask = (q) => new Promise((res) => rl.question(q, (a) => res((a || "").trim())));
  const pickNum = async (n) => {
    // loop until a valid 1..n number; empty → 1 (first option as default)
    for (;;) {
      const a = await ask("   " + c.emerald(ui.t("wiz.pick")));
      if (a === "") return 1;
      if (/^\d+$/.test(a)) {
        const i = parseInt(a, 10);
        if (i >= 1 && i <= n) return i;
      }
    }
  };

  // small mascot + header
  ui.line("");
  banner.renderMascot(ui);
  ui.line("   " + c.bold(c.emerald("Agentlas")) + c.dim(" · setup"));
  ui.line("   " + c.dim(ui.t("wiz.welcome")));

  // Step 1 — language
  ui.line("");
  ui.line("   " + c.bold(ui.t("wiz.langQ")));
  i18n.LANGS.forEach((l, i) => ui.line("     " + c.faint(String(i + 1)) + "  " + c.text(l.label)));
  const li = await pickNum(i18n.LANGS.length);
  const lang = i18n.LANGS[li - 1].code;
  ui.lang = lang; // localize the rest of the wizard

  // Step 2 — default runtime
  ui.line("");
  ui.line("   " + c.bold(ui.t("wiz.runtimeQ")));
  const cliKinds = ["claude-code", "codex", "gemini"];
  const rtOpts = [{ value: "auto", label: ui.t("wiz.runtimeAuto") }];
  for (const k of cliKinds) {
    const has = !!H.which(H.RUNTIME_BIN[k]);
    rtOpts.push({ value: k, label: `${k}  (${has ? ui.t("wiz.runtimeInstalled") : ui.t("wiz.runtimeMissing")})` });
  }
  rtOpts.forEach((o, i) => ui.line("     " + c.faint(String(i + 1)) + "  " + c.text(o.label)));
  const ri = await pickNum(rtOpts.length);
  const runtime = rtOpts[ri - 1].value;

  // Step 3 — default permission
  ui.line("");
  ui.line("   " + c.bold(ui.t("wiz.permQ")));
  const permOpts = [
    { v: "read", l: ui.t("wiz.permRead") },
    { v: "write", l: ui.t("wiz.permWrite") },
    { v: "full", l: ui.t("wiz.permFull") },
  ];
  permOpts.forEach((o, i) => ui.line("     " + c.faint(String(i + 1)) + "  " + c.text(o.l)));
  const pi = await pickNum(permOpts.length);
  const permission = permOpts[pi - 1].v;

  ui.line("");
  ui.ok(ui.t("wiz.saved"));
  ui.line("   " + c.faint(ui.t("wiz.changeLang")));
  return { onboarded: true, lang, runtime, permission };
}

module.exports = { runOnboard };
