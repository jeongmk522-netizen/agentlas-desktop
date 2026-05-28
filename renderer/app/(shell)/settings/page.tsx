// 설정 — BYOC 연결 관리. PRD 3.1 FRE 6단계 + 10번 리스크 "키 저장 위치 명시".
"use client";
import { useCallback, useEffect, useState } from "react";
import { ipc } from "@/lib/ipc";
import { useT, type LocalePref } from "@/lib/i18n";
import type { RuntimeBackend, RuntimeStatus } from "@/lib/types";
import { IconLock } from "@/components/Icon";

const BACKEND_LABEL: Record<RuntimeBackend, string> = {
  anthropic: "Anthropic (Claude)",
  openai: "OpenAI (ChatGPT)",
  google: "Google (Gemini)",
};

const BACKEND_KEY_HINT: Record<RuntimeBackend, string> = {
  anthropic: "console.anthropic.com → API Keys",
  openai: "platform.openai.com/api-keys",
  google: "aistudio.google.com/app/apikey",
};

const RUNTIME_LABEL: Record<string, string> = {
  "claude-code": "Claude Code CLI",
  codex: "Codex CLI",
  gemini: "Gemini CLI",
  byok: "API 키 (BYOK)",
};

export default function SettingsPage() {
  const { t, pref, setPref } = useT();
  const [statuses, setStatuses] = useState<RuntimeStatus[]>([]);
  const [draftKey, setDraftKey] = useState<Record<RuntimeBackend, string>>({
    anthropic: "",
    openai: "",
    google: "",
  });
  const [hasKey, setHasKey] = useState<Record<RuntimeBackend, boolean>>({
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
    });
    setStatuses(updated);
  }

  async function saveKey(backend: RuntimeBackend) {
    const api = ipc();
    if (!api) return;
    await api.secrets.saveApiKey(backend, draftKey[backend]);
    setDraftKey((d) => ({ ...d, [backend]: "" }));
    await refresh();
  }

  async function clearKey(backend: RuntimeBackend) {
    const api = ipc();
    if (!api) return;
    await api.secrets.deleteApiKey(backend);
    await refresh();
  }

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
                  {RUNTIME_LABEL[s.kind]} · {BACKEND_LABEL[s.backend]}
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

        <h2 style={{ fontFamily: "var(--font-head)", fontSize: 15, margin: "32px 0 12px" }}>
          {t("settings.byok")}
        </h2>
        <p style={{ fontSize: 12, color: "var(--muted-deep)", margin: "0 0 12px" }}>
          {t("settings.byok.note")}
        </p>
        {(["anthropic", "openai", "google"] as RuntimeBackend[]).map((b) => (
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
      </section>
    </div>
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
