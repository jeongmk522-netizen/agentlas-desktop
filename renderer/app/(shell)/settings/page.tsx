// 설정 — BYOC 연결 관리. PRD 3.1 FRE 6단계 + 10번 리스크 "키 저장 위치 명시".
"use client";
import { useCallback, useEffect, useState } from "react";
import { ipc, updaterEvents } from "@/lib/ipc";
import { useT, type LocalePref } from "@/lib/i18n";
import type { RuntimeBackend, RuntimeStatus, UpdaterState } from "@/lib/types";
import { IconCheck, IconLock, IconRefresh } from "@/components/Icon";
import { MigrationPanel } from "@/components/MigrationPanel";

// BYOK는 API 키를 직접 넣는 클라우드 3종 (Ollama는 로컬이라 키 없음).
type ByokBackend = "anthropic" | "openai" | "google";
const BYOK_BACKENDS: ByokBackend[] = ["anthropic", "openai", "google"];

const BACKEND_LABEL: Record<RuntimeBackend, string> = {
  anthropic: "Anthropic (Claude)",
  openai: "OpenAI (ChatGPT)",
  google: "Google (Gemini)",
  ollama: "Ollama (로컬)",
};

const BACKEND_KEY_HINT: Record<ByokBackend, string> = {
  anthropic: "console.anthropic.com → API Keys",
  openai: "platform.openai.com/api-keys",
  google: "aistudio.google.com/app/apikey",
};

const RUNTIME_LABEL: Record<string, string> = {
  "claude-code": "Claude Code CLI",
  codex: "Codex CLI",
  gemini: "Gemini CLI",
  ollama: "Ollama",
};

