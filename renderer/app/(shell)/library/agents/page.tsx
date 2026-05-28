// 설치된 에이전트 라이브러리.
"use client";
import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { ipc } from "@/lib/ipc";
import { pickLocalized, useT } from "@/lib/i18n";
import { localFolderPersistence } from "@/lib/repo-persistence";
import type { InstalledAgent } from "@/lib/types";
import { AgentAvatar } from "@/components/AgentAvatar";
import { WorkspacePanel } from "@/components/WorkspacePanel";
import { IconFolder, IconTrash } from "@/components/Icon";

export default function LibraryAgentsPage() {
  const { t, locale } = useT();
  const [agents, setAgents] = useState<InstalledAgent[]>([]);
  // 우측 레포/폴더 트리 패널 — 이 화면용 폴더를 localStorage에 기억.
  const [repoOpen, setRepoOpen] = useState(true);
  const repoPersistence = useMemo(() => localFolderPersistence("library-agents"), []);

  async function refresh() {
    const api = ipc();
    if (!api) return;
    setAgents(await api.team.list());
  }
  useEffect(() => {
    void refresh();
  }, []);

  async function uninstall(id: string, name: string) {
    const api = ipc();
    if (!api) return;
    if (!confirm(t("library.agents.confirm_uninstall", { name }))) return;
    await api.team.uninstall(id);
    await refresh();
  }

  return (
    <div style={{ height: "100%", display: "flex", minWidth: 0, minHeight: 0, overflow: "hidden" }}>
      <div style={{ flex: 1, minWidth: 0, overflowY: "auto" }}>
    <section style={{ padding: "24px 32px" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16, gap: 8 }}>
        <p style={{ margin: 0, color: "var(--muted-deep)", fontSize: 13, flex: 1, minWidth: 0 }}>
          {t("library.agents.subtitle")}
        </p>
        <button
          onClick={() => setRepoOpen((v) => !v)}
          aria-label={t("workspace.title")}
          title={t("workspace.title")}
          style={{
            color: repoOpen ? "var(--accent)" : "var(--muted-deep)",
            background: repoOpen ? "var(--fill-1)" : "transparent",
            padding: 7,
            borderRadius: "var(--radius-md)",
            border: "none",
            cursor: "pointer",
            display: "inline-flex",
          }}
        >
          <IconFolder size={16} />
        </button>
        <Link
          href="/marketplace"
          style={{
            padding: "8px 14px",
            fontSize: 12,
            fontWeight: 600,
            color: "white",
            background: "var(--accent)",
            borderRadius: "var(--radius-md)",
            textDecoration: "none",
          }}
        >
          {t("library.agents.add")}
        </Link>
      </div>

      {agents.length === 0 ? (
        <div
          style={{
            padding: 40,
            textAlign: "center",
            color: "var(--muted-deep)",
            border: "1px dashed var(--paper-edge)",
            borderRadius: "var(--radius-md)",
          }}
        >
          {t("library.agents.empty")}{" "}
          <Link href="/marketplace" style={{ color: "var(--accent)", fontWeight: 600 }}>
            {t("sidebar.marketplace")}
          </Link>
        </div>
      ) : (
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))",
            gap: 12,
          }}
        >
          {agents.map((a) => {
            const loc = pickLocalized(a, locale);
            return (
              <article
                key={a.id}
                style={{
                  background: "var(--paper)",
                  border: "1px solid var(--paper-edge)",
                  borderRadius: "var(--radius-lg)",
                  padding: 16,
                  display: "flex",
                  flexDirection: "column",
                  gap: 10,
                }}
              >
                <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                  <AgentAvatar name={loc.name} tone={a.tone} size={32} />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontFamily: "var(--font-head)", fontSize: 14, fontWeight: 600 }}>
                      {loc.name}
                    </div>
                    <div style={{ fontSize: 11, color: "var(--muted-deep)" }}>
                      Trust {a.trustGrade} · {a.mcpServers.length} MCP
                    </div>
                  </div>
                  <button
                    onClick={() => void uninstall(a.id, loc.name)}
                    aria-label={t("common.delete")}
                    title={t("common.delete")}
                    style={{ color: "var(--muted-deep)", padding: 4 }}
                  >
                    <IconTrash size={14} />
                  </button>
                </div>
                <p style={{ margin: 0, fontSize: 12, color: "var(--ink-soft)", lineHeight: 1.5 }}>
                  {loc.tagline}
                </p>
              </article>
            );
          })}
        </div>
      )}
    </section>
      </div>
      {repoOpen && (
        <WorkspacePanel chatId="library-agents" persistence={repoPersistence} onClose={() => setRepoOpen(false)} />
      )}
    </div>
  );
}
