// 글로벌 환경변수 — 에이전트들이 공유하는 외부 API 키 (Notion / Slack / GA4 등).
// 값은 macOS Keychain에만 저장, renderer는 hasValue만 받음.
// 에이전트 manifest의 envRequirements가 이 페이지에 자동 등록됨 (requiredBy 칩으로 표시).
"use client";
import { useCallback, useEffect, useMemo, useState } from "react";
import { ipc } from "@/lib/ipc";
import { pickLocalized, useT } from "@/lib/i18n";
import type { EnvVarMeta } from "@/lib/types";
import {
  IconCheck,
  IconClose,
  IconKey,
  IconLock,
  IconPlus,
  IconTrash,
} from "@/components/Icon";

export default function LibraryEnvPage() {
  const { t, locale } = useT();
  const [vars, setVars] = useState<EnvVarMeta[]>([]);
  const [editingKey, setEditingKey] = useState<string | null>(null);
  const [draftValue, setDraftValue] = useState("");
  const [adding, setAdding] = useState(false);
  const [newKey, setNewKey] = useState("");
  const [newValue, setNewValue] = useState("");
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    const api = ipc();
    if (!api) return;
    setVars(await api.env.list());
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function save(key: string, value: string) {
    const api = ipc();
    if (!api || !value.trim()) return;
    setBusy(true);
    try {
      await api.env.set(key, value);
      await refresh();
    } finally {
      setBusy(false);
    }
  }

  async function remove(key: string) {
    const api = ipc();
    if (!api) return;
    if (!confirm(t("env.confirm_delete", { key }))) return;
    await api.env.remove(key);
    await refresh();
  }

  // 정렬 — 필수/등록된 에이전트 많은 순, 그다음 free-form
  const sorted = useMemo(() => {
    return [...vars].sort((a, b) => {
      const aReq = a.requiredBy.length;
      const bReq = b.requiredBy.length;
      if (aReq !== bReq) return bReq - aReq;
      return a.key.localeCompare(b.key);
    });
  }, [vars]);

  return (
    <section style={{ padding: "24px 32px", maxWidth: 880, margin: "0 auto" }}>
      <h2
        style={{
          fontFamily: "var(--font-head)",
          fontSize: 18,
          margin: "0 0 4px",
          display: "inline-flex",
          alignItems: "center",
          gap: 8,
        }}
      >
        <IconKey size={18} style={{ color: "var(--accent)" }} />
        {t("env.title")}
      </h2>
      <p style={{ margin: "0 0 12px", fontSize: 13, color: "var(--muted-deep)" }}>
        {t("env.subtitle")}
      </p>

      <div
        className="glass-strong"
        style={{
          padding: "12px 14px",
          borderRadius: "var(--radius-md)",
          fontSize: 12,
          color: "var(--ink-soft)",
          display: "flex",
          gap: 10,
          alignItems: "flex-start",
          marginBottom: 16,
        }}
      >
        <IconLock size={14} style={{ color: "var(--accent)", flexShrink: 0, marginTop: 2 }} />
        <span>{t("env.security_note")}</span>
      </div>

      {/* 새 변수 추가 */}
      {adding ? (
        <div
          className="glass-strong"
          style={{
            padding: 14,
            borderRadius: "var(--radius-md)",
            marginBottom: 12,
            display: "flex",
            flexDirection: "column",
            gap: 8,
          }}
        >
          <div style={{ display: "flex", gap: 8 }}>
            <input
              value={newKey}
              onChange={(e) => setNewKey(e.target.value.toUpperCase().replace(/[^A-Z0-9_]/g, "_"))}
              placeholder={t("env.field.key.placeholder")}
              autoFocus
              style={{
                flex: 1,
                padding: "8px 12px",
                border: "1px solid var(--paper-edge)",
                borderRadius: "var(--radius-md)",
                background: "var(--paper)",
                fontSize: 12.5,
                fontFamily: "var(--font-mono)",
                outline: "none",
              }}
            />
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            <input
              type="password"
              value={newValue}
              onChange={(e) => setNewValue(e.target.value)}
              placeholder={t("env.field.value.placeholder")}
              style={{
                flex: 1,
                padding: "8px 12px",
                border: "1px solid var(--paper-edge)",
                borderRadius: "var(--radius-md)",
                background: "var(--paper)",
                fontSize: 12.5,
                fontFamily: "var(--font-mono)",
                outline: "none",
              }}
            />
            <button
              onClick={async () => {
                if (!newKey.trim() || !newValue.trim()) return;
                await save(newKey.trim(), newValue);
                setNewKey("");
                setNewValue("");
                setAdding(false);
              }}
              disabled={!newKey.trim() || !newValue.trim() || busy}
              style={{
                padding: "8px 16px",
                borderRadius: "var(--radius-md)",
                background:
                  newKey.trim() && newValue.trim() ? "var(--ink)" : "var(--paper-2)",
                color: newKey.trim() && newValue.trim() ? "white" : "var(--muted-deep)",
                fontWeight: 600,
                fontSize: 12,
                border: "none",
              }}
            >
              {t("common.save")}
            </button>
            <button
              onClick={() => {
                setNewKey("");
                setNewValue("");
                setAdding(false);
              }}
              style={{
                padding: "8px 12px",
                borderRadius: "var(--radius-md)",
                background: "transparent",
                color: "var(--muted-deep)",
                fontSize: 12,
                border: "1px solid var(--paper-edge)",
              }}
            >
              {t("common.cancel")}
            </button>
          </div>
        </div>
      ) : (
        <button
          onClick={() => setAdding(true)}
          style={{
            marginBottom: 16,
            padding: "9px 14px",
            borderRadius: "var(--radius-md)",
            background: "var(--accent)",
            color: "white",
            fontWeight: 600,
            fontSize: 12.5,
            border: "none",
            display: "inline-flex",
            alignItems: "center",
            gap: 6,
            boxShadow: "var(--shadow-1)",
          }}
        >
          <IconPlus size={14} />
          {t("env.add_new")}
        </button>
      )}

      {/* 변수 목록 */}
      {sorted.length === 0 && !adding ? (
        <div
          style={{
            padding: 32,
            border: "1px dashed var(--paper-edge)",
            borderRadius: "var(--radius-md)",
            color: "var(--muted-deep)",
            textAlign: "center",
            fontSize: 13,
          }}
        >
          {t("env.empty")}
        </div>
      ) : (
        <ul style={{ listStyle: "none", padding: 0, margin: 0, display: "flex", flexDirection: "column", gap: 8 }}>
          {sorted.map((v) => {
            const isEditing = editingKey === v.key;
            // 첫 번째 requiredBy에서 라벨/힌트 가져옴 (여러 에이전트가 같은 키를 다른 라벨로 요구할 수 있음)
            const firstReq = v.requiredBy[0];
            const displayLabel = firstReq
              ? locale === "en"
                ? firstReq.labelEn || firstReq.label
                : firstReq.label
              : null;
            const displayHint = firstReq
              ? locale === "en"
                ? firstReq.hintEn || firstReq.hint
                : firstReq.hint
              : null;
            return (
              <li
                key={v.key}
                style={{
                  background: "var(--paper)",
                  border: "1px solid var(--paper-edge)",
                  borderRadius: "var(--radius-md)",
                  padding: "12px 14px",
                  display: "flex",
                  flexDirection: "column",
                  gap: 6,
                }}
              >
                {/*
                  좁은 윈도우에서도 액션이 항상 보이게 한다:
                  - 헤더 행은 wrap 허용
                  - 키/칩 그룹은 좌측에서 자유롭게 확장하지만 flexShrink 1
                  - 액션 버튼은 marginLeft: auto + flexShrink: 0으로 항상 우측 끝
                */}
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 8,
                    flexWrap: "wrap",
                    rowGap: 6,
                  }}
                >
                  <div
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 8,
                      minWidth: 0,
                      flex: "1 1 auto",
                    }}
                  >
                    <code
                      style={{
                        fontFamily: "var(--font-mono)",
                        fontSize: 12.5,
                        fontWeight: 600,
                        color: "var(--ink)",
                        wordBreak: "break-all",
                        minWidth: 0,
                      }}
                    >
                      {v.key}
                    </code>
                    {v.hasValue ? (
                      <span
                        style={{
                          fontSize: 10,
                          padding: "2px 8px",
                          borderRadius: 999,
                          background: "rgba(168,217,155,0.20)",
                          color: "var(--green-deep)",
                          fontWeight: 600,
                          display: "inline-flex",
                          alignItems: "center",
                          gap: 3,
                          flexShrink: 0,
                        }}
                      >
                        <IconCheck size={10} />
                        {t("env.saved")}
                      </span>
                    ) : (
                      <span
                        style={{
                          fontSize: 10,
                          padding: "2px 8px",
                          borderRadius: 999,
                          background: "var(--paper-2)",
                          color: "var(--muted-deep)",
                          fontWeight: 600,
                          flexShrink: 0,
                        }}
                      >
                        {t("env.not_set")}
                      </span>
                    )}
                  </div>

                  {/* 액션 그룹 — 항상 우측 끝, 화면 좁아져도 새 줄로 wrap만 되지 잘리지 않음 */}
                  {!isEditing && (
                    <div
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: 6,
                        marginLeft: "auto",
                        flexShrink: 0,
                      }}
                    >
                      {v.requiredBy.length > 0 ? (
                        <span style={{ fontSize: 11, color: "var(--muted-deep)" }}>
                          {t("env.required_by", { n: v.requiredBy.length })}
                        </span>
                      ) : (
                        <span style={{ fontSize: 11, color: "var(--muted)" }}>
                          {t("env.required_by_none")}
                        </span>
                      )}
                      <button
                        onClick={() => {
                          setEditingKey(v.key);
                          setDraftValue("");
                        }}
                        style={{
                          fontSize: 11,
                          color: "var(--accent)",
                          fontWeight: 600,
                          padding: "4px 10px",
                          borderRadius: 999,
                          border: "1px solid var(--paper-edge)",
                          background: "transparent",
                        }}
                      >
                        {v.hasValue ? t("common.edit") : t("common.save")}
                      </button>
                      {v.hasValue && (
                        <button
                          onClick={() => void remove(v.key)}
                          aria-label={t("common.delete")}
                          title={t("common.delete")}
                          style={{
                            display: "inline-flex",
                            alignItems: "center",
                            justifyContent: "center",
                            color: "var(--red-deep)",
                            background: "transparent",
                            border: "1px solid var(--paper-edge)",
                            borderRadius: 999,
                            padding: "4px 8px",
                            cursor: "pointer",
                          }}
                        >
                          <IconTrash size={13} />
                        </button>
                      )}
                    </div>
                  )}
                </div>

                {displayLabel && (
                  <div style={{ fontSize: 12, color: "var(--ink-soft)" }}>
                    {displayLabel}
                  </div>
                )}
                {displayHint && (
                  <div style={{ fontSize: 11, color: "var(--muted-deep)" }}>
                    {displayHint}
                  </div>
                )}

                {v.requiredBy.length > 0 && (
                  <div style={{ display: "flex", flexWrap: "wrap", gap: 4, marginTop: 4 }}>
                    {v.requiredBy.map((r) => (
                      <span
                        key={r.agentId}
                        style={{
                          fontSize: 10,
                          padding: "2px 8px",
                          borderRadius: 999,
                          background: "var(--fill-1)",
                          color: "var(--accent)",
                          fontWeight: 600,
                        }}
                      >
                        {locale === "en" ? r.agentNameEn || r.agentName : r.agentName}
                      </span>
                    ))}
                  </div>
                )}

                {isEditing && (
                  <div style={{ display: "flex", gap: 8, marginTop: 6 }}>
                    <input
                      type="password"
                      autoFocus
                      value={draftValue}
                      onChange={(e) => setDraftValue(e.target.value)}
                      placeholder={t("env.field.value.placeholder")}
                      style={{
                        flex: 1,
                        padding: "8px 12px",
                        border: "1px solid var(--paper-edge)",
                        borderRadius: "var(--radius-md)",
                        background: "var(--paper-2)",
                        fontSize: 12.5,
                        fontFamily: "var(--font-mono)",
                        outline: "none",
                      }}
                    />
                    <button
                      onClick={async () => {
                        if (!draftValue.trim()) return;
                        await save(v.key, draftValue);
                        setEditingKey(null);
                        setDraftValue("");
                      }}
                      disabled={!draftValue.trim() || busy}
                      style={{
                        padding: "6px 14px",
                        borderRadius: "var(--radius-md)",
                        background: draftValue.trim() ? "var(--ink)" : "var(--paper-2)",
                        color: draftValue.trim() ? "white" : "var(--muted-deep)",
                        fontWeight: 600,
                        fontSize: 12,
                        border: "none",
                      }}
                    >
                      {t("common.save")}
                    </button>
                    <button
                      onClick={() => {
                        setEditingKey(null);
                        setDraftValue("");
                      }}
                      aria-label={t("common.cancel")}
                      style={{ color: "var(--muted-deep)", padding: 6 }}
                    >
                      <IconClose size={14} />
                    </button>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
