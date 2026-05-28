// CLI 설치 + 웹 로그인 헬퍼 (요청 ⑤).
//
// CLI가 없는 사용자를 위해: 미리 저장된 고정 명령만 실행한다(사용자 입력 X → 인젝션 불가).
//   1) installCli(kind)   — `npm i -g <고정 패키지>` 실행 (헤드리스)
//   2) openCliLogin(kind) — 시스템 터미널을 열어 CLI 자체 로그인 실행 → 브라우저 OAuth
//      (사용자는 "웹 로그인"만 하면 됨)
//   3) 이후 detectRuntimes()가 자동 인식
import { spawn } from "node:child_process";
import { spawnCli } from "./exec";

export type InstallableCli = "claude-code" | "codex" | "gemini";

/** 고정 명령 화이트리스트 — 절대 사용자 입력을 끼우지 않는다. */
const CLI_PLAN: Record<InstallableCli, { pkg: string; loginCmd: string }> = {
  "claude-code": { pkg: "@anthropic-ai/claude-code", loginCmd: "claude" },
  codex: { pkg: "@openai/codex", loginCmd: "codex login" },
  gemini: { pkg: "@google/gemini-cli", loginCmd: "gemini" },
};

export interface CliActionResult {
  ok: boolean;
  message: string;
  /** 실패 시 사용자가 직접 칠 수 있는 명령 */
  command?: string;
}

/** `npm i -g <pkg>` 실행. node/npm이 없거나 권한 문제면 ok:false + 직접 실행할 명령 안내. */
export function installCli(kind: InstallableCli): Promise<CliActionResult> {
  const plan = CLI_PLAN[kind];
  if (!plan) return Promise.resolve({ ok: false, message: `Unknown CLI: ${kind}` });
  const command = `npm install -g ${plan.pkg}`;

  return new Promise<CliActionResult>((resolve) => {
    let settled = false;
    const done = (r: CliActionResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(r);
    };

    let out = "";
    let err = "";
    let child: ReturnType<typeof spawnCli>;
    try {
      child = spawnCli("npm", ["install", "-g", plan.pkg], {
        stdio: ["ignore", "pipe", "pipe"],
        env: process.env,
      });
    } catch (e) {
      done({ ok: false, message: e instanceof Error ? e.message : String(e), command });
      return;
    }

    // npm cold install은 1~2분 — 5분 상한.
    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        // ignore
      }
      done({ ok: false, message: "timed out after 5 min", command });
    }, 5 * 60 * 1000);

    child.stdout?.on("data", (c: Buffer) => (out += c.toString("utf8")));
    child.stderr?.on("data", (c: Buffer) => (err += c.toString("utf8")));
    child.on("error", (e) =>
      done({ ok: false, message: e.message, command }),
    );
    child.on("close", (code) => {
      if (code === 0) done({ ok: true, message: out.slice(-400).trim() || "installed" });
      else done({ ok: false, message: (err || out).slice(-800).trim(), command });
    });
  });
}

/**
 * 시스템 터미널에서 CLI 로그인 명령을 연다 — 사용자는 거기서 브라우저 로그인만 하면 된다.
 * loginCmd는 고정값이라 셸 인젝션 위험 없음.
 */
export function openCliLogin(kind: InstallableCli): CliActionResult {
  const plan = CLI_PLAN[kind];
  if (!plan) return { ok: false, message: `Unknown CLI: ${kind}` };
  const cmd = plan.loginCmd;
  try {
    if (process.platform === "darwin") {
      // Terminal.app에서 실행 + 활성화. cmd는 상수.
      spawn("osascript", [
        "-e",
        `tell application "Terminal" to do script "${cmd}"`,
        "-e",
        `tell application "Terminal" to activate`,
      ]);
    } else if (process.platform === "win32") {
      // 새 cmd 창에서 실행 후 유지(/k).
      spawn("cmd", ["/c", "start", "cmd", "/k", cmd], { shell: true });
    } else {
      // Linux best-effort — 대표 터미널 에뮬레이터.
      spawn("x-terminal-emulator", ["-e", cmd]);
    }
    return { ok: true, message: cmd };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : String(e), command: cmd };
  }
}
