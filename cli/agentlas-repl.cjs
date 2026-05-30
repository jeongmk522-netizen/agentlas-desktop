"use strict";
/*
 * agentlas-repl: the interactive shell of the agentlas terminal.
 * agentlas is always the host — when the active runtime is claude/codex/gemini it drives them
 * headless and renders inside this TUI (subscription auth preserved); for BYOK/Ollama it runs
 * its own agent loop (api-agent). agentlas.cjs injects DB helpers via the `helpers` object.
 *
 * First launch runs an onboarding wizard (language → runtime → permission), stored in prefs.
 */
const readline = require("node:readline");
const { Ui } = require("./agentlas-ui.cjs");
const banner = require("./agentlas-banner.cjs");
const { runNativeTurn } = require("./agentlas-native-host.cjs");
const { runApiTurn } = require("./agentlas-api-agent.cjs");

function runtimeLabel(rt) {
  if (!rt) return "(none)";
  if (rt.mode === "cli") return rt.kind;
  return `${rt.backend}${rt.model ? " · " + rt.model : ""}`;
}

// Hides the trailing "## Memory Events" block from the live stream while keeping the full
// text for curation. Holds back the last heading.length chars so a split heading is safe too.
function makeMemoryGuard(ui, heading) {
  const N = heading.length;
  let acc = "";
  let printed = 0;
  let cut = false;
  const flush = () => {
    if (cut) return;
    const idx = acc.indexOf(heading);
    if (idx >= 0) {
      if (idx > printed) ui.streamDelta(acc.slice(printed, idx));
      printed = idx;
      cut = true;
    } else if (acc.length > printed) {
      ui.streamDelta(acc.slice(printed));
      printed = acc.length;
    }
  };
  return {
    c: ui.c,
    streamStart: () => ui.streamStart(),
    streamDelta: (t) => {
      if (cut) {
        acc += t;
        return;
      }
      acc += t;
      const idx = acc.indexOf(heading);
      if (idx >= 0) {
        if (idx > printed) ui.streamDelta(acc.slice(printed, idx));
        printed = idx;
        cut = true;
        return;
      }
      const safe = acc.length - N;
      if (safe > printed) {
        ui.streamDelta(acc.slice(printed, safe));
        printed = safe;
      }
    },
    streamEnd: () => {
      flush();
      ui.streamEnd();
    },
    tool: (...a) => ui.tool(...a),
    toolResult: (...a) => ui.toolResult(...a),
    info: (...a) => ui.info(...a),
    warn: (...a) => ui.warn(...a),
    error: (...a) => ui.error(...a),
    status: (...a) => ui.status(...a),
    ok: (...a) => ui.ok(...a),
    cost: (...a) => ui.cost(...a),
    line: (...a) => ui.line(...a),
  };
}

