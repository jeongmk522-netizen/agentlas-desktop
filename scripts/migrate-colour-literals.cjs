#!/usr/bin/env node
/**
 * One-time codemod: replace hard-coded colour literals in renderer/** with design tokens.
 * The only place colours may be defined is the `:root` token blocks in renderer/app/globals.css.
 * Usage: node scripts/migrate-colour-literals.cjs [--dry] [--report out.json] [files...]
 */
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const args = process.argv.slice(2);
const dry = args.includes("--dry");
const reportIdx = args.indexOf("--report");
const reportPath = reportIdx >= 0 ? args[reportIdx + 1] : null;
const explicit = args.filter((a, i) => !a.startsWith("--") && !(i > 0 && args[i - 1] === "--report"));

// Files another session is editing right now — never touched by this codemod.
const SKIP = new Set([
  "renderer/components/ChatFileExperience.tsx",
  "renderer/components/ChatRightPanel.tsx",
  "renderer/components/LiveOutputViewer.module.css",
  "renderer/components/LiveOutputViewer.tsx",
  "renderer/components/UniversalFileViewerEngine.tsx",
  "renderer/components/one/OneActivityTimeline.tsx",
  "renderer/components/ontology/OntologyAtlasScene3D.tsx", // WebGL material colours, not CSS
]);

const norm = (hex) => {
  let h = hex.toLowerCase();
  if (h.length === 4) h = "#" + [...h.slice(1)].map((c) => c + c).join("");
  return h;
};

// Semantic map. Keys are normalised 6-digit hex. Values may depend on the CSS property role.
const SURFACE_WHITE = new Set(["#ffffff"]);
const SURFACE_NEAR_WHITE = new Set(["#fafafa", "#fbfcfc", "#fafbfc", "#fafbf9", "#f8f8f8", "#fcfcfc", "#fdfdfd", "#fbfbfb", "#f9f9f9", "#fafaf9", "#f8f8f7", "#f9fafb", "#fbfbfa"]);
const SURFACE_SOFT = new Set(["#f1f2f3", "#f4f5f5", "#f1f2f2", "#f2f3f4", "#f2f3f3", "#f4f5f4", "#f3f4f8", "#f0f2f1", "#f3f4f6", "#f7f8f8", "#f5f7f5", "#f5f5f5", "#f4f4f4", "#f6f6f6", "#f0f0f0", "#f3f3f3", "#f2f2f2", "#f5f6f7", "#f6f7f7", "#f4f6f5", "#f0f1f2", "#f7f7f7", "#f5f6f6", "#eef0f1", "#eceeef", "#ecefed", "#efefef", "#f1f1f1"]);
const EDGE = new Set(["#ececea", "#e2e4e5", "#dfe2e4", "#e8e8ea", "#e0e2e3", "#e7e9ea", "#e5e7eb", "#e4e6e7", "#e7e9e4", "#e6e7e8", "#e3e5e6", "#e8eaeb", "#e9ebec", "#eaeaea", "#e5e5e5", "#e6e6e6", "#e8e8e8", "#eeeeee", "#ebebeb", "#e0e0e0", "#dddddd", "#e2e2e2", "#dedede"]);
const EDGE_STRONG = new Set(["#d7dbd9", "#dedfd9", "#cfd3d5", "#cfd4dc", "#d9dde3", "#dfe3e8", "#d0d4d6", "#d4d7d9", "#d1d5d8", "#cccccc", "#d0d0d0", "#d9d9d9", "#d6d6d6", "#c9cdd0", "#c8ccce", "#d3d6d8", "#dadddf", "#d5d8da"]);
const INK = new Set(["#111111", "#1d2023", "#303532", "#34383b", "#343936", "#292d30", "#161918", "#2c3033", "#17191b", "#202326", "#202421", "#24282b", "#25292c", "#303438", "#000000", "#101010", "#121212", "#141414", "#1a1a1a", "#1b1b1b", "#222222", "#1f2225", "#1e2124", "#23272a", "#26292c", "#2a2e31", "#2b2f32", "#333333", "#2d3134", "#2f3336", "#1c1f22", "#212529", "#001519", "#0b0b0f", "#0f1113"]);
const INK_SOFT = new Set(["#4a5054", "#5f666b", "#555d68", "#51504e", "#4b5155", "#4f5559", "#454b50", "#3f4448", "#444444", "#555555", "#4d5256", "#474a35", "#3c534f", "#52575b", "#4c5256"]);
const MUTED_DEEP = new Set(["#6e7479", "#8b9096", "#666666", "#777d7a", "#747a70", "#777d81", "#868483", "#7a818b", "#6f757a", "#70767b", "#7b8185", "#80868b", "#777777", "#888888", "#6c7277", "#737a7e", "#7c8287", "#858a8f", "#8a9095", "#8e9398", "#787e82", "#6d7378"]);
const MUTED = new Set(["#a6abb0", "#aeb4b8", "#b8bbbf", "#9aa0a5", "#a0a5aa", "#b0b5b9", "#9ea3a8", "#aaaaaa", "#999999", "#a8adb2", "#b4b9bd", "#adb2b6", "#bbbbbb", "#c0c4c7", "#c2c6c9", "#a9aeb3", "#9da2a7"]);
const DANGER = new Set(["#d92d20", "#c0392b", "#d64545", "#b42318", "#8e352b", "#b4533a", "#c92a2a", "#e03131", "#dc2626", "#b91c1c", "#a33a2c", "#9b3131", "#c53030", "#b3261e"]);
const DANGER_SOFT = new Set(["#fff2f2", "#fdecec", "#fdeaea", "#fee2e2", "#fef2f2", "#ffe9e9", "#f9e5e2", "#fbeae7", "#efc5c5", "#f5c6c6"]);
const OK = new Set(["#607a36", "#4f6e35", "#176b46", "#087b69", "#2f855a", "#1f7a4d", "#3b7a57", "#4c7a3d", "#2e7d32", "#6c7050", "#5c7a3a", "#2b8a3e"]);
const OK_SOFT = new Set(["#eaf2e2", "#e6f0dc", "#edf5e6", "#e8f3e8", "#e3f1e9", "#e6f4ea", "#dcefe3"]);
const WARN = new Set(["#9c8430", "#b7791f", "#a16207", "#8a6f2e", "#b08a2e", "#9a7b1c"]);
const WARN_SOFT = new Set(["#fff4ce", "#fdf3d7", "#fbf1d5", "#fef3c7", "#fff7e0"]);
const INFO = new Set(["#0c2c47", "#1f4e79", "#1e40af", "#2b5f8f", "#5d7a76", "#24635f"]);
const ACCENT = new Set(["#6b6e52"]);
const ACCENT_STRONG = new Set(["#55583f"]);
const PURPLE = new Set(["#7c7cff", "#6f7464", "#7c3aed", "#6d28d9"]);
const RUN_ACCENT = new Set(["#d97757"]);

