#!/usr/bin/env node
/**
 * Colour literals may only be defined in the `:root` token blocks of renderer/app/globals.css.
 * Everything else must reference a token (var(--…)). This gate fails on any hex literal outside
 * those blocks and ratchets rgb()/rgba()/hsl() literals down against a committed baseline.
 * Owner decision 2026-09-05: design colours change in one place only.
 */
const fs = require("node:fs");
const path = require("node:path");
const ROOT = path.resolve(__dirname, "..");
const BASELINE = path.join(__dirname, "colour-literal-baseline.json");
const update = process.argv.includes("--update-baseline");

// Files exempt from the rule, each with a reason.
const EXEMPT = {
  "renderer/components/ontology/OntologyAtlasScene3D.tsx": "WebGL material colours (three.js), not CSS",
  // Pending: another session holds uncommitted edits here (2026-09-05). Migrate right after it commits,
  // then delete these three lines so the gate covers them.
  "renderer/components/LiveOutputViewer.module.css": "pending peer commit",
  "renderer/components/ChatRightPanel.tsx": "pending peer commit",
  "renderer/components/UniversalFileViewerEngine.tsx": "pending peer commit",
};

function walk(dir, acc) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (["node_modules", "out"].includes(e.name) || e.name.startsWith(".")) continue; walk(p, acc); }
    else if (/\.(css|tsx)$/.test(e.name)) acc.push(p);
  }
  return acc;
}
const HEX = /#(?:[0-9a-fA-F]{6}|[0-9a-fA-F]{3})\b(?![0-9a-fA-F])/g;
const FN = /\b(?:rgba?|hsla?)\(/g;

function scan(file) {
  const src = fs.readFileSync(file, "utf8");
  const hex = [], fn = [];
  let depth = 0, root = -1;
  src.split("\n").forEach((line, i) => {
    const t = line.trim();
    if (file.endsWith(".css") && root < 0 && /^:root\b[^{]*\{/.test(t)) root = depth;
    // A colour literal may stay ONLY where a token cannot reach: a canvas fillStyle, a
    // standalone exported document, a QR/SVG data URI, or a 3D material. Mark the line with
    // `colour-literal-allowed: <reason>` (in a comment) so the exception is visible in review.
    const allowed = /colour-literal-allowed:/.test(line);
    if (root < 0 && !allowed) {
      // ignore URL fragments like url(#id) and template ids
      const cleaned = line.replace(/url\([^)]*\)/g, "").replace(/href="#[^"]*"/g, "");
      for (const m of cleaned.match(HEX) || []) hex.push({ line: i + 1, literal: m });
      for (const m of cleaned.match(FN) || []) fn.push({ line: i + 1, literal: m });
    }
    const before = depth;
    for (const c of line) { if (c === "{") depth++; else if (c === "}") depth--; }
    if (root >= 0 && depth <= root && before > root) root = -1;
  });
  return { hex, fn };
}

const files = walk(path.join(ROOT, "renderer"), []);
const hexOffenders = [];
const fnCounts = {};
for (const f of files) {
  const rel = path.relative(ROOT, f).split(path.sep).join("/");
  if (EXEMPT[rel]) continue;
  const { hex, fn } = scan(f);
  if (hex.length) hexOffenders.push({ file: rel, hits: hex });
  if (fn.length) fnCounts[rel] = fn.length;
}
const fnTotal = Object.values(fnCounts).reduce((a, b) => a + b, 0);
if (update) {
  fs.writeFileSync(BASELINE, JSON.stringify({ rgbFunctionLiterals: fnTotal, perFile: fnCounts }, null, 2) + "\n");
  console.log(`baseline updated: ${fnTotal} rgb/hsl literal(s)`);
}
const baseline = fs.existsSync(BASELINE) ? JSON.parse(fs.readFileSync(BASELINE, "utf8")) : { rgbFunctionLiterals: Infinity, perFile: {} };
let failed = false;
if (hexOffenders.length) {
  failed = true;
  console.error(`✖ ${hexOffenders.reduce((a, o) => a + o.hits.length, 0)} hex colour literal(s) outside the token blocks:`);
  for (const o of hexOffenders) for (const h of o.hits.slice(0, 5)) console.error(`  ${o.file}:${h.line}  ${h.literal}`);
  console.error("  → define the colour once in renderer/app/globals.css :root and reference var(--token).");
  console.error("     If a token genuinely cannot reach the line (canvas, exported document, 3D material),");
  console.error("     mark it with a `colour-literal-allowed: <reason>` comment on the same line.");
}
const grew = Object.entries(fnCounts).filter(([f, n]) => n > (baseline.perFile[f] ?? 0));
if (grew.length) {
  failed = true;
  console.error(`✖ rgb()/rgba()/hsl() literals grew in ${grew.length} file(s) (baseline ratchet):`);
  for (const [f, n] of grew) console.error(`  ${f}: ${n} (baseline ${baseline.perFile[f] ?? 0})`);
}
if (!failed) console.log(`colour tokens gate: ok — 0 hex literals outside token blocks, ${fnTotal} rgb/hsl literal(s) (baseline ${baseline.rgbFunctionLiterals})`);
process.exit(failed ? 1 : 0);
