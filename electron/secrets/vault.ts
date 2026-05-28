// macOS Keychain (keytar) wrapper.
// PRD 6.2 보안 모델 — 모든 비밀은 메인 프로세스만 접근, renderer는 has* boolean만 묻는다.
//
// 두 종류의 비밀:
//   1) BYOK LLM API 키       — account "byok:<backend>"  (Anthropic/OpenAI/Google)
//   2) 글로벌 env (외부 API)  — account "env:<KEY_NAME>" (NOTION_API_KEY, SLACK_TOKEN 등)
//
// 두 namespace 모두 같은 SERVICE 안에 있지만 prefix로 구분.
import keytar from "keytar";
import type { RuntimeBackend } from "../../shared/types";

const SERVICE = "com.agentlas.desktop";
const BYOK_PREFIX = "byok:";
const ENV_PREFIX = "env:";

// ── BYOK LLM API ────────────────────────────────────────────
function byokAccount(backend: RuntimeBackend): string {
  return `${BYOK_PREFIX}${backend}`;
}

export async function saveApiKey(backend: RuntimeBackend, key: string): Promise<void> {
  const trimmed = key.trim();
  if (!trimmed) {
    await keytar.deletePassword(SERVICE, byokAccount(backend));
    return;
  }
  await keytar.setPassword(SERVICE, byokAccount(backend), trimmed);
}

export async function hasApiKey(backend: RuntimeBackend): Promise<boolean> {
  const v = await keytar.getPassword(SERVICE, byokAccount(backend));
  return typeof v === "string" && v.length > 0;
}

export async function deleteApiKey(backend: RuntimeBackend): Promise<void> {
  await keytar.deletePassword(SERVICE, byokAccount(backend));
}

/** main 내부 사용 — MCP 호출 시 자식 env에 주입. renderer 노출 X */
export async function readApiKey(backend: RuntimeBackend): Promise<string | null> {
  return keytar.getPassword(SERVICE, byokAccount(backend));
}

// ── 글로벌 env (외부 통합 API 키) ───────────────────────────
function envAccount(key: string): string {
  return `${ENV_PREFIX}${key}`;
}

export async function setEnvVar(key: string, value: string): Promise<void> {
  const trimmedKey = key.trim();
  if (!trimmedKey) throw new Error("env key cannot be empty");
  const trimmedValue = value.trim();
  if (!trimmedValue) {
    await keytar.deletePassword(SERVICE, envAccount(trimmedKey));
    return;
  }
  await keytar.setPassword(SERVICE, envAccount(trimmedKey), trimmedValue);
}

export async function hasEnvVar(key: string): Promise<boolean> {
  const v = await keytar.getPassword(SERVICE, envAccount(key));
  return typeof v === "string" && v.length > 0;
}

export async function deleteEnvVar(key: string): Promise<void> {
  await keytar.deletePassword(SERVICE, envAccount(key));
}

/** main 내부 — MCP 서버 spawn 시 envRequirements 매칭해 자식 env로 주입 (M1) */
export async function readEnvVar(key: string): Promise<string | null> {
  return keytar.getPassword(SERVICE, envAccount(key));
}

/** keychain에 저장된 env 키 전체 — keytar.findCredentials로 prefix filter */
export async function listEnvKeys(): Promise<string[]> {
  const creds = await keytar.findCredentials(SERVICE);
  return creds
    .map((c) => c.account)
    .filter((a) => a.startsWith(ENV_PREFIX))
    .map((a) => a.slice(ENV_PREFIX.length));
}
