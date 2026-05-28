// 외부 MCP 툴 플러그인 매니저 — Slack/Discord/GitHub 등을 실제로 연결한다(Codex 스타일).
// 한 번 연결하면 모든 에이전트·팀이 공유한다 (에이전트별 연결 개념 없음 — 전역 원터치).
// 두 탭: 연결됨(설치/구성된 서버 + 상태/테스트/제거) · 도구 추가(카탈로그에서 연결).
// 키는 환경변수 vault에 저장되고 자동 주입 — LLM 무관.
"use client";
import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { ipc } from "@/lib/ipc";
import { useT } from "@/lib/i18n";
import type {
  InstalledMcpServer,
  McpServerStatus,
  McpToolCatalogEntry,
} from "@/lib/types";
import {
  IconCheck,
  IconKey,
  IconLock,
  IconPlus,
  IconRefresh,
  IconShield,
  IconTrash,
  IconWand,
} from "@/components/Icon";

type Tab = "installed" | "catalog";

export default function LibraryMcpsPage() {
  const { t, locale } = useT();
  const [tab, setTab] = useState<Tab>("installed");
  const [catalog, setCatalog] = useState<McpToolCatalogEntry[]>([]);
  const [installed, setInstalled] = useState<InstalledMcpServer[]>([]);
  const [statuses, setStatuses] = useState<Record<string, McpServerStatus>>({});
  const [testing, setTesting] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [query, setQuery] = useState("");

  const refresh = useCallback(async () => {
    const api = ipc();
    if (!api) return;
    const [c, i] = await Promise.all([
      api.mcpTools.listCatalog(),
      api.mcpTools.listInstalled(),
    ]);
    setCatalog(c);
    setInstalled(i);
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const installedCatalogIds = useMemo(
    () => new Set(installed.map((s) => s.catalogId).filter((x): x is string => !!x)),
    [installed],
  );

  const filteredCatalog = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return catalog;
    return catalog.filter((e) =>
      [e.name, e.nameEn, e.description, e.descriptionEn, e.category]
        .filter(Boolean)
        .some((s) => s!.toLowerCase().includes(q)),
    );
  }, [catalog, query]);

  async function connect(catalogId: string) {
    const api = ipc();
    if (!api) return;
    setBusy(catalogId);
    try {
      await api.mcpTools.install(catalogId);
      await refresh();
      setTab("installed");
    } finally {
      setBusy(null);
    }
  }

  async function remove(server: InstalledMcpServer) {
    const api = ipc();
    if (!api) return;
    const name = locale === "en" ? server.nameEn || server.name : server.name;
    if (!confirm(t("mcps.confirm_remove", { name }))) return;
    await api.mcpTools.remove(server.id);
    setStatuses((s) => {
      const next = { ...s };
      delete next[server.id];
      return next;
    });
    await refresh();
  }

  async function toggle(server: InstalledMcpServer) {
    const api = ipc();
    if (!api) return;
    await api.mcpTools.setEnabled(server.id, !server.enabled);
    await refresh();
  }

  async function test(server: InstalledMcpServer) {
    const api = ipc();
    if (!api) return;
    setTesting(server.id);
    try {
      const status = await api.mcpTools.test(server.id);
      setStatuses((s) => ({ ...s, [server.id]: status }));
    } finally {
      setTesting(null);
    }
  }

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
        <IconWand size={18} style={{ color: "var(--accent)" }} />
        {t("mcps.title")}
      </h2>
      <p style={{ margin: "0 0 16px", fontSize: 13, color: "var(--muted-deep)", lineHeight: 1.6 }}>
        {t("mcps.subtitle")}
      </p>

      {/* 전역 공유 안내 — Codex/Claude 런타임 연결처럼 한 번 켜면 모두가 쓴다 */}
      <div
        className="glass-strong"
        style={{
          marginBottom: 16,
          padding: "10px 14px",
          borderRadius: "var(--radius-md)",
          fontSize: 11.5,
          color: "var(--ink-soft)",
          display: "flex",
          gap: 10,
          alignItems: "flex-start",
        }}
      >
        <IconShield size={13} style={{ color: "var(--accent)", flexShrink: 0, marginTop: 2 }} />
        <span>{t("mcps.shared_note")}</span>
      </div>

      {/* 탭 */}
      <div style={{ display: "flex", gap: 6, marginBottom: 18, alignItems: "center" }}>
        {(["installed", "catalog"] as Tab[]).map((id) => {
          const active = tab === id;
          const label =
            id === "installed"
              ? `${t("mcps.tab.installed")}${installed.length ? ` · ${installed.length}` : ""}`
              : t("mcps.tab.catalog");
          return (
            <button
              key={id}
              onClick={() => setTab(id)}
              style={{
                padding: "6px 14px",
                borderRadius: 999,
                fontSize: 12.5,
                fontWeight: active ? 700 : 500,
                background: active ? "var(--ink)" : "var(--paper-2)",
                color: active ? "white" : "var(--ink-soft)",
                border: active ? "1px solid var(--ink)" : "1px solid var(--paper-edge)",
              }}
            >
              {label}
            </button>
          );
        })}
        {tab === "catalog" && (
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t("mcps.search")}
            style={{
              marginLeft: "auto",
              padding: "6px 12px",
              fontSize: 12.5,
              border: "1px solid var(--paper-edge)",
              borderRadius: 999,
              background: "var(--paper)",
              outline: "none",
              width: 200,
            }}
          />
        )}
      </div>

      {tab === "installed" ? (
        installed.length === 0 ? (
          <Empty text={t("mcps.installed_empty")} />
        ) : (
          <ul style={{ listStyle: "none", padding: 0, margin: 0, display: "flex", flexDirection: "column", gap: 10 }}>
            {installed.map((server) => {
              const name = locale === "en" ? server.nameEn || server.name : server.name;
              const status = statuses[server.id];
              return (
                <li
                  key={server.id}
                  style={{
                    background: "var(--paper)",
                    border: "1px solid var(--paper-edge)",
                    borderRadius: "var(--radius-md)",
                    padding: "14px 16px",
                    display: "flex",
                    flexDirection: "column",
                    gap: 8,
                  }}
                >
                  <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
                    <strong style={{ fontSize: 14 }}>{name}</strong>
                    <span
                      style={{
                        fontSize: 10,
                        padding: "2px 8px",
                        borderRadius: 999,
                        background: "var(--paper-2)",
                        color: "var(--muted-deep)",
                        fontFamily: "var(--font-mono)",
                      }}
                    >
                      {t(`mcps.transport.${server.transport}` as "mcps.transport.stdio")}
                    </span>
                    {server.envKeys.length > 0 && (
                      <span style={{ fontSize: 11, color: "var(--muted-deep)", display: "inline-flex", alignItems: "center", gap: 3 }}>
                        <IconKey size={11} /> {t("mcps.needs_env", { n: server.envKeys.length })}
                      </span>
                    )}
                    <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 6 }}>
                      <button
                        onClick={() => void toggle(server)}
                        style={{
                          fontSize: 11,
                          fontWeight: 600,
                          padding: "4px 10px",
                          borderRadius: 999,
                          border: "1px solid var(--paper-edge)",
                          background: server.enabled ? "rgba(168,217,155,0.20)" : "var(--paper-2)",
                          color: server.enabled ? "var(--green-deep)" : "var(--muted-deep)",
                        }}
                      >
                        {server.enabled ? t("mcps.on") : t("mcps.off")}
                      </button>
                      <button
                        onClick={() => void test(server)}
                        disabled={testing === server.id || !server.enabled}
                        style={{
                          fontSize: 11,
                          fontWeight: 600,
                          padding: "4px 10px",
                          borderRadius: 999,
                          border: "1px solid var(--paper-edge)",
                          background: "transparent",
                          color: "var(--accent)",
                          display: "inline-flex",
                          alignItems: "center",
                          gap: 4,
                          opacity: server.enabled ? 1 : 0.5,
                        }}
                      >
                        <IconRefresh size={11} />
                        {testing === server.id ? t("mcps.testing") : t("mcps.test")}
                      </button>
                      <button
                        onClick={() => void remove(server)}
                        aria-label={t("mcps.remove")}
                        title={t("mcps.remove")}
                        style={{
                          color: "var(--red-deep)",
                          background: "transparent",
                          border: "1px solid var(--paper-edge)",
                          borderRadius: 999,
                          padding: "4px 8px",
                        }}
                      >
                        <IconTrash size={12} />
                      </button>
                    </div>
                  </div>

                  <StatusLine status={status} testing={testing === server.id} t={t} />
                </li>
              );
            })}
          </ul>
        )
      ) : (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(2, minmax(0,1fr))", gap: 12 }}>
          {filteredCatalog.length === 0 ? (
            <div style={{ gridColumn: "1 / -1" }}>
              <Empty text={t("mcps.no_results")} />
            </div>
          ) : (
            filteredCatalog.map((entry) => {
              const name = locale === "en" ? entry.nameEn || entry.name : entry.name;
              const desc = locale === "en" ? entry.descriptionEn || entry.description : entry.description;
              const already = installedCatalogIds.has(entry.id);
              return (
                <div
                  key={entry.id}
                  style={{
                    background: "var(--paper)",
                    border: "1px solid var(--paper-edge)",
                    borderRadius: "var(--radius-md)",
                    padding: 14,
                    display: "flex",
                    flexDirection: "column",
                    gap: 8,
                  }}
                >
                  <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <strong style={{ fontSize: 13.5, flex: 1 }}>{name}</strong>
                    <span
                      title={entry.trust === "official" ? t("mcps.official") : t("mcps.community")}
                      style={{
                        fontSize: 10,
                        padding: "2px 7px",
                        borderRadius: 999,
                        display: "inline-flex",
                        alignItems: "center",
                        gap: 3,
                        background: entry.trust === "official" ? "rgba(168,217,155,0.20)" : "var(--paper-2)",
                        color: entry.trust === "official" ? "var(--green-deep)" : "var(--muted-deep)",
                        fontWeight: 600,
                      }}
                    >
                      <IconShield size={10} />
                      {entry.trust === "official" ? t("mcps.official") : t("mcps.community")}
                    </span>
                  </div>
                  <div style={{ fontSize: 11.5, color: "var(--muted-deep)", lineHeight: 1.5, minHeight: 32 }}>
                    {desc}
                  </div>
                  <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 2 }}>
                    <span style={{ fontSize: 10.5, color: "var(--muted)", flex: 1 }}>
                      {t(`mcps.cat.${entry.category}` as "mcps.cat.dev")}
                      {" · "}
                      {entry.envRequirements.length > 0
                        ? t("mcps.needs_env", { n: entry.envRequirements.length })
                        : t("mcps.no_env_needed")}
                    </span>
                    {already ? (
                      <span
                        style={{
                          fontSize: 11.5,
                          fontWeight: 600,
                          color: "var(--green-deep)",
                          display: "inline-flex",
                          alignItems: "center",
                          gap: 4,
                        }}
                      >
                        <IconCheck size={13} /> {t("mcps.connected")}
                      </span>
                    ) : (
                      <button
                        onClick={() => void connect(entry.id)}
                        disabled={busy === entry.id}
                        style={{
                          fontSize: 11.5,
                          fontWeight: 600,
                          padding: "5px 12px",
                          borderRadius: 999,
                          background: "var(--accent)",
                          color: "white",
                          border: "none",
                          display: "inline-flex",
                          alignItems: "center",
                          gap: 4,
                        }}
                      >
                        <IconPlus size={12} />
                        {t("mcps.connect")}
                      </button>
                    )}
                  </div>
                </div>
              );
            })
          )}
        </div>
      )}

      {/* 보안 노트 */}
      <div
        className="glass-strong"
        style={{
          marginTop: 18,
          padding: "10px 14px",
          borderRadius: "var(--radius-md)",
          fontSize: 11.5,
          color: "var(--ink-soft)",
          display: "flex",
          gap: 10,
          alignItems: "flex-start",
        }}
      >
        <IconLock size={13} style={{ color: "var(--accent)", flexShrink: 0, marginTop: 2 }} />
        <span>{t("env.security_note")}</span>
      </div>
    </section>
  );
}