export default function SettingsPage() {
  const { t, pref, setPref } = useT();
  const [statuses, setStatuses] = useState<RuntimeStatus[]>([]);
  const [draftKey, setDraftKey] = useState<Record<ByokBackend, string>>({
    anthropic: "",
    openai: "",
    google: "",
  });
  const [hasKey, setHasKey] = useState<Record<ByokBackend, boolean>>({
    anthropic: false,
    openai: false,
    google: false,
  });

  const refresh = useCallback(async () => {
    const api = ipc();
    if (!api) return;
    const [s, a, o, g] = await Promise.all([
      api.runtime.detect(),
      api.secrets.hasApiKey("anthropic"),
      api.secrets.hasApiKey("openai"),
      api.secrets.hasApiKey("google"),
    ]);
    setStatuses(s);
    setHasKey({ anthropic: a, openai: o, google: g });
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function activateRuntime(runtime: RuntimeStatus) {
    const api = ipc();
    if (!api) return;
    const updated = await api.runtime.setActive({
      kind: runtime.kind,
      backend: runtime.backend,
      source: runtime.source,
      model: runtime.model ?? undefined,
    });
    setStatuses(updated);
  }

  // Ollama 모델 선택 — 같은 ollama 런타임을 model만 바꿔 활성화.
  async function activateOllamaModel(model: string) {
    const api = ipc();
    if (!api) return;
    const updated = await api.runtime.setActive({
      kind: "ollama",
      backend: "ollama",
      source: "ollama",
      model,
    });
    setStatuses(updated);
  }

  async function saveKey(backend: ByokBackend) {
    const api = ipc();
    if (!api) return;
    await api.secrets.saveApiKey(backend, draftKey[backend]);
    setDraftKey((d) => ({ ...d, [backend]: "" }));
    await refresh();
  }

  async function clearKey(backend: ByokBackend) {
    const api = ipc();
    if (!api) return;
    await api.secrets.deleteApiKey(backend);
    await refresh();
  }

  const ollama = statuses.find((s) => s.kind === "ollama") ?? null;

  return (
    <div style={{ flex: 1, background: "var(--paper-2)", overflowY: "auto" }}>
      <header
        className="titlebar-drag"
        style={{
          padding: "16px 32px",
          borderBottom: "var(--hairline)",
          background: "var(--paper)",
          display: "flex",
          alignItems: "center",
          gap: 16,
          minHeight: 56,
        }}
      >
        <h1 style={{ margin: 0, fontFamily: "var(--font-head)", fontSize: 17, fontWeight: 700 }}>
          {t("settings.title")}
        </h1>
      </header>

      <section
        className="titlebar-nodrag"
        style={{ maxWidth: 760, margin: "0 auto", padding: 32 }}
      >
        <Banner />
        <UpdatePanel />

        {/* 언어 선택 */}
        <h2 style={{ fontFamily: "var(--font-head)", fontSize: 15, margin: "24px 0 12px" }}>
          {t("settings.lang.title")}
        </h2>
        <div
          className="glass-strong"
          style={{
            padding: 12,
            borderRadius: "var(--radius-md)",
            display: "flex",
            gap: 6,
          }}
        >
          {(["system", "ko", "en"] as LocalePref[]).map((p) => {
            const active = pref === p;
            return (
              <button
                key={p}
                onClick={() => setPref(p)}
                style={{
                  flex: 1,
                  padding: "8px 12px",
                  borderRadius: "var(--radius-md)",
                  fontSize: 12.5,
                  fontWeight: 600,
                  background: active ? "var(--ink)" : "transparent",
                  color: active ? "white" : "var(--ink-soft)",
                  border: active ? "1px solid var(--ink)" : "1px solid transparent",
                }}
              >
                {p === "system"
                  ? t("settings.lang.system")
                  : p === "ko"
                  ? t("settings.lang.ko")
                  : t("settings.lang.en")}
              </button>
            );
          })}
        </div>

        <h2 style={{ fontFamily: "var(--font-head)", fontSize: 15, margin: "24px 0 12px" }}>
          {t("settings.detected")}
        </h2>
        {statuses.length === 0 && (
          <div
            style={{
              padding: 12,
              border: "1px dashed var(--paper-edge)",
              borderRadius: "var(--radius-md)",
              color: "var(--muted-deep)",
              fontSize: 13,
            }}
          >
            {t("settings.no_backends")}
          </div>
        )}
        <ul style={{ listStyle: "none", padding: 0, margin: 0, display: "flex", flexDirection: "column", gap: 8 }}>
          {statuses.map((s) => (
            <li
              key={`${s.kind}-${s.backend}`}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 12,
                padding: "10px 14px",
                background: "var(--paper)",
                border: "1px solid var(--paper-edge)",
                borderRadius: "var(--radius-md)",
              }}
            >
              <span
                style={{
                  width: 10,
                  height: 10,
                  borderRadius: "50%",
                  background: s.active ? "var(--green-deep)" : "var(--paper-edge)",
                }}
              />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontWeight: 600, fontSize: 13 }}>
                  {(s.kind === "byok" ? t("settings.runtime.byok") : RUNTIME_LABEL[s.kind] ?? s.kind)} · {BACKEND_LABEL[s.backend]}
                </div>
                <div style={{ fontSize: 11, color: "var(--muted-deep)" }}>
                  {s.source}
                  {s.version && ` · v${s.version}`}
                </div>
              </div>
              {!s.active && (
                <button
                  onClick={() => void activateRuntime(s)}
                  style={{
                    fontSize: 12,
                    color: "var(--accent)",
                    fontWeight: 600,
                  }}
                >
                  {t("settings.active")}
                </button>
              )}
              {s.active && (
                <span style={{ fontSize: 11, color: "var(--green-deep)", fontWeight: 600 }}>
                  {t("settings.activated")}
                </span>
              )}
            </li>
          ))}
        </ul>

        {/* CLI 도구 설치 (미설치 사용자용) */}
        <CliInstallPanel statuses={statuses} onChanged={refresh} />

        {/* 로컬 모델 (Ollama) */}
        <h2 style={{ fontFamily: "var(--font-head)", fontSize: 15, margin: "32px 0 12px" }}>
          {t("settings.ollama.title")}
        </h2>
        <p style={{ fontSize: 12, color: "var(--muted-deep)", margin: "0 0 12px" }}>
          {t("settings.ollama.note")}
        </p>
        {!ollama ? (
          <div
            style={{
              padding: 14,
              border: "1px dashed var(--paper-edge)",
              borderRadius: "var(--radius-md)",
              color: "var(--muted-deep)",
              fontSize: 12.5,
              lineHeight: 1.6,
            }}
          >
            {t("settings.ollama.unreachable")}
          </div>
        ) : (ollama.availableModels ?? []).length === 0 ? (
          <div
            style={{
              padding: 14,
              border: "1px dashed var(--paper-edge)",
              borderRadius: "var(--radius-md)",
              color: "var(--muted-deep)",
              fontSize: 12.5,
              lineHeight: 1.6,
            }}
          >
            {t("settings.ollama.no_models")}
          </div>
        ) : (
          <div
            style={{
              padding: 14,
              border: "1px solid var(--paper-edge)",
              borderRadius: "var(--radius-md)",
              background: "var(--paper)",
            }}
          >
            <div style={{ fontSize: 11, color: "var(--muted-deep)", marginBottom: 8 }}>
              {t("settings.ollama.model_label")}
              {ollama.version && ` · Ollama v${ollama.version}`}
            </div>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
              {(ollama.availableModels ?? []).map((m) => {
                const isCurrent = ollama.active && ollama.model === m;
                return (
                  <button
                    key={m}
                    onClick={() => void activateOllamaModel(m)}
                    style={{
                      padding: "6px 12px",
                      borderRadius: 999,
                      fontSize: 12,
                      fontFamily: "var(--font-mono)",
                      fontWeight: isCurrent ? 700 : 500,
                      background: isCurrent ? "var(--ink)" : "var(--paper-2)",
                      color: isCurrent ? "white" : "var(--ink-soft)",
                      border: isCurrent ? "1px solid var(--ink)" : "1px solid var(--paper-edge)",
                      display: "inline-flex",
                      alignItems: "center",
                      gap: 6,
                    }}
                  >
                    {m}
                    {isCurrent && (
                      <span style={{ fontSize: 10, fontFamily: "var(--font-head)" }}>
                        · {t("settings.ollama.using")}
                      </span>
                    )}
                  </button>
                );
              })}
            </div>
          </div>
        )}

        <h2 style={{ fontFamily: "var(--font-head)", fontSize: 15, margin: "32px 0 12px" }}>
          {t("settings.byok")}
        </h2>
        <p style={{ fontSize: 12, color: "var(--muted-deep)", margin: "0 0 12px" }}>
          {t("settings.byok.note")}
        </p>
        {BYOK_BACKENDS.map((b) => (
          <div
            key={b}
            style={{
              padding: 14,
              marginBottom: 12,
              border: "1px solid var(--paper-edge)",
              borderRadius: "var(--radius-md)",
              background: "var(--paper)",
              display: "flex",
              flexDirection: "column",
              gap: 8,
            }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <strong style={{ fontSize: 13 }}>{BACKEND_LABEL[b]}</strong>
              {hasKey[b] && (
                <span
                  style={{
                    fontSize: 10,
                    color: "var(--green-deep)",
                    background: "rgba(168,217,155,0.20)",
                    padding: "2px 8px",
                    borderRadius: 999,
                  }}
                >
                  {t("settings.saved")}
                </span>
              )}
            </div>
            <div style={{ display: "flex", gap: 8 }}>
              <input
                type="password"
                value={draftKey[b]}
                onChange={(e) => setDraftKey((d) => ({ ...d, [b]: e.target.value }))}
                placeholder={`sk-...  (${BACKEND_KEY_HINT[b]})`}
                style={{
                  flex: 1,
                  padding: "8px 12px",
                  border: "1px solid var(--paper-edge)",
                  borderRadius: "var(--radius-md)",
                  background: "var(--paper-2)",
                  fontFamily: "var(--font-mono)",
                  fontSize: 12,
                }}
              />
              <button
                onClick={() => void saveKey(b)}
                disabled={!draftKey[b].trim()}
                style={{
                  padding: "8px 14px",
                  borderRadius: "var(--radius-md)",
                  background: draftKey[b].trim() ? "var(--accent)" : "var(--paper-2)",
                  color: draftKey[b].trim() ? "white" : "var(--muted-deep)",
                  fontWeight: 600,
                  fontSize: 12,
                  border: "none",
                }}
              >
                {t("settings.save")}
              </button>
              {hasKey[b] && (
                <button
                  onClick={() => void clearKey(b)}
                  style={{
                    padding: "8px 14px",
                    borderRadius: "var(--radius-md)",
                    background: "var(--paper)",
                    color: "var(--red-deep)",
                    fontWeight: 600,
                    fontSize: 12,
                    border: "1px solid var(--paper-edge)",
                  }}
                >
                  {t("settings.delete")}
                </button>
              )}
            </div>
          </div>
        ))}

        <MigrationPanel />
      </section>
    </div>
  );
}