function tokenForV1(hex, role) {
  const h = norm(hex);
  if (SURFACE_WHITE.has(h)) return role === "text" ? "var(--white)" : "var(--paper)";
  if (SURFACE_NEAR_WHITE.has(h)) return "var(--paper-2)";
  if (SURFACE_SOFT.has(h)) return role === "border" ? "var(--paper-edge)" : "var(--paper-3)";
  if (EDGE.has(h)) return role === "surface" ? "var(--paper-3)" : "var(--paper-edge)";
  if (EDGE_STRONG.has(h)) return "var(--paper-edge-strong)";
  if (INK.has(h)) return role === "surface" ? "var(--ink)" : "var(--ink)";
  if (INK_SOFT.has(h)) return "var(--ink-soft)";
  if (MUTED_DEEP.has(h)) return "var(--muted-deep)";
  if (MUTED.has(h)) return "var(--muted)";
  if (DANGER.has(h)) return "var(--danger)";
  if (DANGER_SOFT.has(h)) return "var(--danger-soft)";
  if (OK.has(h)) return "var(--ok)";
  if (OK_SOFT.has(h)) return "var(--ok-soft)";
  if (WARN.has(h)) return "var(--warn)";
  if (WARN_SOFT.has(h)) return "var(--warn-soft)";
  if (INFO.has(h)) return "var(--info)";
  if (ACCENT.has(h)) return "var(--accent)";
  if (ACCENT_STRONG.has(h)) return "var(--accent-strong)";
  if (PURPLE.has(h)) return "var(--purple-deep)";
  if (RUN_ACCENT.has(h)) return "var(--run-accent)";
  return classify(h, role);
}


function hsl(h) {
  const r = parseInt(h.slice(1, 3), 16) / 255, g = parseInt(h.slice(3, 5), 16) / 255, b = parseInt(h.slice(5, 7), 16) / 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b), l = (max + min) / 2, d = max - min;
  const sat = d === 0 ? 0 : d / (1 - Math.abs(2 * l - 1));
  return { l, sat };
}

