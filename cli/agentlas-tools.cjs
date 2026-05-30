"use strict";
/*
 * agentlas-tools: BYOK/Ollama 자체 에이전트 루프가 실행하는 로컬 툴.
 * 권한 모델(read|write|full)을 코드 레벨에서 강제한다 — Claude/Codex의 permission-mode와 동일 의미.
 *   read  : 읽기 전용 (list_dir, read_file)
 *   write : + 파일 생성/편집 (write_file, edit_file)
 *   full  : + 셸 실행 (bash)
 * 위험 동작이 현재 권한을 넘으면 던지지 않고 에러 문자열을 tool_result로 돌려준다(루프 안전).
 */
const path = require("node:path");
const fs = require("node:fs");
const { spawnSync } = require("node:child_process");

const PERM_RANK = { read: 0, write: 1, full: 2 };

function resolveIn(cwd, p) {
  if (!p) return cwd;
  return path.isAbsolute(p) ? p : path.resolve(cwd, p);
}
function truncate(s, n) {
  s = String(s);
  return s.length <= n ? s : s.slice(0, n) + `\n…(${s.length - n} chars truncated)`;
}

const TOOLS = [
  {
    name: "list_dir",
    minPerm: "read",
    description: "List files and folders in a directory (relative to the working folder).",
    parameters: {
      type: "object",
      properties: { path: { type: "string", description: "Directory path (default: working folder)" } },
    },
    run(args, ctx) {
      const dir = resolveIn(ctx.cwd, args.path || ".");
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      const lines = entries
        .slice(0, 400)
        .map((e) => (e.isDirectory() ? e.name + "/" : e.name))
        .sort();
      return `${dir}\n` + lines.join("\n");
    },
  },
  {
    name: "read_file",
    minPerm: "read",
    description: "Read a UTF-8 text file. Optionally from a line offset.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string" },
        offset: { type: "number", description: "1-based start line" },
        limit: { type: "number", description: "max lines" },
      },
      required: ["path"],
    },
    run(args, ctx) {
      const file = resolveIn(ctx.cwd, args.path);
      let content = fs.readFileSync(file, "utf8");
      if (args.offset || args.limit) {
        const lines = content.split("\n");
        const start = Math.max(0, (args.offset || 1) - 1);
        const end = args.limit ? start + args.limit : lines.length;
        content = lines.slice(start, end).join("\n");
      }
      return truncate(content, 20000);
    },
  },
  {
    name: "write_file",
    minPerm: "write",
    description: "Create or overwrite a file with the given content.",
    parameters: {
      type: "object",
      properties: { path: { type: "string" }, content: { type: "string" } },
      required: ["path", "content"],
    },
    run(args, ctx) {
      const file = resolveIn(ctx.cwd, args.path);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const existed = fs.existsSync(file);
      fs.writeFileSync(file, args.content, "utf8");
      return `${existed ? "overwrote" : "created"} ${file} (${args.content.length} bytes)`;
    },
  },
  {
    name: "edit_file",
    minPerm: "write",
    description:
      "Replace an exact substring in a file. old_string must occur exactly once unless replace_all is true.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string" },
        old_string: { type: "string" },
        new_string: { type: "string" },
        replace_all: { type: "boolean" },
      },
      required: ["path", "old_string", "new_string"],
    },
    run(args, ctx) {
      if (args.old_string === "") throw new Error("old_string must be non-empty");
      const file = resolveIn(ctx.cwd, args.path);
      const src = fs.readFileSync(file, "utf8");
      if (!src.includes(args.old_string)) throw new Error("old_string not found");
      const count = src.split(args.old_string).length - 1;
      if (!args.replace_all && count > 1) throw new Error(`old_string occurs ${count}× (use replace_all or add context)`);
      const out = args.replace_all
        ? src.split(args.old_string).join(args.new_string)
        : src.replace(args.old_string, args.new_string);
      fs.writeFileSync(file, out, "utf8");
      return `edited ${file} (${count} replacement${count > 1 ? "s" : ""})`;
    },
  },
  {
    name: "bash",
    minPerm: "full",
    description: "Run a shell command in the working folder. Requires 'full' permission.",
    parameters: {
      type: "object",
      properties: { command: { type: "string" }, timeout_ms: { type: "number" } },
      required: ["command"],
    },
    run(args, ctx) {
      const t = Number(args.timeout_ms);
      const timeout = Math.min(Math.max(Number.isFinite(t) && t > 0 ? t : 120000, 1000), 600000);
      const res = spawnSync("bash", ["-lc", args.command], {
        cwd: ctx.cwd,
        encoding: "utf8",
        timeout,
        maxBuffer: 8 * 1024 * 1024,
        env: process.env,
      });
      const parts = [];
      if (res.stdout) parts.push(res.stdout);
      if (res.stderr) parts.push(res.stderr);
      // spawnSync는 timeout/maxBuffer/spawn 실패를 status=null + error/signal로 알린다 — 무음 실패 방지.
      let head = `exit ${res.status == null ? "?" : res.status}`;
      if (res.error) {
        head +=
          res.error.code === "ETIMEDOUT"
            ? ` (timed out after ${timeout}ms)`
            : res.error.code === "ENOBUFS"
              ? " (output exceeded 8MB, truncated)"
              : ` (spawn error: ${res.error.message})`;
      } else if (res.signal) {
        head += ` (killed by ${res.signal})`;
      }
      const body = truncate(parts.join("\n").trim() || "(no output)", 12000);
      return `${head}\n${body}`;
    },
  },
];

const BY_NAME = Object.fromEntries(TOOLS.map((t) => [t.name, t]));

// 현재 권한에서 허용되는 툴만.
function allowedTools(permission) {
  const rank = PERM_RANK[permission] ?? 0;
  return TOOLS.filter((t) => (PERM_RANK[t.minPerm] ?? 0) <= rank);
}

// 툴 1개 실행 → { ok, content }. 권한 부족/에러는 ok:false 문자열로.
function runTool(name, args, ctx) {
  const tool = BY_NAME[name];
  if (!tool) return { ok: false, content: `unknown tool: ${name}` };
  const rank = PERM_RANK[ctx.permission] ?? 0;
  if ((PERM_RANK[tool.minPerm] ?? 0) > rank) {
    return {
      ok: false,
      content: `permission denied: '${name}' requires '${tool.minPerm}' but current is '${ctx.permission}'. Ask the user to run /permission ${tool.minPerm}.`,
    };
  }
  try {
    return { ok: true, content: String(tool.run(args || {}, ctx)) };
  } catch (e) {
    return { ok: false, content: `${name} error: ${e && e.message ? e.message : String(e)}` };
  }
}

// ── provider별 tool 선언 포맷 ─────────────────────────────
function anthropicTools(permission) {
  return allowedTools(permission).map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.parameters,
  }));
}
function openaiTools(permission) {
  return allowedTools(permission).map((t) => ({
    type: "function",
    function: { name: t.name, description: t.description, parameters: t.parameters },
  }));
}

module.exports = { TOOLS, BY_NAME, allowedTools, runTool, anthropicTools, openaiTools, PERM_RANK };