function UpdatePanel() {
  const { t } = useT();
  const [version, setVersion] = useState("");
  const [checking, setChecking] = useState(false);
  const [state, setState] = useState<UpdaterState>({ status: "idle" });

  useEffect(() => {
    let cancelled = false;
    const api = ipc();
    if (api) {
      void api.app.getVersion().then((v) => {
        if (!cancelled) setVersion(v);
      });
      void api.updater.getState().then((s) => {
        if (!cancelled) setState(s);
      });
    }
    const off = updaterEvents()?.onState((next) => {
      if (!cancelled) setState(next);
    });
    return () => {
      cancelled = true;
      off?.();
    };
  }, []);

  async function check() {
    const api = ipc();
    if (!api || checking) return;
    setChecking(true);
    try {
      await api.updater.check();
    } finally {
      setTimeout(() => setChecking(false), 900);
    }
  }

  async function install() {
    const api = ipc();
    if (!api) return;
    await api.updater.install();
  }

  const statusText = (() => {
    switch (state.status) {
      case "checking":
        return t("settings.update.checking");
      case "available":
        return t("settings.update.available", { version: state.version ?? "?" });
      case "downloading":
        return t("settings.update.downloading", {
          version: state.version ?? "?",
          pct: state.progress ?? 0,
        });
      case "downloaded":
        return t("settings.update.downloaded", { version: state.version ?? "?" });
      case "not-available":
        return t("settings.update.not_available");
      case "error":
        return t("settings.update.error", { message: state.error ?? "Unknown error" });
      default:
        return t("settings.update.idle");
    }
  })();

  return (
    <>
      <h2 style={{ fontFamily: "var(--font-head)", fontSize: 15, margin: "24px 0 12px" }}>
        {t("settings.update.title")}
      </h2>
      <div
        className="glass-strong"
        style={{
          padding: 14,
          borderRadius: "var(--radius-md)",
          display: "flex",
          alignItems: "center",
          gap: 12,
        }}
      >
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 11, color: "var(--muted-deep)", marginBottom: 4 }}>
            {t("settings.update.current")}
          </div>
          <div style={{ fontFamily: "var(--font-mono)", fontSize: 13, fontWeight: 700 }}>
            v{version || "?"}
          </div>
          <div style={{ fontSize: 12, color: "var(--muted-deep)", marginTop: 6 }}>
            {statusText}
          </div>
        </div>
        {state.status === "downloaded" ? (
          <button
            onClick={() => void install()}
            style={{
              padding: "8px 14px",
              borderRadius: "var(--radius-md)",
              background: "var(--accent)",
              color: "white",
              fontWeight: 700,
              fontSize: 12,
              border: "none",
            }}
          >
            {t("settings.update.install")}
          </button>
        ) : (
          <button
            onClick={() => void check()}
            disabled={checking}
            style={{
              padding: "8px 14px",
              borderRadius: "var(--radius-md)",
              background: checking ? "var(--paper-2)" : "var(--ink)",
              color: checking ? "var(--muted-deep)" : "white",
              fontWeight: 700,
              fontSize: 12,
              border: "none",
            }}
          >
            {checking ? t("settings.update.checking") : t("settings.update.check")}
          </button>
        )}
      </div>
    </>
  );
}