/**
 * v2 (2026-09-05, after the One user-bubble regression): tokens come in two kinds.
 *  - theme-aware tokens (--ink, --paper…) flip in dark mode and are LOCALLY OVERRIDDEN inside
 *    dark objects such as the user bubble (`--ink: light` inside `.message[data-role=user]`).
 *    Mapping a dark *surface* to var(--ink) therefore paints it light wherever --ink is overridden.
 *  - theme-invariant tokens (--black, --white, --white-soft, --white-faint) never flip.
 * Rules: dark objects (surfaces/borders with a dark literal) → --black/--black-soft; light text →
 * --white/--white-soft/--white-faint; a custom-property DEFINITION never maps to itself and prefers
 * invariant tokens; near-neutral tints are neutral, not status colours.
 */
const PAPER_LADDER = ["var(--paper)", "var(--paper-2)", "var(--paper-3)", "var(--paper-edge)", "var(--paper-edge-strong)"];
const GREY_LADDER = ["var(--muted)", "var(--muted-deep)", "var(--ink-soft)"];
const DROP = "__DROP__"; // a self-referencing local override that is a no-op in light mode

function paperStep(l) { return l >= 0.985 ? 0 : l >= 0.955 ? 1 : l >= 0.9 ? 2 : l >= 0.85 ? 3 : 4; }

function tokenFor(hex, role, ctx = {}) {
  const h = norm(hex);
  const { l, sat } = hsl(h);
  const neutral = sat < 0.14 || (sat < 0.36 && (l >= 0.9 || l <= 0.16)) || (sat < 0.22 && (l > 0.85 || l < 0.2));
  const defName = ctx.definedProperty || null;
  const dark = !!ctx.darkScope;
  let tok;
  if (defName && neutral) {
    // Local token override. Inside a dark object use the invariant white/black family; inside a
    // light scope stay on the theme-aware ladders and never point a token at itself.
    if (dark) tok = l >= 0.75 ? (l >= 0.95 ? "var(--white)" : "var(--white-soft)") : l >= 0.5 ? "var(--white-faint)" : l <= 0.22 ? "var(--black)" : "var(--black-soft)";
    else if (l >= 0.985) tok = "var(--white)"; // exact white never cycles and never flips
    else if (role === "border" && l >= 0.75) { tok = l >= 0.87 ? "var(--paper-edge)" : "var(--paper-edge-strong)"; if (tok === `var(--${defName})`) tok = l >= 0.87 ? "var(--paper-edge-strong)" : "var(--paper-edge)"; }
    else if (l >= 0.85) { let i = paperStep(l); if (PAPER_LADDER[i] === `var(--${defName})`) i = i === 4 ? 3 : i + 1; tok = PAPER_LADDER[i]; }
    else if (l >= 0.35) { let i = l >= 0.58 ? 0 : l >= 0.42 ? 1 : 2; if (GREY_LADDER[i] === `var(--${defName})`) i = i === 2 ? 1 : i + 1; tok = GREY_LADDER[i]; }
    else tok = defName === "ink" ? DROP : "var(--ink)";
    return tok;
  }
  if (neutral && l <= 0.35 && role !== "text") tok = l <= 0.22 ? "var(--black)" : "var(--black-soft)";
  else if (neutral && l >= 0.75 && role === "text") tok = l >= 0.95 ? "var(--white)" : "var(--white-soft)";
  else if (neutral && l >= 0.5 && l < 0.75 && role === "text" && dark) tok = "var(--white-faint)";
  else if (neutral && l >= 0.9 && role !== "text") tok = PAPER_LADDER[paperStep(l)];
  else tok = tokenForV1(hex, role);
  if (defName && tok === `var(--${defName})`) tok = DROP;
  return tok;
}

