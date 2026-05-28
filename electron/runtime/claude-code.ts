// Claude Code CLI — 감지 + 실호출.
// 사용자의 Claude Pro/Max 구독으로 돌아간다 (PRD §3.1 6-A).
//
// 호출 형식: claude -p "<user prompt>" --append-system-prompt "<system>"
// 이전 메시지 컨텍스트는 V0에서는 system prompt에 inline. M1에서 --resume 옵션 활용 검토.
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import os from "node:os";
import fs from "node:fs/promises";
import type { Runner, RunnerRequest, RunnerEvents, RunnerResult } from "./runner";
import { wrapSystemPrompt } from "./runner";
import { tStatus } from "./status-i18n";

const execFileP = promisify(execFile);

const CANDIDATES = [
  "claude",
  path.join(os.homedir(), ".claude/local/claude"),
  "/opt/homebrew/bin/claude",
  "/usr/local/bin/claude",
];

async function firstExisting(paths: string[]): Promise<string | null> {
  for (const p of paths) {
    if (p === "claude") {
      try {
        await execFileP("claude", ["--version"], { timeout: 2000 });
        return "claude";
      } catch {
        continue;
      }
    }
    try {
      await fs.access(p);
      return p;
    } catch {
      continue;
    }
  }
  return null;
}

export interface ClaudeCodeProbe {
  path: string;
  version: string;
}

export async function probeClaudeCode(): Promise<ClaudeCodeProbe | null> {
  const found = await firstExisting(CANDIDATES);
  if (!found) return null;
  try {
    const { stdout } = await execFileP(found, ["--version"], { timeout: 3000 });
    const version = stdout.trim().split(/\s+/).pop() ?? "unknown";
    return { path: found, version };
  } catch {
    return { path: found, version: "unknown" };
  }
}

let cachedBin: string | null | undefined;
async function getBin(): Promise<string | null> {
  if (cachedBin !== undefined) return cachedBin;
  const probe = await probeClaudeCode();
  cachedBin = probe?.path ?? null;
  return cachedBin;
}

function flattenHistory(req: RunnerRequest): string {
  // CLI는 단일 turn — 이전 대화를 user 메시지에 inline으로 prepend.
  if (req.history.length === 0) return req.userPrompt;
  const user = tStatus(req.locale, "speakerUser");
  const assistant = tStatus(req.locale, "speakerAssistant");
  const lines: string[] = [tStatus(req.locale, "histPrev")];
  for (const m of req.history) {
    if (m.role === "user") lines.push(`${user}: ${m.text}`);
    else if (m.role === "assistant") lines.push(`${assistant}: ${m.text}`);
  }
  lines.push(tStatus(req.locale, "histThis"), req.userPrompt);
  return lines.join("\n\n");
}

export const runClaudeCode: Runner = async (
  req: RunnerRequest,
  events: RunnerEvents,
): Promise<RunnerResult> => {
  const bin = await getBin();
  if (!bin) {
    throw new Error(tStatus(req.locale, "errCliMissingClaude"));
  }

  if (req.images && req.images.length > 0) {
    events.onStatus(
      tStatus(req.locale, "cliNoImageClaude", { backend: req.backendLabel }),
    );
  } else {
    events.onStatus(tStatus(req.locale, "callingBackend", { backend: req.backendLabel }));
  }

  const systemPrompt = wrapSystemPrompt(req.systemPrompt, req.locale);
  const flatUser = flattenHistory(req);

  return new Promise<RunnerResult>((resolve, reject) => {
    const args = ["-p", flatUser, "--append-system-prompt", systemPrompt];
    const child = spawn(bin, args, {
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env,
    });

    let stdout = "";
    let stderr = "";
    let lastEmit = 0;

    child.stdout.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      stdout += text;
      const now = Date.now();
      // 너무 잦은 IPC 푸시 방지 — 80ms throttle
      if (now - lastEmit > 80) {
        events.onPartial(stdout);
        lastEmit = now;
      }
    });

    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });

    child.on("error", (err) => reject(err));
    child.on("close", (code) => {
      if (code === 0) {
        resolve({ text: stdout.trim() });
      } else {
        reject(
          new Error(
            `claude CLI exit ${code}${stderr ? `\n${stderr.slice(0, 500)}` : ""}`,
          ),
        );
      }
    });
  });
};