// startRepl({ db, subject|null, runtime, permission, cwd, helpers, prefs, savePrefs })
function startRepl(opts) {
  const { db } = opts;
  const H = opts.helpers;
  const prefs = opts.prefs || {};
  const ui = new Ui({ lang: prefs.lang || "en" });
  const state = {
    subject: opts.subject || null,
    runtime: opts.runtime,
    permission: opts.permission || "write",
    cwd: opts.cwd,
    history: [],
    native: {}, // kind → { id }
    projectPath: opts.projectPath || null,
  };

  function showBanner() {
    banner.renderBanner({
      ui,
      version: opts.version,
      runtimeLabel: runtimeLabel(state.runtime),
      subjectLabel: state.subject ? state.subject.label : null,
      permission: state.permission,
      cwd: state.cwd,
    });
  }

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: !!process.stdin.isTTY });
  let busy = false;
  let closed = false;
  let currentAbort = null;
  rl.on("close", () => {
    closed = true;
    if (!busy) process.exit(0);
  });
  rl.on("SIGINT", () => {
    if (busy && currentAbort) {
      currentAbort.abort();
      ui.warn(ui.t("interrupted"));
    } else {
      ui.line("");
      ui.line(ui.c.emerald("🦖 ") + ui.c.dim(ui.t("bye")));
      rl.close();
      process.exit(0);
    }
  });

  function ctxNow() {
    return { projectPath: state.projectPath, agentId: state.subject && state.subject.id, permission: state.permission, cwd: state.cwd };
  }

  // ── run one turn ──
  async function runTurn(prompt) {
    busy = true;
    currentAbort = new AbortController();
    const signal = currentAbort.signal;
    const ctx = ctxNow();
    const rt = state.runtime;
    try {
      if (rt.mode === "cli") {
        const bin = H.which(H.RUNTIME_BIN[rt.kind]) || H.RUNTIME_BIN[rt.kind];
        const session = state.native[rt.kind] || (state.native[rt.kind] = {});
        const sys = H.augmentSystem(db, state.subject.system, ctx, false);
        const res = await runNativeTurn({
          kind: rt.kind,
          bin,
          prompt,
          systemPrompt: session.id ? "" : sys,
          cwd: state.cwd,
          permission: state.permission,
          session,
          ui,
          signal,
        });
        const at = (res.text || "").trim();
        if (at && !res.error) state.history.push({ role: "user", text: prompt }, { role: "assistant", text: at });
      } else {
        const sys = H.augmentSystem(db, state.subject.system, ctx, true);
        let apiKey = null;
        if (rt.backend !== "ollama") {
          apiKey = await H.apiKey(rt.backend);
          if (!apiKey) {
            ui.error(ui.t("noKey", rt.backend));
            return;
          }
        }
        const messages = state.history
          .filter((h) => h.text && h.text.trim())
          .map((h) => ({ role: h.role, content: h.text }))
          .concat([{ role: "user", content: prompt }]);
        const guard = makeMemoryGuard(ui, H.eventsHeading());
        const res = await runApiTurn({
          backend: rt.backend,
          model: rt.model || H.defaultApiModel(rt.backend),
          apiKey,
          system: sys,
          messages,
          ctx,
          ui: guard,
          signal,
        });
        const cleaned = (H.curateCliReply(db, res.text || "", ctx) || "").trim();
        if (cleaned) state.history.push({ role: "user", text: prompt }, { role: "assistant", text: cleaned });
      }
    } catch (e) {
      ui.stopSpinner();
      if (signal.aborted) {
        // user Ctrl-C — SIGINT handler already printed
      } else if (e && e.name === "AbortError") {
        ui.warn(ui.t("stalled"));
      } else {
        ui.error((e && e.message) || String(e));
      }
    } finally {
      busy = false;
      currentAbort = null;
    }
  }

  // ── slash commands ──
  function setRuntime(arg) {
    const cliKinds = { "claude-code": 1, claude: 1, codex: 1, gemini: 1 };
    const apiBackends = { anthropic: 1, openai: 1, google: 1, ollama: 1 };
    let a = (arg || "").trim();
    if (a === "claude") a = "claude-code";
    if (cliKinds[a]) {
      const bin = H.which(H.RUNTIME_BIN[a]);
      if (!bin) return ui.error(ui.t("runtimeNotInstalled", a));
      state.runtime = { mode: "cli", kind: a };
      state.native = {};
      return ui.ok(ui.t("runtimeSet", a));
    }
    if (apiBackends[a]) {
      state.runtime =
        a === "ollama"
          ? { mode: "api", backend: "ollama", model: state.runtime.backend === "ollama" ? state.runtime.model : null }
          : { mode: "api", backend: a, model: null };
      return ui.ok(ui.t("runtimeSet", runtimeLabel(state.runtime)));
    }
    ui.warn(ui.t("runtimeUsage"));
  }

  function setSubjectAgent(agent) {
    state.subject = { kind: "agent", id: agent.id, label: agent.name, system: agent.system_prompt || `You are ${agent.name}.` };
    state.history = [];
    state.native = {};
  }
  function setSubjectFirm(firm) {
    state.subject = { kind: "firm", id: firm.ceo_agent_id, label: firm.name + " CEO", system: H.firmSystemPrompt(db, firm) };
    state.history = [];
    state.native = {};
  }
  function switchSubject(kind, query) {
    if (kind === "agent") {
      const agent = H.resolveAgent(db, query);
      if (!agent) return ui.error(ui.t("noAgent", query));
      setSubjectAgent(agent);
    } else {
      const firm = H.resolveFirm(db, query);
      if (!firm) return ui.error(ui.t("noCompany", query));
      setSubjectFirm(firm);
    }
    ui.ok(ui.t("switched", state.subject.label));
  }

  function printRoster() {
    const ags = H.listAgents(db);
    const firms = H.listFirms(db);
    ui.line("");
    ui.line(ui.c.dim("  " + ui.t("picker.agents")));
    ags.forEach((a, i) =>
      ui.line("   " + ui.c.faint(String(i + 1).padStart(2)) + "  " + ui.c.emerald(a.slug.padEnd(28)) + ui.c.text(a.name)),
    );
    if (firms.length) {
      ui.line(ui.c.dim("  " + ui.t("picker.companies")));
      firms.forEach((f) =>
        ui.line("       " + ui.c.emerald(("firm " + f.slug).padEnd(28)) + ui.c.text(f.name) + ui.c.dim(" (CEO)")),
      );
    }
    if (!ags.length && !firms.length) ui.line("   " + ui.c.dim(ui.t("picker.none")));
  }

  async function handleSlash(line) {
    const [cmd, ...rest] = line.slice(1).split(/\s+/);
    const arg = rest.join(" ");
    switch (cmd) {
      case "help":
      case "?":
        printHelp(ui);
        return true;
      case "agents":
        printRoster();
        return true;
      case "firms": {
        const fs = H.listFirms(db);
        ui.line("");
        for (const f of fs) ui.line("  " + ui.c.emerald(f.slug.padEnd(28)) + ui.c.text(f.name) + ui.c.dim("  (CEO)"));
        return true;
      }
      case "agent":
        if (!arg) return ui.warn(ui.t("agentUsage")), true;
        switchSubject("agent", arg);
        return true;
      case "firm":
        if (!arg) return ui.warn(ui.t("firmUsage")), true;
        switchSubject("firm", arg);
        return true;
      case "runtime":
        setRuntime(arg);
        return true;
      case "model":
        if (state.runtime.mode !== "api") return ui.warn(ui.t("modelOnlyApi")), true;
        state.runtime.model = arg || null;
        ui.ok(ui.t("modelSet", state.runtime.model || ui.t("modelDefault")));
        return true;
      case "permission":
      case "perm": {
        const p = (arg || "").toLowerCase();
        if (!["read", "write", "full"].includes(p)) return ui.warn(ui.t("permUsage")), true;
        state.permission = p;
        ui.ok(ui.t("permSet", p));
        return true;
      }
      case "cwd":
        if (arg) {
          const path = require("node:path");
          const fs = require("node:fs");
          const next = path.resolve(state.cwd, arg);
          if (!fs.existsSync(next)) return ui.error(ui.t("cwdNoPath", next)), true;
          state.cwd = next;
          state.native = {};
          if (H.projectPathFor) state.projectPath = H.projectPathFor(db, next);
          ui.ok(ui.t("cwdSet", banner.shorten(next)));
        } else {
          ui.info(state.cwd);
        }
        return true;
      case "memory": {
        const mem = H.cliMemoryContext(db, state.projectPath);
        ui.line("");
        ui.markdown(mem || ui.t("noMemory"));
        return true;
      }
      case "clear":
        state.history = [];
        state.native = {};
        if (ui.enabled) process.stdout.write("\x1b[2J\x1b[H");
        showBanner();
        return true;
      case "import":
        if (!arg) return ui.warn(ui.t("importUsage")), true;
        try {
          const r = H.importLocal(db, arg);
          ui.ok(ui.t(r.updated ? "updated" : "imported", r.name, r.kind));
        } catch (e) {
          ui.error((e && e.message) || String(e));
        }
        return true;
      case "doctor":
        H.doctor(db, ui);
        return true;
      case "status":
        banner.renderStatus({ ui, runtimeLabel: runtimeLabel(state.runtime), subjectLabel: state.subject && state.subject.label, permission: state.permission, cwd: state.cwd });
        return true;
      case "exit":
      case "quit":
      case "q":
        ui.line(ui.c.emerald("🦖 ") + ui.c.dim(ui.t("bye")));
        rl.close();
        process.exit(0);
        return false;
      default:
        ui.warn(ui.t("unknownCmd", cmd));
        return true;
    }
  }

  // ── interactive picker (when no agent was given) ──
  function chooseAndStart(setter, row) {
    setter(row);
    ui.ok(ui.t("switched", state.subject.label));
    ask();
  }
  function pick() {
    if (closed) return process.exit(0);
    printRoster();
    rl.question("\n   " + ui.c.emerald(ui.t("picker.prompt")), (line) => {
      const t = (line || "").trim();
      if (!t) return pick();
      if (t === "/exit" || t === "/quit" || t === "/q") {
        ui.line(ui.c.emerald("🦖 ") + ui.c.dim(ui.t("bye")));
        rl.close();
        return process.exit(0);
      }
      if (t === "/help" || t === "/?") {
        printHelp(ui);
        return pick();
      }
      if (/^\/import\s+/.test(t)) {
        try {
          const r = H.importLocal(db, t.replace(/^\/import\s+/, "").trim());
          ui.ok(ui.t(r.updated ? "updated" : "imported", r.name, r.kind));
        } catch (e) {
          ui.error((e && e.message) || String(e));
        }
        return pick();
      }
      const ags = H.listAgents(db);
      if (/^\d+$/.test(t)) {
        const n = parseInt(t, 10);
        if (n >= 1 && n <= ags.length) return chooseAndStart(setSubjectAgent, ags[n - 1]);
        ui.warn(ui.t("picker.noNum"));
        return pick();
      }
      if (/^firm\s+/i.test(t)) {
        const f = H.resolveFirm(db, t.replace(/^firm\s+/i, "").trim());
        if (f) return chooseAndStart(setSubjectFirm, f);
        ui.warn(ui.t("picker.noFirm"));
        return pick();
      }
      const a = H.resolveAgent(db, t);
      if (a) return chooseAndStart(setSubjectAgent, a);
      const f = H.resolveFirm(db, t);
      if (f) return chooseAndStart(setSubjectFirm, f);
      ui.warn(ui.t("picker.noMatch", t));
      return pick();
    });
  }

  // ── main loop ──
  function ask() {
    if (closed) return process.exit(0);
    rl.question("\n" + ui.promptLabel(), async (line) => {
      const t = (line || "").trim();
      if (!t) return ask();
      if (t.startsWith("/")) {
        const cont = await handleSlash(t);
        if (cont === false) return;
        return ask();
      }
      await runTurn(t);
      ask();
    });
  }

  // ── boot: first-run wizard, then banner + picker/loop ──
  async function bootstrap() {
    if (!prefs.onboarded) {
      try {
        const { runOnboard } = require("./agentlas-onboard.cjs");
        const result = await runOnboard({ ui, rl, helpers: H });
        Object.assign(prefs, result);
        ui.lang = prefs.lang || "en";
        state.permission = prefs.permission || state.permission;
        if (prefs.runtime && prefs.runtime !== "auto" && H.RUNTIME_BIN[prefs.runtime] && H.which(H.RUNTIME_BIN[prefs.runtime])) {
          state.runtime = { mode: "cli", kind: prefs.runtime };
        }
        if (opts.savePrefs) opts.savePrefs(prefs);
        ui.line("");
      } catch (e) {
        ui.error((e && e.message) || String(e));
      }
    }
    showBanner();
    if (state.subject) ask();
    else pick();
  }
  bootstrap();
}

function printHelp(ui) {
  const c = ui.c;
  const rows = [
    [ui.t("help.talkKey"), ui.t("help.talk")],
    ["/agents", ui.t("help.agents")],
    ["/agent <name>", ui.t("help.agent")],
    ["/firms · /firm <name>", ui.t("help.firms")],
    ["/runtime <kind>", ui.t("help.runtime")],
    ["/model <id>", ui.t("help.model")],
    ["/permission <lvl>", ui.t("help.permission")],
    ["/cwd [path]", ui.t("help.cwd")],
    ["/memory", ui.t("help.memory")],
    ["/import <path>", ui.t("help.import")],
    ["/clear", ui.t("help.clear")],
    ["/doctor", ui.t("help.doctor")],
    ["/exit", ui.t("help.exit")],
  ];
  ui.line("");
  for (const [k, v] of rows) ui.line("  " + c.emerald(k.padEnd(24)) + c.dim(v));
}

module.exports = { startRepl, runtimeLabel };
