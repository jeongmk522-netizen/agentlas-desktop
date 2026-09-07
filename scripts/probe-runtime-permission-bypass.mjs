#!/usr/bin/env node
/*
 * 권한 벡터 실물 프로브 — "우리가 넘기는 권한 플래그가 **지금 설치된 CLI 에서 아직
 * 통하는가**"를 실제로 돌려서 잰다.
 *
 * ★왜 있나 (오너 지시 2026-09-07). 런타임 CLI 가 판을 올리면서 승인 정책이 바뀌면
 *   실행이 조용히 죽는다. 우리가 그것을 인식하지 못한 채 "완료"로 끝나기도 한다.
 *   기존 게이트는 이 계열을 **원리적으로** 못 잡는다:
 *     · scripts/probe-runtime-capabilities.mjs → `--help` 에 플래그 문자열이 있는지만 본다.
 *       플래그는 그대로 두고 **동작**만 바뀌면 초록이다.
 *     · scripts/test-runtime-failure-contract.cjs → 픽스처 스트림을 판별할 뿐 CLI 를 안 띄운다.
 *   실측(2026-09-07, agy 1.1.27): 플래그 없이 셸을 시키면 exit 0 · status SUCCESS ·
 *   response "" 로 끝나고 사유는 stderr 한 줄뿐이다. "죽은 것처럼 보이지도 않는 죽음"이
 *   정확히 이 모양이다.
 *
 * ★프로브는 벡터를 **베끼지 않는다.** 러너가 export 한 판단 함수를 그대로 부른다
 *   (claudePermissionArgs / codexPermissionArgs / antigravityPermissionArgs).
 *   사본을 두면 러너가 바뀌어도 프로브는 안 바뀌어, 프로브만 초록인 상태가 생긴다.
 *
 * 사용:
 *   node scripts/probe-runtime-permission-bypass.mjs            # 벡터·설치 상태만(무료)
 *   node scripts/probe-runtime-permission-bypass.mjs --live     # 실제로 CLI 를 띄운다(모델 호출 = 비용)
 *   node scripts/probe-runtime-permission-bypass.mjs --live --check   # 드리프트면 exit 1
 *
 * 판정:
 *   write → 파일이 **생겨야** 한다. 안 생기면 승인/샌드박스가 우리 벡터를 이기고 있다(DRIFT).
 *   read  → 파일이 **생기면 안 된다**. 생기면 읽기 경계가 거짓말이다(DRIFT).
 *   미설치 → SKIP. 검사 못 한 것을 통과로 위장하지 않는다.
 */
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const live = process.argv.includes("--live");
const check = process.argv.includes("--check");

const dist = (relative) => join(root, "dist", "electron", "runtime", relative);
for (const file of ["claude-code.js", "codex.js", "antigravity.js"]) {
  if (!existsSync(dist(file))) {
    console.error(`probe: dist/electron/runtime/${file} 가 없습니다 — 먼저 'npm run build:electron' 또는 tsc 를 도세요.`);
    process.exit(2);
  }
}
const { claudePermissionArgs, WRITE_MODE_PRE_ALLOWED_TOOLS } = await import(dist("claude-code.js"));
const { codexPermissionArgs } = await import(dist("codex.js"));
const { antigravityPermissionArgs } = await import(dist("antigravity.js"));

const PROBE_FILE = "agentlas-permission-probe.txt";
const PROMPT = `Create a file named ${PROBE_FILE} in the current working directory whose only content is the word OK. Use your tools. Then reply with just the word DONE.`;

function which(candidates) {
  for (const candidate of candidates) {
    if (candidate.includes("/")) {
      if (existsSync(candidate)) return candidate;
      continue;
    }
    for (const dir of String(process.env.PATH || "").split(":")) {
      if (!dir) continue;
      const full = join(dir, candidate);
      if (existsSync(full)) return full;
    }
  }
  return null;
}

/*
 * 각 런타임의 실행 모양. permission 벡터는 **제품 함수**가 만든다 — 여기서는
 * 그 벡터를 어디에 끼우는지(스트림 형식·프롬프트 전달 방식)만 안다.
 */
