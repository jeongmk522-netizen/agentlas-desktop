// CLI 자동 감지 통합 + 활성 백엔드 선택 상태 관리.
// PRD 3.1 FRE 6단계 — 사용자가 입력 안 해도 한 번 클릭으로 연결되도록.
import { probeClaudeCode } from "./claude-code";
import { probeCodex } from "./codex";
import { probeGemini } from "./gemini";
import { probeOllama } from "./ollama";
import { hasApiKey } from "../secrets/vault";
import { getDb } from "../store/db";
import type {
  RuntimeBackend,
  RuntimeKind,
  RuntimeSelection,
  RuntimeStatus,
} from "../../shared/types";

type ActiveRuntimeRow = {
  kind: RuntimeKind;
  backend: RuntimeBackend | null;
  source: string | null;
  model: string | null;
};

function isActiveRuntime(status: RuntimeStatus, active: ActiveRuntimeRow | null): boolean {
  if (!active) return false;
  // ollama는 단일 런타임 — kind만 맞으면 활성. 모델은 status.model로 따로 반영.
  if (status.kind === "ollama") return active.kind === "ollama";
  if (active.source) {
    return (
      status.kind === active.kind &&
      status.backend === active.backend &&
      status.source === active.source
    );
  }
  if (active.backend) {
    return status.kind === active.kind && status.backend === active.backend;
  }
  return status.kind === active.kind;
}

function saveActiveRuntime(status: RuntimeStatus | RuntimeSelection): void {
  getDb()
    .prepare(
      "INSERT OR REPLACE INTO active_runtime(id, kind, backend, source, model) VALUES (1, ?, ?, ?, ?)",
    )
    .run(status.kind, status.backend ?? null, status.source ?? null, status.model ?? null);
}

/**
 * 모든 런타임을 병렬로 감지. 메인 프로세스에서만 호출.
 * - 로컬 CLI 3종 + BYOK API 키 3종 = 최대 6개 후보 반환
 */
export async function detectRuntimes(): Promise<RuntimeStatus[]> {
  const db = getDb();
  const activeRow = db
    .prepare("SELECT kind, backend, source, model FROM active_runtime WHERE id = 1")
    .get() as ActiveRuntimeRow | undefined;
  const active = activeRow ?? null;

  const [cc, cx, gm, ollama, anthropicByok, openaiByok, googleByok] = await Promise.all([
    probeClaudeCode(),
    probeCodex(),
    probeGemini(),
    probeOllama(),
    hasApiKey("anthropic"),
    hasApiKey("openai"),
    hasApiKey("google"),
  ]);

  const list: RuntimeStatus[] = [];

  if (cc) {
    list.push({
      kind: "claude-code",
      backend: "anthropic",
      source: cc.path,
      version: cc.version,
      active: false,
    });
  }
  if (cx) {
    list.push({
      kind: "codex",
      backend: "openai",
      source: cx.path,
      version: cx.version,
      active: false,
    });
  }
  if (gm) {
    list.push({
      kind: "gemini",
      backend: "google",
      source: gm.path,
      version: gm.version,
      active: false,
    });
  }
  if (ollama) {
    // 활성 모델: 이전에 고른 모델이 아직 존재하면 그대로, 아니면 첫 모델로 폴백.
    const preferred =
      active?.kind === "ollama" && active.model && ollama.models.includes(active.model)
        ? active.model
        : ollama.models[0] ?? null;
    list.push({
      kind: "ollama",
      backend: "ollama",
      source: "ollama",
      version: ollama.version,
      active: false,
      model: preferred,
      availableModels: ollama.models,
    });
  }
  if (anthropicByok) {
    list.push({
      kind: "byok",
      backend: "anthropic",
      source: "byok:anthropic",
      version: null,
      active: false,
    });
  }
  if (openaiByok) {
    list.push({
      kind: "byok",
      backend: "openai",
      source: "byok:openai",
      version: null,
      active: false,
    });
  }
  if (googleByok) {
    list.push({
      kind: "byok",
      backend: "google",
      source: "byok:google",
      version: null,
      active: false,
    });
  }

  let activeAssigned = false;
  for (const runtime of list) {
    const matchesActive = isActiveRuntime(runtime, active);
    runtime.active = matchesActive && !activeAssigned;
    if (runtime.active) activeAssigned = true;
  }

  // 활성 백엔드 없으면 첫 후보를 자동 활성 — FRE 마찰 0
  if (!list.some((runtime) => runtime.active) && list.length > 0) {
    list[0].active = true;
    saveActiveRuntime(list[0]);
  }

  return list;
}

export async function setActiveRuntime(selection: RuntimeSelection): Promise<RuntimeStatus[]> {
  saveActiveRuntime(selection);
  return detectRuntimes();
}