function StatusLine({
  status,
  testing,
  t,
}: {
  status: McpServerStatus | undefined;
  testing: boolean;
  t: ReturnType<typeof useT>["t"];
}) {
  if (testing) {
    return <div style={{ fontSize: 12, color: "var(--muted-deep)" }}>{t("mcps.testing")}</div>;
  }
  if (!status) {
    return <div style={{ fontSize: 12, color: "var(--muted)" }}>{t("mcps.untested")}</div>;
  }
  if (status.missingEnv.length > 0) {
    return (
      <div style={{ fontSize: 12, color: "var(--peach-ink)", display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        <span>{t("mcps.status.missing_env", { keys: status.missingEnv.join(", ") })}</span>
        <Link href="/library/env" style={{ color: "var(--accent)", fontWeight: 600 }}>
          {t("mcps.missing_env_cta")}
        </Link>
      </div>
    );
  }
  if (status.connected) {
    return (
      <div style={{ fontSize: 12, color: "var(--green-deep)", display: "inline-flex", alignItems: "center", gap: 5 }}>
        <IconCheck size={12} />
        {t("mcps.status.ok", { n: status.tools.length })}
        {status.tools.length > 0 && (
          <span style={{ color: "var(--muted-deep)", fontFamily: "var(--font-mono)", fontSize: 11 }}>
            {" "}
            · {status.tools.slice(0, 4).map((tool) => tool.name).join(", ")}
            {status.tools.length > 4 ? " …" : ""}
          </span>
        )}
      </div>
    );
  }
  return (
    <div style={{ fontSize: 12, color: "var(--red-deep)" }}>
      {t("mcps.status.error", { error: status.error ?? "unknown" })}
    </div>
  );
}

function Empty({ text }: { text: string }) {
  return (
    <div
      style={{
        padding: 32,
        textAlign: "center",
        color: "var(--muted-deep)",
        border: "1px dashed var(--paper-edge)",
        borderRadius: "var(--radius-md)",
        fontSize: 13,
      }}
    >
      {text}
    </div>
  );
}