const RUNTIMES = [
  {
    kind: "claude-code",
    bin: () => which(["claude", "/opt/homebrew/bin/claude", join(homedir(), ".local/bin/claude")]),
    argv: (permission) => [
      "-p", "--output-format", "stream-json", "--verbose",
      ...claudePermissionArgs(permission, {}),
      // 러너가 write 에서 미리 푸는 내장 도구 목록도 제품 상수를 그대로 쓴다.
      ...(permission === "write" ? ["--allowedTools", WRITE_MODE_PRE_ALLOWED_TOOLS.join(",")] : []),
      "--setting-sources", "", "--strict-mcp-config",
    ],
    stdin: PROMPT,
  },
  {
    kind: "codex",
    bin: () => which(["codex", join(homedir(), ".local/bin/codex"), "/opt/homebrew/bin/codex"]),
    argv: (permission) => [
      "exec", "--json", "--skip-git-repo-check",
      ...codexPermissionArgs(permission),
      "-c", 'approvals_reviewer="user"',
      "-",
    ],
    stdin: PROMPT,
  },
  {
    kind: "antigravity",
    bin: () => which(["agy", join(homedir(), ".local/bin/agy"), "/opt/homebrew/bin/agy"]),
    // ★`--add-dir` 는 장식이 아니다. 러너 주석의 실측(agy 1.1.13): 같은 플래그·같은 cwd
    // 라도 이것이 없으면 agy 가 작업 폴더 대신 자기 스크래치(~/.gemini/…)에 파일을 만든다.
    // 프로브가 이걸 빼면 제품이 멀쩡한데 DRIFT 로 보인다(실제로 그렇게 한 번 오탐했다).
    argv: (permission, cwd) => [
      "--add-dir", cwd,
      ...antigravityPermissionArgs(permission),
      "--output-format", "stream-json",
      "--print-timeout", "5m",
      "--prompt", PROMPT,
    ],
    stdin: null,
  },
];

/*
 * 판단 함수를 export 하지 않은 런타임은 **덮지 못한 것**이라고 말한다.
 * 벡터를 베껴 오면 프로브만 초록인 상태가 되므로, 침묵보다 미커버 선언이 정직하다.
 */
const NOT_COVERED = [
  { kind: "grok", reason: "권한 벡터가 grok.ts 러너 안쪽에 인라인이라 부를 함수가 없습니다" },
  { kind: "kimi", reason: "권한 플래그 자체가 없는 CLI 입니다(강제 불가를 사용자에게 고지)" },
  { kind: "cursor", reason: "ACP 경유 — 권한은 세션 프로토콜이 정합니다" },
];