/** Fallback: classify any hex by hue/saturation/lightness into the semantic ladder. */
function classify(h, role) {
  const r = parseInt(h.slice(1, 3), 16) / 255, g = parseInt(h.slice(3, 5), 16) / 255, b = parseInt(h.slice(5, 7), 16) / 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  const l = (max + min) / 2;
  const d = max - min;
  const sat = d === 0 ? 0 : d / (1 - Math.abs(2 * l - 1));
  let hue = 0;
  if (d !== 0) {
    if (max === r) hue = ((g - b) / d) % 6; else if (max === g) hue = (b - r) / d + 2; else hue = (r - g) / d + 4;
    hue = (hue * 60 + 360) % 360;
  }
  // tints (fills/badges) are "soft" from mid-light on; text keeps the deep variant until it is very light
  const soft = role === "text" ? l > 0.84 : l > 0.62;
  if (sat < 0.14 || (sat < 0.22 && (l > 0.9 || l < 0.2))) {
    // neutral ladder
    if (l >= 0.985) return role === "text" ? "var(--white)" : "var(--paper)";
    if (l >= 0.955) return "var(--paper-2)";
    if (l >= 0.915) return role === "border" ? "var(--paper-edge)" : "var(--paper-3)";
    if (l >= 0.87) return role === "surface" ? "var(--paper-3)" : "var(--paper-edge)";
    if (l >= 0.78) return role === "text" ? "var(--muted)" : "var(--paper-edge-strong)";
    if (l >= 0.58) return "var(--muted)";
    if (l >= 0.42) return "var(--muted-deep)";
    if (l >= 0.27) return "var(--ink-soft)";
    return "var(--ink)";
  }
  // olive/moss accent family (brand)
  if (hue >= 50 && hue <= 95 && sat < 0.35 && l < 0.55) return "var(--accent)";
  if (hue >= 345 || hue < 20) return soft ? "var(--danger-soft)" : "var(--danger)";
  if (hue >= 20 && hue < 60) return soft ? "var(--warn-soft)" : "var(--warn)";
  if (hue >= 60 && hue < 175) return soft ? "var(--ok-soft)" : "var(--ok)";
  if (hue >= 175 && hue < 265) return soft ? "var(--info-soft)" : "var(--info)";
  return soft ? "var(--purple-soft)" : "var(--purple-deep)";
}

const HEX_RE = /#(?:[0-9a-fA-F]{6}|[0-9a-fA-F]{3})\b(?![0-9a-fA-F])/g;

