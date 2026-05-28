// 글로벌 환경변수 — 모든 에이전트·회사가 공유하는 외부 API 키 (Notion / Slack / GA4 등).
// 값은 macOS Keychain에만 저장, renderer는 hasValue만 받음.
// 좌측: 검색·정렬·필터 리스트. 우측: 에이전트 드롭다운으로 그 에이전트가 요구하는 env만.
"use client";
import { useCallback, useEffect, useMemo, useState } from "react";
import { ipc } from "@/lib/ipc";
import { pickLocalized, useT } from "@/lib/i18n";
import type { EnvVarMeta, InstalledAgent } from "@/lib/types";
import {
  IconCheck,
  IconKey,
  IconLock,
  IconPlus,
  IconSearch,
  IconTrash,
} from "@/components/Icon";

type SortKey = "usage" | "name";
type FilterKey = "all" | "set" | "unset";

export default function LibraryEnvPage() {
  const { t, locale } = useT();
  const [vars, setVars] = useState<EnvVarMeta[]>([]);
  const [agents, setAgents] = useState<InstalledAgent[]>([]);
  const [busy, setBusy] = useState(false);

  const [search, setSearch] = useState("");
  const [sort, setSort] = useState<SortKey>("usage");
  const [filter, setFilter] = useState<FilterKey>("all");
  const [selectedAgentId, setSelectedAgentId] = useState<string>("");

  const [adding, setAdding] = useState(false);
  const [newKey, setNewKey] = useState("");
  const [newValue, setNewValue] = useState("");

  const refresh = useCallback(async () => {
    const api = ipc();
    if (!api) return;
    const [v, a] = await Promise.all([api.env.list(), api.team.list()]);
    setVars(v);
    setAgents(a);
    setSelectedAgentId((cur) => cur || a[0]?.id || "");
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

  const visible = useMemo(() => {
    const q = search.trim().toLowerCase();
    let list = vars;
    if (q) {
      list = list.filter(
        (v) =>
          v.key.toLowerCase().includes(q) ||
          v.requiredBy.some((r) =>
            (r.label ?? "").toLowerCase().includes(q) ||
            (r.labelEn ?? "").toLowerCase().includes(q) ||
            r.agentName.toLowerCase().includes(q) ||
            r.agentNameEn.toLowerCase().includes(q),
          ),
      );
    }
    if (filter === "set") list = list.filter((v) => v.hasValue);
    else if (filter === "unset") list = list.filter((v) => !v.hasValue);

    return [...list].sort((a, b) => {
      if (sort === "name") return a.key.localeCompare(b.key);
      const diff = b.requiredBy.length - a.requiredBy.length;
      if (diff !== 0) return diff;
      return a.key.localeCompare(b.key);
    });
  }, [vars, search, filter, sort]);

  // 우측 패널 — 선택한 에이전트가 요구하는 env만 추려서 보여준다.
  const selectedAgent = agents.find((a) => a.id === selectedAgentId) ?? null;
  const agentEnv = useMemo(() => {
    if (!selectedAgent) return [];
    return selectedAgent.envRequirements.map((req) => {
      const meta = vars.find((v) => v.key === req.key);
      return { req, hasValue: meta?.hasValue ?? false };
    });
  }, [selectedAgent, vars]);

  return (
    <div style={{ height: "100%", display: "flex", minWidth: 0, minHeight: 0, overflow: "hidden" }}>
      {/* 좌측 — 전역 env 리스트 */}
      <div style={{ flex: 1, minWidth: 0, overflowY: "auto" }}>
        <section style={{ padding: "24px 32px" }}>
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

          {/* 툴바 — 검색 / 정렬 / 필터 / 추가 */}
          <div style={{ display: "flex", gap: 8, marginBottom: 12, flexWrap: "wrap", alignItems: "center" }}>
            <div style={{ position: "relative", flex: "1 1 200px", minWidth: 160 }}>
              <IconSearch
                size={13}
                style={{
                  position: "absolute",
                  left: 10,
                  top: "50%",
                  transform: "translateY(-50%)",
                  color: "var(--muted-deep)",
                }}
              />
              <input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder={t("env.search")}
                style={{
                  width: "100%",
                  padding: "8px 12px 8px 30px",
                  border: "1px solid var(--paper-edge)",
                  borderRadius: 999,
                  background: "var(--paper)",
                  fontSize: 12.5,
                  outline: "none",
                }}
              />
            </div>
            <select
              value={sort}
              onChange={(e) => setSort(e.target.value as SortKey)}
              style={selectStyle}
            >
              <option value="usage">{t("env.sort.usage")}</option>
              <option value="name">{t("env.sort.name")}</option>
            </select>
            <div style={{ display: "flex", gap: 4 }}>
              {(["all", "set", "unset"] as FilterKey[]).map((f) => {
                const active = filter === f;
                return (
                  <button
                    key={f}
                    onClick={() => setFilter(f)}
                    style={{
                      padding: "6px 12px",
                      borderRadius: 999,
                      fontSize: 11.5,
                      fontWeight: active ? 700 : 500,
                      background: active ? "var(--ink)" : "var(--paper-2)",
                      color: active ? "white" : "var(--ink-soft)",
                      border: active ? "1px solid var(--ink)" : "1px solid var(--paper-edge)",
                    }}
                  >
                    {t(`env.filter.${f}` as "env.filter.all")}
                  </button>
                );
              })}
            </div>
            <button
              onClick={() => setAdding((v) => !v)}
              style={{
                marginLeft: "auto",
                padding: "8px 14px",
                borderRadius: 999,
                background: "var(--accent)",
                color: "white",
                fontWeight: 600,
                fontSize: 12,
                border: "none",
                display: "inline-flex",
                alignItems: "center",
                gap: 6,
              }}
            >
              <IconPlus size={13} />
              {t("env.add_new")}
            </button>
          </div>

          {/* 새 변수 추가 */}
          {adding && (
            <div
              className="glass-strong"
              style={{
                padding: 14,
                borderRadius: "var(--radius-md)",
                marginBottom: 12,
                display: "flex",
                gap: 8,
                flexWrap: "wrap",
              }}
            >
              <input
                value={newKey}
                onChange={(e) => setNewKey(e.target.value.toUpperCase().replace(/[^A-Z0-9_]/g, "_"))}
                placeholder={t("env.field.key.placeholder")}
                autoFocus
                style={{ ...inputStyle, flex: "1 1 200px", fontFamily: "var(--font-mono)" }}
              />
              <input
                type="password"
                value={newValue}
                onChange={(e) => setNewValue(e.target.value)}
                placeholder={t("env.field.value.placeholder")}
                style={{ ...inputStyle, flex: "1 1 200px", fontFamily: "var(--font-mono)" }}
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
                  background: newKey.trim() && newValue.trim() ? "var(--ink)" : "var(--paper-2)",
                  color: newKey.trim() && newValue.trim() ? "white" : "var(--muted-deep)",
                  fontWeight: 600,
                  fontSize: 12,
                  border: "none",
                }}
              >
                {t("common.save")}
              </button>
            </div>
          )}

          {/* 변수 목록 */}
          {visible.length === 0 ? (
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
              {search.trim() || filter !== "all" ? t("env.no_results") : t("env.empty")}
            </div>
          ) : (
            <ul style={{ listStyle: "none", padding: 0, margin: 0, display: "flex", flexDirection: "column", gap: 8 }}>
              {visible.map((v) => (
                <EnvRow
                  key={v.key}
                  v={v}
                  locale={locale}
                  busy={busy}
                  onSave={save}
                  onRemove={remove}
                />
              ))}
            </ul>
          )}
        </section>
      </div>

      {/* 우측 — 에이전트별 env */}
      <aside
        className="glass-thin"
        style={{
          width: 320,
          flexShrink: 0,
          borderLeft: "1px solid var(--glass-border)",
          display: "flex",
          flexDirection: "column",
          minHeight: 0,
        }}
      >
        <div style={{ padding: "16px 16px 10px", borderBottom: "1px solid var(--glass-border)" }}>
          <div style={{ fontSize: 11, color: "var(--muted-deep)", marginBottom: 6, fontWeight: 600 }}>
            {t("env.by_agent")}
          </div>
          {agents.length === 0 ? (
            <div style={{ fontSize: 12, color: "var(--muted)" }}>{t("env.no_agents")}</div>
          ) : (
            <select
              value={selectedAgentId}
              onChange={(e) => setSelectedAgentId(e.target.value)}
              style={{ ...selectStyle, width: "100%" }}
            >
              {agents.map((a) => (
                <option key={a.id} value={a.id}>
                  {pickLocalized(a, locale).name}
                </option>
              ))}
            </select>
          )}
        </div>

        <div style={{ flex: 1, overflowY: "auto", padding: "12px 16px" }}>
          {!selectedAgent ? (
            <div style={{ fontSize: 12, color: "var(--muted)" }}>{t("env.pick_agent")}</div>
          ) : agentEnv.length === 0 ? (
            <div
              style={{
                padding: 16,
                border: "1px dashed var(--paper-edge)",
                borderRadius: "var(--radius-md)",
                fontSize: 12,
                color: "var(--muted-deep)",
                lineHeight: 1.5,
              }}
            >
              {t("env.agent_no_env")}
            </div>
          ) : (
            <ul style={{ listStyle: "none", padding: 0, margin: 0, display: "flex", flexDirection: "column", gap: 10 }}>
              {agentEnv.map(({ req, hasValue }) => {
                const label = locale === "en" ? req.labelEn || req.label : req.label;
                const hint = locale === "en" ? req.hintEn || req.hint : req.hint;
                return (
                  <li
                    key={req.key}
                    style={{
                      background: "var(--paper)",
                      border: "1px solid var(--paper-edge)",
                      borderRadius: "var(--radius-md)",
                      padding: "10px 12px",
                      display: "flex",
                      flexDirection: "column",
                      gap: 6,
                    }}
                  >
                    <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
                      <code
                        style={{
                          fontFamily: "var(--font-mono)",
                          fontSize: 11.5,
                          fontWeight: 600,
                          wordBreak: "break-all",
                          flex: 1,
                          minWidth: 0,
                        }}
                      >
                        {req.key}
                      </code>
                      {hasValue ? (
                        <span
                          style={{
                            fontSize: 9.5,
                            padding: "2px 7px",
                            borderRadius: 999,
                            background: "rgba(168,217,155,0.20)",
                            color: "var(--green-deep)",
                            fontWeight: 600,
                            display: "inline-flex",
                            alignItems: "center",
                            gap: 3,
                          }}
                        >
                          <IconCheck size={9} /> {t("env.saved")}
                        </span>
                      ) : (
                        <span
                          style={{
                            fontSize: 9.5,
                            padding: "2px 7px",
                            borderRadius: 999,
                            background: req.required ? "rgba(240,171,140,0.25)" : "var(--paper-2)",
                            color: req.required ? "var(--peach-ink)" : "var(--muted-deep)",
                            fontWeight: 600,
                          }}
                        >
                          {req.required ? t("env.required") : t("env.optional")}
                        </span>
                      )}
                    </div>
                    {label && <div style={{ fontSize: 11.5, color: "var(--ink-soft)" }}>{label}</div>}
                    {hint && <div style={{ fontSize: 10.5, color: "var(--muted-deep)", lineHeight: 1.5 }}>{hint}</div>}
                    <InlineSet
                      placeholder={t("env.field.value.placeholder")}
                      saveLabel={hasValue ? t("common.edit") : t("common.save")}
                      busy={busy}
                      onSave={(val) => save(req.key, val)}
                    />
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </aside>
    </div>
  );
}

const inputStyle: React.CSSProperties = {
  padding: "8px 12px",
  border: "1px solid var(--paper-edge)",
  borderRadius: "var(--radius-md)",
  background: "var(--paper)",
  fontSize: 12.5,
  outline: "none",
};

const selectStyle: React.CSSProperties = {
  padding: "7px 10px",
  border: "1px solid var(--paper-edge)",
  borderRadius: 999,
  background: "var(--paper)",
  fontSize: 12,
  color: "var(--ink-soft)",
  outline: "none",
};

function EnvRow({
  v,
  locale,
  busy,
  onSave,
  onRemove,
}: {
  v: EnvVarMeta;
  locale: "ko" | "en";
  busy: boolean;
  onSave: (key: string, value: string) => void | Promise<void>;
  onRemove: (key: string) => void | Promise<void>;
}) {
  const { t } = useT();
  const [editing, setEditing] = useState(false);
  const firstReq = v.requiredBy[0];
  const label = firstReq ? (locale === "en" ? firstReq.labelEn || firstReq.label : firstReq.label) : null;
  const hint = firstReq ? (locale === "en" ? firstReq.hintEn || firstReq.hint : firstReq.hint) : null;

  return (
    <li
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
      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", rowGap: 6 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0, flex: "1 1 auto" }}>
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

        {!editing && (
          <div style={{ display: "flex", alignItems: "center", gap: 6, marginLeft: "auto", flexShrink: 0 }}>
            {v.requiredBy.length > 0 ? (
              <span style={{ fontSize: 11, color: "var(--muted-deep)" }}>
                {t("env.required_by", { n: v.requiredBy.length })}
              </span>
            ) : (
              <span style={{ fontSize: 11, color: "var(--muted)" }}>{t("env.required_by_none")}</span>
            )}
            <button
              onClick={() => setEditing(true)}
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
                onClick={() => void onRemove(v.key)}
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

      {label && <div style={{ fontSize: 12, color: "var(--ink-soft)" }}>{label}</div>}
      {hint && <div style={{ fontSize: 11, color: "var(--muted-deep)" }}>{hint}</div>}

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

      {editing && (
        <InlineSet
          autoFocus
          placeholder={t("env.field.value.placeholder")}
          saveLabel={t("common.save")}
          busy={busy}
          onSave={async (val) => {
            await onSave(v.key, val);
            setEditing(false);
          }}
          onCancel={() => setEditing(false)}
        />
      )}
    </li>
  );
}

function InlineSet({
  placeholder,
  saveLabel,
  busy,
  onSave,
  onCancel,
  autoFocus,
}: {
  placeholder: string;
  saveLabel: string;
  busy: boolean;
  onSave: (value: string) => void | Promise<void>;
  onCancel?: () => void;
  autoFocus?: boolean;
}) {
  const { t } = useT();
  const [draft, setDraft] = useState("");
  return (
    <div style={{ display: "flex", gap: 6, marginTop: 4 }}>
      <input
        type="password"
        autoFocus={autoFocus}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        placeholder={placeholder}
        style={{ ...inputStyle, flex: 1, background: "var(--paper-2)", fontFamily: "var(--font-mono)" }}
      />
      <button
        onClick={async () => {
          if (!draft.trim()) return;
          await onSave(draft);
          setDraft("");
        }}
        disabled={!draft.trim() || busy}
        style={{
          padding: "6px 12px",
          borderRadius: "var(--radius-md)",
          background: draft.trim() ? "var(--ink)" : "var(--paper-2)",
          color: draft.trim() ? "white" : "var(--muted-deep)",
          fontWeight: 600,
          fontSize: 11.5,
          border: "none",
          whiteSpace: "nowrap",
        }}
      >
        {saveLabel}
      </button>
      {onCancel && (
        <button
          onClick={onCancel}
          style={{
            padding: "6px 10px",
            borderRadius: "var(--radius-md)",
            background: "transparent",
            color: "var(--muted-deep)",
            fontSize: 11.5,
            border: "1px solid var(--paper-edge)",
          }}
        >
          {t("common.cancel")}
        </button>
      )}
    </div>
  );
}
