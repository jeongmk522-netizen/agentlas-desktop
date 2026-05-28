// 회사 상세 — 헤더(이름·CEO 채팅 버튼) + 조직도 시각화 + 회사 내 채팅 목록.
"use client";
import { Suspense, useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { ipc } from "@/lib/ipc";
import { pickLocalized, useT, type Locale } from "@/lib/i18n";
import { navigate } from "@/lib/navigation";
import type { Chat, InstalledAgent, InstalledFirm } from "@/lib/types";
import { AgentAvatar } from "@/components/AgentAvatar";
import { IconBuilding, IconChat, IconPlus, IconTrash, IconUsers } from "@/components/Icon";

export default function FirmDetailWrapper() {
  return (
    <Suspense fallback={null}>
      <FirmDetailPage />
    </Suspense>
  );
}

function FirmDetailPage() {
  const searchParams = useSearchParams();
  const id = searchParams.get("id") ?? "";
  const { t, locale } = useT();
  const [firm, setFirm] = useState<InstalledFirm | null>(null);
  const [agents, setAgents] = useState<InstalledAgent[]>([]);
  const [chats, setChats] = useState<Chat[]>([]);

  const refresh = useCallback(async () => {
    const api = ipc();
    if (!api || !id) return;
    const [f, ag, cs] = await Promise.all([
      api.firms.get(id),
      api.team.list(),
      api.chats.listByFirm(id),
    ]);
    if (!f) {
      navigate("/marketplace?tab=firms", "replace");
      return;
    }
    setFirm(f);
    setAgents(ag);
    setChats(cs);
  }, [id]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function startCeoChat() {
    const api = ipc();
    if (!api || !firm) return;
    const chat = await api.chats.create({ firmId: firm.id });
    navigate(`/chat?id=${chat.id}`);
  }

  async function uninstall() {
    const api = ipc();
    if (!api || !firm) return;
    if (!confirm(t("firm.confirm_uninstall", { name: pickLocalized(firm, locale).name }))) return;
    await api.firms.uninstall(firm.id);
    navigate("/marketplace?tab=firms", "replace");
  }

  if (!firm) return null;
  const agentMap = new Map(agents.map((a) => [a.id, a]));
  const firmLoc = pickLocalized(firm, locale);

  return (
    <div style={{ flex: 1, background: "var(--paper-2)", overflowY: "auto" }}>
      <header
        className="titlebar-drag"
        style={{
          padding: "16px 32px",
          minHeight: 56,
          borderBottom: "var(--hairline)",
          background: "var(--paper)",
          display: "flex",
          alignItems: "center",
          gap: 12,
        }}
      >
        <span
          style={{
            width: 36,
            height: 36,
            borderRadius: 10,
            background: "var(--fill-1)",
            color: "var(--accent)",
            display: "inline-flex",
            alignItems: "center",
            justifyContent: "center",
            flexShrink: 0,
          }}
        >
          <IconBuilding size={18} />
        </span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div
            style={{
              fontSize: 10,
              color: "var(--muted-deep)",
              textTransform: "uppercase",
              letterSpacing: 0.6,
              fontFamily: "var(--font-mono)",
            }}
          >
            {t("firm.kind")} · {firm.persona}
          </div>
          <h1
            style={{
              margin: 0,
              fontFamily: "var(--font-head)",
              fontSize: 18,
              fontWeight: 700,
              whiteSpace: "nowrap",
              overflow: "hidden",
              textOverflow: "ellipsis",
            }}
          >
            {firmLoc.name}
          </h1>
        </div>
        <button
          onClick={() => void startCeoChat()}
          className="titlebar-nodrag"
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 6,
            padding: "9px 16px",
            borderRadius: 999,
            background: "var(--accent)",
            color: "white",
            fontWeight: 600,
            fontSize: 13,
            border: "none",
            boxShadow: "var(--shadow-1)",
          }}
        >
          <IconChat size={14} />
          {t("firm.ceo.command")}
        </button>
        <button
          onClick={() => void uninstall()}
          className="titlebar-nodrag"
          aria-label={t("common.delete")}
          style={{ color: "var(--muted-deep)", padding: 6 }}
        >
          <IconTrash size={16} />
        </button>
      </header>

      <section
        className="titlebar-nodrag"
        style={{ maxWidth: 960, margin: "24px auto", padding: "0 24px" }}
      >
        <p style={{ margin: "0 0 24px", fontSize: 14, color: "var(--ink-soft)" }}>
          {firmLoc.tagline}
        </p>

        {/* 조직도 */}
        <h2 style={{ fontFamily: "var(--font-head)", fontSize: 15, margin: "0 0 12px" }}>
          <IconUsers size={14} style={{ marginRight: 6, verticalAlign: -2 }} />
          {t("firm.section.orgchart")}
        </h2>
        <OrgChart firm={firm} agentMap={agentMap} locale={locale} />

        {/* 회사 채팅 목록 */}
        <h2 style={{ fontFamily: "var(--font-head)", fontSize: 15, margin: "32px 0 12px" }}>
          {t("firm.section.chats")} ({chats.length})
        </h2>
        {chats.length === 0 ? (
          <div
            style={{
              padding: 24,
              border: "1px dashed var(--paper-edge)",
              borderRadius: "var(--radius-md)",
              color: "var(--muted-deep)",
              textAlign: "center",
              fontSize: 13,
            }}
          >
            {t("firm.empty_chats")}
          </div>
        ) : (
          <ul style={{ listStyle: "none", padding: 0, margin: 0, display: "flex", flexDirection: "column", gap: 6 }}>
            {chats.map((c) => (
              <li key={c.id}>
                <Link
                  href={`/chat?id=${c.id}`}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 12,
                    padding: "10px 14px",
                    border: "1px solid var(--paper-edge)",
                    borderRadius: "var(--radius-md)",
                    background: "var(--paper)",
                    textDecoration: "none",
                    color: "var(--ink)",
                  }}
                >
                  <span style={{ flex: 1, fontWeight: 500, fontSize: 13 }}>
                    {c.title.trim() || t("chat.untitled")}
                  </span>
                  <span style={{ fontSize: 10, color: "var(--muted)" }}>
                    {new Date(c.updatedAt).toLocaleString("ko-KR", {
                      month: "numeric",
                      day: "numeric",
                      hour: "numeric",
                      minute: "numeric",
                    })}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

// ── 조직도: reportsTo 트리 재귀 렌더 ────────────────────────
function OrgChart({
  firm,
  agentMap,
  locale,
}: {
  firm: InstalledFirm;
  agentMap: Map<string, InstalledAgent>;
  locale: Locale;
}) {
  // CEO부터 트리 BFS
  const ceo = firm.orgChart.find((n) => n.reportsTo === null);
  if (!ceo) return <div>조직도가 비어있습니다.</div>;

  function children(parentSlug: string) {
    return firm.orgChart.filter((n) => n.reportsTo === parentSlug);
  }

  function renderNode(node: typeof firm.orgChart[number], depth: number): React.ReactNode {
    const agent = agentMap.get(node.agentId);
    const agentLoc = agent ? pickLocalized(agent, locale) : null;
    const kids = children(node.agentSlug);
    const isCeo = node.reportsTo === null;
    return (
      <div key={node.agentId} style={{ marginTop: depth === 0 ? 0 : 8 }}>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 12,
            padding: "10px 14px",
            background: isCeo ? "var(--fill-1)" : "var(--paper)",
            border: isCeo ? "1px solid var(--accent-soft)" : "1px solid var(--paper-edge)",
            borderRadius: "var(--radius-md)",
          }}
        >
          {agent && agentLoc && <AgentAvatar name={agentLoc.name} tone={agent.tone} size={32} />}
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <strong style={{ fontSize: 13 }}>{agentLoc?.name ?? "(missing)"}</strong>
              <span
                style={{
                  fontSize: 10,
                  padding: "2px 8px",
                  borderRadius: 999,
                  background: isCeo ? "var(--accent)" : "var(--paper-2)",
                  color: isCeo ? "white" : "var(--ink-soft)",
                  fontWeight: 600,
                }}
              >
                {node.role}
              </span>
            </div>
            {agentLoc && (
              <div style={{ fontSize: 11, color: "var(--muted-deep)", marginTop: 2 }}>
                {agentLoc.tagline}
              </div>
            )}
          </div>
        </div>
        {kids.length > 0 && (
          <div
            style={{
              marginLeft: 28,
              paddingLeft: 14,
              borderLeft: "1px dashed var(--paper-edge)",
              marginTop: 6,
            }}
          >
            {kids.map((k) => renderNode(k, depth + 1))}
          </div>
        )}
      </div>
    );
  }

  return renderNode(ceo, 0);
}