function definedPropertyOf(prefix) {
  const m = /(?:^|[;{\s])--([a-z0-9-]+)\s*:\s*[^;{}]*$/i.exec(prefix);
  return m ? m[1].toLowerCase() : null;
}

function roleOf(prefix, kind = "css") {
  // prefix = text on the line before the literal; in JS object literals a comma ends the previous property
  const m = (kind === "tsx" ? /([A-Za-z-]+)\s*[:=]\s*(?:["'`{]?[^;{},]*)$/ : /([A-Za-z-]+)\s*[:=]\s*(?:["'`{]?[^;{}]*)$/).exec(prefix);
  const prop = (m ? m[1] : "").toLowerCase();
  if (/^--/.test((/(--[a-z0-9-]+)\s*:\s*[^;{}]*$/i.exec(prefix) || [""])[0])) {
    const name = definedPropertyOf(prefix) || "";
    if (/(^|-)(ink|text|fg|foreground|muted|faint|line|hair)(-|$)/.test(name)) return /(line|hair)/.test(name) ? "border" : "text";
    if (/(^|-)(paper|bg|surface|panel|fill)(-|$)/.test(name)) return "surface";
    return "surface";
  }
  if (/^(color|fill|stroke|caretcolor|caret-color|textdecorationcolor|text-decoration-color|webkittextfillcolor|-webkit-text-fill-color)$/.test(prop)) return "text";
  if (/border|outline|boxshadow|box-shadow|columnrule/.test(prop)) return "border";
  if (/background|bg|shadow/.test(prop)) return "surface";
  return "surface";
}

function isDarkLiteral(v) { const h = /#(?:[0-9a-fA-F]{6}|[0-9a-fA-F]{3})\b/.exec(v); if (!h) return /var\(--black/.test(v); const { l, sat } = hsl(norm(h[0])); return l <= 0.35 && (sat < 0.36); }

/** For each line of a CSS source: is it inside a rule block whose background is a dark object? */
function darkScopes(src) {
  const lines = src.split("\n"); const out = new Array(lines.length).fill(false);
  for (let i = 0; i < lines.length; i++) {
    if (!/\{\s*$/.test(lines[i]) && !/\{[^}]*$/.test(lines[i])) continue;
    let depth = 0, dark = false, j = i;
    for (; j < lines.length; j++) {
      for (const c of lines[j]) { if (c === "{") depth++; else if (c === "}") depth--; }
      const m = /background(?:-color)?\s*:\s*([^;}]*)/.exec(lines[j]); if (m && isDarkLiteral(m[1])) dark = true;
      if (depth <= 0) break;
    }
    if (dark) for (let k = i; k <= j && k < lines.length; k++) out[k] = true;
  }
  return out;
}

function mapLine(line, kind, version, ctx = {}) {
  const pick = version === 1 ? (hex, role) => tokenForV1(hex, role) : (hex, role, c) => tokenFor(hex, role, c);
  const lineDark = ctx.darkScope || (kind === "tsx" && /background(?:Color)?\s*:\s*["'`]?[^,;]*(#(?:1[0-9a-f]|0[0-9a-f]|2[0-9a-f])[0-9a-f]{4}\b|var\(--black)/i.test(line));
  const mapped = line.replace(HEX_RE, (hex, offset) => {
    const pre = line.slice(0, offset);
    if (kind === "tsx") { const q = Math.max(pre.lastIndexOf('"'), pre.lastIndexOf("'"), pre.lastIndexOf("`")); if (q < 0) return hex; }
    return pick(hex, roleOf(pre, kind), { definedProperty: definedPropertyOf(pre), darkScope: lineDark }) || hex;
  });
  if (mapped.includes(DROP)) {
    // a self-referencing local override: remove the declaration, keep the line as a note
    const m = /^(\s*)(--[a-z0-9-]+)\s*:\s*[^;]*;?/.exec(mapped);
    return m ? `${m[1]}/* ${m[2]} local override removed — it would reference itself (colour migration 2026-09-05) */` : mapped.replace(DROP, "var(--ink)");
  }
  return mapped;
}

function migrateCss(src) {
  const lines = src.split("\n");
  const scopes = darkScopes(src);
  let depth = 0;
  let rootDepth = -1; // depth at which a :root block opened
  const changes = [];
  const out = lines.map((line, idx) => {
    const beforeDepth = depth;
    // track :root blocks so their declarations are left alone
    const trimmed = line.trim();
    if (rootDepth < 0 && /^:root\b[^{]*\{/.test(trimmed)) rootDepth = depth;
    let result = line;
    if (rootDepth < 0) {
      result = mapLine(line, "css", 2, { darkScope: scopes[idx] });
      for (const hex of line.match(HEX_RE) || []) changes.push(result === line ? { line: idx + 1, hex, kept: true } : { line: idx + 1, hex, token: "mapped" });
    }
    for (const ch of line) { if (ch === "{") depth++; else if (ch === "}") depth--; }
    if (rootDepth >= 0 && depth <= rootDepth && beforeDepth > rootDepth) rootDepth = -1;
    if (rootDepth >= 0 && depth <= rootDepth && /\}/.test(line) && beforeDepth === rootDepth + 1) rootDepth = -1;
    return result;
  });
  return { text: out.join("\n"), changes };
}

function migrateTsx(src) {
  const changes = [];
  const lines = src.split("\n");
  const out = lines.map((line, idx) => {
    const result = mapLine(line, "tsx", 2);
    for (const hex of line.match(HEX_RE) || []) changes.push(result === line ? { line: idx + 1, hex, kept: true } : { line: idx + 1, hex, token: "mapped" });
    return result;
  });
  return { text: out.join("\n"), changes };
}

function walk(dir, acc) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (e.name === "node_modules" || e.name === "out" || e.name.startsWith(".")) continue; walk(p, acc); }
    else if (/\.(css|tsx)$/.test(e.name)) acc.push(p);
  }
  return acc;
}

module.exports = { mapLine, tokenFor, tokenForV1, roleOf, definedPropertyOf, darkScopes, SKIP };
if (require.main !== module) return;
const files = (explicit.length ? explicit.map((f) => path.resolve(ROOT, f)) : walk(path.join(ROOT, "renderer"), []))
  .filter((f) => !SKIP.has(path.relative(ROOT, f).split(path.sep).join("/")));

const report = [];
let replaced = 0, kept = 0;
for (const f of files) {
  const src = fs.readFileSync(f, "utf8");
  const { text, changes } = f.endsWith(".css") ? migrateCss(src) : migrateTsx(src);
  const r = changes.filter((c) => c.token).length; const k = changes.filter((c) => c.kept).length;
  replaced += r; kept += k;
  if (r) { if (!dry) fs.writeFileSync(f, text); }
  if (r || k) report.push({ file: path.relative(ROOT, f), replaced: r, kept: k, keptLiterals: [...new Set(changes.filter((c) => c.kept).map((c) => norm(c.hex)))] });
}
if (reportPath) fs.writeFileSync(reportPath, JSON.stringify({ replaced, kept, files: report }, null, 2));
console.log(`${dry ? "[dry] " : ""}replaced ${replaced} literal(s), kept ${kept} across ${report.length} file(s)`);
