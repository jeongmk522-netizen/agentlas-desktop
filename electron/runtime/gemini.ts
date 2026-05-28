// Gemini CLI — 감지 + 실호출.
// 사용자의 Google AI Pro 구독 또는 free tier로 돌아간다.
//
// 호출 형식: gemini --prompt "<text>"  (Gemini CLI의 비대화형 모드)
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import os from "node:os";
import fs from "node:fs/promises";
import type { Runner, RunnerEvents, RunnerRequest, RunnerResult } from "./runner";
import { wrapSystemPrompt } from "./runner";
import { tStatus } from "./status-i18n";

const execFileP = promisify(execFile);

const CANDIDATES = [
  "gemini",
  path.join(os.homedir(), ".gemini/bin/gemini"),
  "/opt/homebrew/bin/gemini",
  "/usr/local/bin/gemini",
];

async function firstExisting(paths: string[]): Promise<string | null> {
  for (const p of paths) {
    if (p === "gemini") {
      try {
        await execFileP("gemini", ["--version"], { timeout: 2000 });
        return "gemini";
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

export interface GeminiProbe {
  path: string;
  version: string;
}

export async function probeGemini(): Promise<GeminiProbe | null> {
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
  const probe = await probeGemini();
  cachedBin = probe?.path ?? null;
  return cachedBin;
}

function buildPrompt(req: RunnerRequest): string {
  const sys = wrapSystemPrompt(req.systemPrompt, req.locale);
  const user = tStatus(req.locale, "speakerUser");
  const assistant = tStatus(req.locale, "speakerAssistant");
  const parts: string[] = [`[SYSTEM]\n${sys}`, ""];
  if (req.history.length > 0) {
    parts.push(tStatus(req.locale, "histPrevSection"));
    for (const m of req.history) {
      const tag = m.role === "user" ? user : assistant;
      parts.push(`${tag}: ${m.text}`);
    }
    parts.push("");
  }
  parts.push(tStatus(req.locale, "histThisSection"), req.userPrompt);
  return parts.join("\n");
}

export const runGemini: Runner = async (
  req: RunnerRequest,
  events: RunnerEvents,
): Promise<RunnerResult> => {
  const bin = await getBin();
  if (!bin) {
    throw new Error(tStatus(req.locale, "errCliMissingGemini"));
  }

  if (req.images && req.images.length > 0) {
    events.onStatus(tStatus(req.locale, "cliNoImage", { backend: req.backendLabel }));
  } else {
    events.onStatus(tStatus(req.locale, "callingBackend", { backend: req.backendLabel }));
  }

  const prompt = buildPrompt(req);

  return new Promise<RunnerResult>((resolve, reject) => {
    // Gemini CLI 비대화형 모드 — --prompt 플래그.
    const child = spawn(bin, ["--prompt", prompt], {
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
            `gemini CLI exit ${code}${stderr ? `\n${stderr.slice(0, 500)}` : ""}`,
          ),
        );
      }
    });
  });
};
