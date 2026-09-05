import { dialog, type BrowserWindow, type MenuItemConstructorOptions } from "electron";
import type { RuntimeBackend } from "../../shared/types";

const pending = new Map<string, Promise<void>>();

type RecoveryMessage = { ok: boolean; message: string };

/** The native menu click owns this attempt. Building the menu performs no
 * credential discovery, native storage call, or automatic retry.
 */
function runRecovery(
  resource: string,
  parent: BrowserWindow | null,
  korean: boolean,
  attempt: () => Promise<RecoveryMessage>,
): Promise<void> {
  const current = pending.get(resource);
  if (current) return current;
  const started = Promise.resolve().then(async () => {
    let result: RecoveryMessage;
    try { result = await attempt(); }
    catch {
      result = {
        ok: false,
        message: korean ? "아직 저장소에 접근할 수 없습니다. 자동으로 다시 시도하지 않습니다."
          : "Storage access is still unavailable. No automatic retry will run.",
      };
    }
    const options: Electron.MessageBoxOptions = {
      type: result.ok ? "info" : "warning",
      title: korean ? "저장된 로그인과 API 키" : "Saved login and API keys",
      message: result.message,
    };
    if (parent && !parent.isDestroyed()) await dialog.showMessageBox(parent, options);
    else await dialog.showMessageBox(options);
  });
  pending.set(resource, started);
  void started.then(() => { if (pending.get(resource) === started) pending.delete(resource); },
    () => { if (pending.get(resource) === started) pending.delete(resource); });
  return started;
}

export function credentialRecoveryMenuItems(
  getWindow: () => BrowserWindow | null,
  locale: "ko" | "en",
): MenuItemConstructorOptions[] {
  const korean = locale === "ko";
  const providers: Array<[RuntimeBackend, string]> = [
    ["anthropic", "Anthropic"], ["openai", "OpenAI"], ["google", "Google Gemini"],
    ["glm", "GLM"], ["kimi", "Kimi"], ["deepseek", "DeepSeek"],
    ["minimax", "MiniMax"], ["xai", "xAI"], ["openrouter", "OpenRouter"],
    ["upstage", "Upstage"], ["custom", korean ? "사용자 지정" : "Custom"],
  ];
  return [
    {
      label: korean ? "저장된 로그인 복원…" : "Restore Saved Login…",
      click: () => {
        void runRecovery("auth:saved-session", getWindow(), korean, async () => {
          const { retryAuthRestoreFromUser } = await import("../auth");
          const result = await retryAuthRestoreFromUser();
          const ok = result.status === "restored";
          const missing = ["missing", "expired", "invalid"].includes(result.status);
          return {
            ok,
            message: ok
              ? korean ? "저장된 로그인을 복원했습니다." : "Your saved login was restored."
              : missing
                ? korean ? "복원할 수 있는 저장된 로그인이 없습니다." : "No restorable saved login was found."
                : korean ? "저장된 로그인에 아직 접근할 수 없습니다. 자동으로 다시 시도하지 않습니다."
                  : "Your saved login is still unavailable. No automatic retry will run.",
          };
        }).catch(() => { /* A closed window must not start another attempt. */ });
      },
    },
    {
      label: korean ? "API 키 접근 다시 시도" : "Retry API Key Access",
      submenu: providers.map(([backend, label]) => ({
        label,
        click: () => {
          void runRecovery(`api:${backend}`, getWindow(), korean, async () => {
            const { retryCredentialReadFromUser, hasApiKey } = await import("./vault");
            await retryCredentialReadFromUser("api", backend);
            const present = await hasApiKey(backend);
            return {
              ok: present,
              message: present
                ? korean ? `${label} API 키를 다시 읽었습니다.` : `${label} API key access was restored.`
                : korean ? `저장된 ${label} API 키가 없습니다.` : `No saved ${label} API key was found.`,
            };
          }).catch(() => { /* A closed window must not start another attempt. */ });
        },
      })),
    },
  ];
}