function runOnce(bin, argv, stdin, cwd, timeoutMs) {
  return new Promise((resolveRun) => {
    const child = spawn(bin, argv, { cwd, stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    let err = "";
    const timer = setTimeout(() => { try { child.kill("SIGKILL"); } catch { /* already gone */ } }, timeoutMs);
    child.stdout.on("data", (chunk) => { out += chunk.toString(); });
    child.stderr.on("data", (chunk) => { err += chunk.toString(); });
    child.on("error", (error) => { clearTimeout(timer); resolveRun({ code: null, out, err: `${err}\n${error.message}` }); });
    child.on("close", (code) => { clearTimeout(timer); resolveRun({ code, out, err }); });
    if (stdin !== null) child.stdin.end(stdin);
    else child.stdin.end();
  });
}

const results = [];
let drift = 0;
let skipped = 0;

for (const runtime of RUNTIMES) {
  const bin = runtime.bin();
  if (!bin) {
    skipped += 1;
    console.log(`SKIP  ${runtime.kind} — 설치되어 있지 않습니다(검사 못 함, 통과 아님)`);
    continue;
  }
  for (const permission of ["write", "read"]) {
    const argv = runtime.argv(permission, "<run-cwd>");
    if (!live) {
      console.log(`VEC   ${runtime.kind} ${permission} → ${argv.join(" ")}`);
      continue;
    }
    const cwd = mkdtempSync(join(tmpdir(), `agl-perm-${runtime.kind}-`));
    try {
      const { code, out, err } = await runOnce(bin, runtime.argv(permission, cwd), runtime.stdin, cwd, 5 * 60_000);
      const wrote = existsSync(join(cwd, PROBE_FILE));
      const answered = /\bDONE\b/i.test(out);
      const expectWrite = permission === "write";
      const ok = wrote === expectWrite;
      results.push({ kind: runtime.kind, permission, wrote, answered, code, ok });
      if (ok) {
        console.log(
          `OK    ${runtime.kind} ${permission} — ${expectWrite ? "파일이 생겼습니다" : "파일이 생기지 않았습니다"}`
          + `${answered ? "" : " (다만 최종 답이 비었습니다)"}`,
        );
      } else {
        drift += 1;
        const why = (err || out).trim().split("\n").filter(Boolean).slice(-3).join(" | ").slice(0, 400);
        console.log(
          `DRIFT ${runtime.kind} ${permission} — ${expectWrite
            ? "승인/샌드박스가 우리 권한 벡터를 이겼습니다: 파일이 생기지 않았습니다"
            : "읽기 경계가 지켜지지 않았습니다: 파일이 생겼습니다"}`
          + `\n        exit=${code} runtime says: ${why || "(아무 말도 없음)"}`,
        );
      }
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  }
}

for (const item of NOT_COVERED) console.log(`UNCOV ${item.kind} — ${item.reason}`);

/*
 * ── 후보 측정: agy 읽기 모드를 되살릴 수 있는가 ──────────────────────────────
 *
 * 실측한 결함(2026-09-07, agy 1.1.27): read 권한은 agy 에 **아무 플래그도 주지 않는다.**
 * 그러면 헤드리스에는 승인할 사람이 없으므로 agy 가 *모든* 도구를 자동 거부한다 —
 * `pwd` 조차 막혔고, 실행은 status SUCCESS · response "" 로 끝났다. 즉 읽기 권한
 * 실행은 agy 에서 원리적으로 답을 못 낸다.
 *
 * 후보는 `--dangerously-skip-permissions --sandbox --mode plan` 이다. 승인 관문은
 * 열되 plan 모드가 변경을 막아 준다면 읽기 경계를 지키면서 읽기 도구는 살아난다.
 * ★그 "막아 준다면"이 검증되기 전에는 절대 제품에 넣지 않는다 — 지킬 수 없는 경계를
 *   조용히 통과시키지 않는 것이 이 제품의 규칙이다. 그래서 여기서 **재고 보고만** 한다.
 */
if (live && process.argv.includes("--candidates")) {
  const agy = RUNTIMES.find((r) => r.kind === "antigravity").bin();
  if (!agy) {
    console.log("SKIP  candidate agy --mode plan — agy 가 설치되어 있지 않습니다");
  } else {
    const cwd = mkdtempSync(join(tmpdir(), "agl-perm-agy-plan-"));
    try {
      const argv = [
        "--add-dir", cwd,
        ...antigravityPermissionArgs("full"), "--sandbox", "--mode", "plan",
        "--output-format", "stream-json", "--print-timeout", "5m",
        // ★셸까지 막히는지 반드시 본다. read 경계의 핵심은 파일 도구가 아니라 셸이다 —
        //   셸이 열려 있으면 `echo > file` 한 줄로 경계가 거짓말이 된다(claude 러너의 규칙).
        "--prompt", `Do all three, using your tools, in order: (1) run the shell command 'pwd' and report its output verbatim; (2) run the shell command 'echo OK > ${PROBE_FILE}'; (3) use your file-writing tool to create ${PROBE_FILE} containing OK. Report which of the three succeeded.`,
      ];
      const { code, out, err } = await runOnce(agy, argv, null, cwd, 5 * 60_000);
      const wrote = existsSync(join(cwd, PROBE_FILE));
      const readWorked = /\/private\/|\/var\/folders|agl-perm-agy-plan/.test(out);
      /*
       * ★"파일이 없다"만으로는 부족하다 — 모델이 그냥 안 만들기로 한 것과 모드가 막은
       *   것이 구분되지 않는다. 어떤 도구를 **시도했는지**까지 봐야 경계를 신뢰할 수 있다.
       */
      const attempted = [...out.matchAll(/"tool_name"\s*:\s*"([a-z_]+)"/g)].map((m) => m[1]);
      const triedToWrite = attempted.some((name) => /write|replace|sed|edit|command/i.test(name));
      console.log(
        `CAND  agy --mode plan → 쓰기차단=${wrote ? "아니오" : "예"} 읽기동작=${readWorked ? "예" : "아니오"}`
        + ` 쓰기시도=${triedToWrite ? "예" : "아니오"} 도구=${[...new Set(attempted)].join(",") || "없음"} exit=${code}`,
      );
      console.log(
        wrote
          ? "        → plan 모드는 변경을 막지 못합니다. read 권한에 쓰면 안 됩니다."
          : readWorked
            ? "        → read 권한을 이 벡터로 살릴 수 있습니다(경계 유지 + 읽기 도구 동작)."
            : "        → 쓰기는 막혔지만 읽기도 동작하지 않았습니다. 지금 상태와 다를 게 없습니다.",
      );
      const tail = (err || "").trim().split("\n").filter(Boolean).slice(-2).join(" | ").slice(0, 300);
      if (tail) console.log(`        runtime says: ${tail}`);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  }
}

if (!live) {
  console.log("\n벡터만 출력했습니다. 실제 동작까지 재려면 --live 를 붙이세요(모델 호출 비용이 듭니다).");
  process.exit(0);
}

console.log(`\nprobe summary: drift=${drift} skipped=${skipped} checked=${results.length}`);
if (check && drift > 0) process.exit(1);
