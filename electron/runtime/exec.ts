// 크로스플랫폼 CLI 실행 헬퍼.
//
// Windows에서 npm 전역 CLI(claude/codex/gemini)는 `claude.cmd` 같은 셸 심으로
// 설치된다. Node의 child_process.spawn/execFile은 `shell:true` 없이는 `.cmd`/`.bat`
// 를 실행하지 못해(ENOENT), 감지와 실행이 모두 실패했다. cross-spawn은 PATH+PATHEXT로
// 심을 찾아주고 인자를 cmd.exe에 안전하게 전달한다(수동 셸 인용 없이).
import crossSpawn from "cross-spawn";
import fs from "node:fs";
import path from "node:path";
import { app } from "electron";
import type { ChildProcess, SpawnOptions } from "node:child_process";

/** child_process.spawn 대체 — Windows `.cmd`/`.bat` 심을 해석한다. */
export function spawnCli(
  command: string,
  args: string[],
  options: SpawnOptions,
): ChildProcess {
  return crossSpawn(command, args, options);
}

/**
 * CLI 러너가 실행될 안전한 작업 디렉터리.
 * 패키지된 앱은 cwd가 `/`(또는 앱 번들)이라 Claude는 권한 오류, Codex는
 * "not inside a trusted directory"로 실패한다. userData 아래 쓰기 가능한
 * 전용 폴더를 만들어 cwd로 사용한다.
 */
let _runCwd: string | null = null;
export function agentRunCwd(): string {
  if (_runCwd) return _runCwd;
  const dir = path.join(app.getPath("userData"), "agent-cwd");
  try {
    fs.mkdirSync(dir, { recursive: true });
    _runCwd = dir;
  } catch {
    _runCwd = app.getPath("home");
  }
  return _runCwd;
}

/**
 * `<command> --version` 베스트에포트 실행. CLI가 PATH(또는 절대경로)에 있고
 * 실행 가능하면 버전 문자열을, 아니면 null을 반환한다. Windows 심도 해석된다.
 */
export function probeCliVersion(command: string, timeoutMs = 3000): Promise<string | null> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (v: string | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(v);
    };

    const child = crossSpawn(command, ["--version"], {
      stdio: ["ignore", "pipe", "pipe"],
    });

    const timer = setTimeout(() => {
      child.kill();
      finish(null);
    }, timeoutMs);

    let out = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      out += chunk.toString("utf8");
    });
    child.on("error", () => finish(null));
    child.on("close", (code) => {
      if (code === 0) {
        finish(out.trim().split(/\s+/).pop() ?? "unknown");
      } else {
        finish(null);
      }
    });
  });
}