function Banner() {
  const { t } = useT();
  return (
    <div
      className="glass-strong"
      style={{
        padding: "14px 16px",
        borderRadius: "var(--radius-md)",
        fontSize: 12,
        color: "var(--ink-soft)",
        lineHeight: 1.55,
        display: "flex",
        gap: 12,
        alignItems: "flex-start",
      }}
    >
      <span
        style={{
          width: 28,
          height: 28,
          flexShrink: 0,
          borderRadius: 8,
          background: "var(--fill-1)",
          color: "var(--accent)",
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <IconLock size={14} />
      </span>
      <div>{t("settings.banner")}</div>
    </div>
  );
}

// ── CLI 설치 패널 (요청 ⑤) ────────────────────────────────
type CliKind = "claude-code" | "codex" | "gemini";
const CLI_DEFS: Array<{ kind: CliKind; name: string; sub: string }> = [
  { kind: "claude-code", name: "Claude Code", sub: "Claude Pro · Max" },
  { kind: "codex", name: "Codex", sub: "ChatGPT Plus · Pro" },
  { kind: "gemini", name: "Gemini", sub: "Google AI" },
];

function CliInstallPanel({
  statuses,
  onChanged,
}: {
  statuses: RuntimeStatus[];
  onChanged: () => void | Promise<void>;
}) {
  const { t } = useT();
  const [installing, setInstalling] = useState<CliKind | null>(null);
  const [msg, setMsg] = useState<Partial<Record<CliKind, string>>>({});
  const installedKinds = new Set(statuses.map((s) => s.kind));

  async function doInstall(kind: CliKind) {
    const api = ipc();
    if (!api) return;
    setInstalling(kind);
    setMsg((m) => ({ ...m, [kind]: "" }));
    try {
      const r = await api.runtime.installCli(kind);
      if (r.ok) {
        setMsg((m) => ({ ...m, [kind]: t("settings.cli.install_ok") }));
        await onChanged();
      } else {
        setMsg((m) => ({ ...m, [kind]: t("settings.cli.install_failed", { cmd: r.command ?? "" }) }));
      }
    } finally {
      setInstalling(null);
    }
  }

  async function doLogin(kind: CliKind) {
    const api = ipc();
    if (!api) return;
    await api.runtime.openCliLogin(kind);
    setMsg((m) => ({ ...m, [kind]: t("settings.cli.login_hint") }));
  }

  return (
    <>
      <h2 style={{ fontFamily: "var(--font-head)", fontSize: 15, margin: "32px 0 12px" }}>
        {t("settings.cli.title")}
      </h2>
      <p style={{ fontSize: 12, color: "var(--muted-deep)", margin: "0 0 12px", lineHeight: 1.6 }}>
        {t("settings.cli.note")}
      </p>
      {CLI_DEFS.map((def) => {
        const installed = installedKinds.has(def.kind);
        const isInstalling = installing === def.kind;
        return (
          <div
            key={def.kind}
            style={{
              padding: 14,
              marginBottom: 10,
              border: "1px solid var(--paper-edge)",
              borderRadius: "var(--radius-md)",
              background: "var(--paper)",
              display: "flex",
              flexDirection: "column",
              gap: 8,
            }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 13, fontWeight: 600 }}>{def.name}</div>
                <div style={{ fontSize: 11, color: "var(--muted-deep)" }}>{def.sub}</div>
              </div>
              {installed ? (
                <>
                  <span
                    style={{
                      fontSize: 11,
                      fontWeight: 600,
                      color: "var(--green-deep)",
                      background: "rgba(168,217,155,0.20)",
                      padding: "3px 10px",
                      borderRadius: 999,
                      display: "inline-flex",
                      alignItems: "center",
                      gap: 4,
                    }}
                  >
                    <IconCheck size={12} />
                    {t("settings.cli.installed")}
                  </span>
                  {/* 설치돼 있어도 아직 로그인 안 했을 수 있으므로 웹 로그인 버튼 유지 */}
                  <button
                    onClick={() => void doLogin(def.kind)}
                    style={{
                      padding: "6px 12px",
                      borderRadius: 999,
                      fontSize: 12,
                      fontWeight: 600,
                      background: "transparent",
                      color: "var(--accent)",
                      border: "1px solid var(--paper-edge)",
                    }}
                  >
                    {t("settings.cli.login")}
                  </button>
                </>
              ) : (
                <>
                  <button
                    onClick={() => void doInstall(def.kind)}
                    disabled={isInstalling}
                    style={{
                      padding: "6px 14px",
                      borderRadius: 999,
                      fontSize: 12,
                      fontWeight: 600,
                      background: isInstalling ? "var(--paper-2)" : "var(--accent)",
                      color: isInstalling ? "var(--muted-deep)" : "white",
                      border: "none",
                    }}
                  >
                    {isInstalling ? t("settings.cli.installing") : t("settings.cli.install")}
                  </button>
                  <button
                    onClick={() => void doLogin(def.kind)}
                    style={{
                      padding: "6px 12px",
                      borderRadius: 999,
                      fontSize: 12,
                      fontWeight: 600,
                      background: "transparent",
                      color: "var(--accent)",
                      border: "1px solid var(--paper-edge)",
                    }}
                  >
                    {t("settings.cli.login")}
                  </button>
                  <button
                    onClick={() => void onChanged()}
                    title={t("settings.cli.redetect")}
                    aria-label={t("settings.cli.redetect")}
                    style={{
                      padding: 6,
                      borderRadius: 999,
                      color: "var(--muted-deep)",
                      background: "transparent",
                      border: "1px solid var(--paper-edge)",
                    }}
                  >
                    <IconRefresh size={13} />
                  </button>
                </>
              )}
            </div>
            {msg[def.kind] && (
              <div style={{ fontSize: 11.5, color: "var(--ink-soft)", lineHeight: 1.5 }}>
                {msg[def.kind]}
              </div>
            )}
          </div>
        );
      })}
    </>
  );
}
