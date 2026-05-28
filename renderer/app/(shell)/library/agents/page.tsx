// 설치된 에이전트 라이브러리.
// 좌측: agentlas.cloud 계정 동기화(내 에이전트/팀 가져오기) + 설치된 에이전트 목록(선택 가능).
// 우측: 선택한 에이전트의 폴더 파일 목록 + 에디터 (AgentFilesPanel).
"use client";
import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { ipc } from "@/lib/ipc";
import { pickLocalized, useT } from "@/lib/i18n";
import type {
  AuthSession,
  FirmListing,
  InstalledAgent,
  MarketplaceListing,
  MarketplaceSourceStatus,
} from "@/lib/types";
import { AgentAvatar } from "@/components/AgentAvatar";
import { AgentFilesPanel } from "@/components/AgentFilesPanel";
import {
  IconBuilding,
  IconCheck,
  IconPlus,
  IconRefresh,
  IconSparkles,
  IconTrash,
} from "@/components/Icon";

export default function LibraryAgentsPage() {
  const { t, locale } = useT();
  const [agents, setAgents] = useState<InstalledAgent[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [panelOpen, setPanelOpen] = useState(true);

  // 클라우드(agentlas.cloud) 동기화 상태
  const [session, setSession] = useState<AuthSession>({ signedIn: false });
  const [status, setStatus] = useState<MarketplaceSourceStatus | null>(null);
  const [cloudAgents, setCloudAgents] = useState<MarketplaceListing[]>([]);
  const [cloudFirms, setCloudFirms] = useState<FirmListing[]>([]);
  const [installedFirmSlugs, setInstalledFirmSlugs] = useState<Set<string>>(new Set());
  const [importing, setImporting] = useState<string | null>(null);
  const [cloudLoading, setCloudLoading] = useState(false);

  const refresh = useCallback(async () => {
    const api = ipc();
    if (!api) return;
    const [list, sess, st] = await Promise.all([
      api.team.list(),
      api.auth.getSession(),
      api.marketplace.status(),
    ]);
    setAgents(list);
    setSession(sess);
    setStatus(st);
    setSelectedId((cur) => cur ?? list[0]?.id ?? null);

    if (sess.signedIn) {
      setCloudLoading(true);
      try {
        const [mine, firms, installedFirms] = await Promise.all([
          api.marketplace.listMine(),
          api.marketplace.listFirms(),
          api.firms.list(),
        ]);
        setCloudAgents(mine);
        setCloudFirms(firms);
        setInstalledFirmSlugs(new Set(installedFirms.map((f) => f.slug)));
      } finally {
        setCloudLoading(false);
      }
    } else {
      setCloudAgents([]);
      setCloudFirms([]);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function uninstall(id: string, name: string) {
    const api = ipc();
    if (!api) return;
    if (!confirm(t("library.agents.confirm_uninstall", { name }))) return;
    await api.team.uninstall(id);
    if (selectedId === id) setSelectedId(null);
    await refresh();
  }

  async function signIn() {
    const api = ipc();
    if (!api) return;
    const next = await api.auth.signInWithGoogle();
    setSession(next);
    if (next.signedIn) void refresh();
  }

  async function importAgent(slug: string) {
    const api = ipc();
    if (!api) return;
    setImporting(slug);
    try {
      await api.team.installMine(slug).catch(() => null);
      await refresh();
    } finally {
      setImporting(null);
    }
  }

  async function importFirm(slug: string) {
    const api = ipc();
    if (!api) return;
    setImporting(slug);
    try {
      await api.firms.install(slug).catch(() => null);
      await refresh();
    } finally {
      setImporting(null);
    }
  }

  const installedSlugs = new Set(agents.map((a) => a.slug));
  const importableAgents = cloudAgents.filter((a) => !installedSlugs.has(a.slug));
  const selectedAgent = agents.find((a) => a.id === selectedId) ?? null;

  return (
    <div style={{ height: "100%", display: "flex", minWidth: 0, minHeight: 0, overflow: "hidden" }}>
      <div style={{ flex: 1, minWidth: 0, overflowY: "auto" }}>
        <section style={{ padding: "24px 32px" }}>
          {/* 헤더 */}
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16, gap: 8 }}>
            <p style={{ margin: 0, color: "var(--muted-deep)", fontSize: 13, flex: 1, minWidth: 0 }}>
              {t("library.agents.subtitle")}
            </p>
            {!panelOpen && (
              <button
                onClick={() => setPanelOpen(true)}
                style={pillBtn}
              >
                {t("agentfiles.title")}
              </button>
            )}
            <Link href="/marketplace" style={{ ...pillBtn, background: "var(--accent)", color: "white", textDecoration: "none" }}>
              {t("library.agents.add")}
            </Link>
          </div>

          {/* agentlas.cloud 계정 동기화 */}
          <CloudSync
            session={session}
            status={status}
            loading={cloudLoading}
            importableAgents={importableAgents}
            cloudFirms={cloudFirms}
            installedFirmSlugs={installedFirmSlugs}
            importing={importing}
            locale={locale}
            t={t}
            onSignIn={signIn}
            onRefresh={refresh}
            onImportAgent={importAgent}
            onImportFirm={importFirm}
          />

          {/* 설치된 에이전트 목록 */}
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
                gridTemplateColumns: "repeat(auto-fill, minmax(260px, 1fr))",
                gap: 12,
              }}
            >
              {agents.map((a) => {
                const loc = pickLocalized(a, locale);
                const active = a.id === selectedId;
                return (
                  <article
                    key={a.id}
                    onClick={() => {
                      setSelectedId(a.id);
                      setPanelOpen(true);
                    }}
                    style={{
                      background: "var(--paper)",
                      border: active ? "1px solid var(--accent)" : "1px solid var(--paper-edge)",
                      boxShadow: active ? "0 0 0 1px var(--accent)" : "none",
                      borderRadius: "var(--radius-lg)",
                      padding: 16,
                      display: "flex",
                      flexDirection: "column",
                      gap: 10,
                      cursor: "pointer",
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
                        onClick={(e) => {
                          e.stopPropagation();
                          void uninstall(a.id, loc.name);
                        }}
                        aria-label={t("common.delete")}
                        title={t("common.delete")}
                        style={{ color: "var(--muted-deep)", padding: 4, background: "transparent", border: "none", cursor: "pointer" }}
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

      {panelOpen && (
        <AgentFilesPanel
          agentId={selectedId}
          agentName={selectedAgent ? pickLocalized(selectedAgent, locale).name : ""}
          onClose={() => setPanelOpen(false)}
        />
      )}
    </div>
  );
}

const pillBtn: React.CSSProperties = {
  padding: "8px 14px",
  fontSize: 12,
  fontWeight: 600,
  color: "var(--ink-soft)",
  background: "var(--paper-2)",
  border: "1px solid var(--paper-edge)",
  borderRadius: "var(--radius-md)",
  cursor: "pointer",
};

function CloudSync({
  session,
  status,
  loading,
  importableAgents,
  cloudFirms,
  installedFirmSlugs,
  importing,
  locale,
  t,
  onSignIn,
  onRefresh,
  onImportAgent,
  onImportFirm,
}: {
  session: AuthSession;
  status: MarketplaceSourceStatus | null;
  loading: boolean;
  importableAgents: MarketplaceListing[];
  cloudFirms: FirmListing[];
  installedFirmSlugs: Set<string>;
  importing: string | null;
  locale: "ko" | "en";
  t: ReturnType<typeof useT>["t"];
  onSignIn: () => void | Promise<void>;
  onRefresh: () => void | Promise<void>;
  onImportAgent: (slug: string) => void | Promise<void>;
  onImportFirm: (slug: string) => void | Promise<void>;
}) {
  const online = status?.mode === "mcp" && status.online && !status.usingFallback;
  const statusText = !status
    ? ""
    : status.mode === "memory"
    ? t("agents.cloud.status.memory")
    : online
    ? t("agents.cloud.status.online")
    : t("agents.cloud.status.offline");

  return (
    <div
      style={{
        marginBottom: 18,
        border: "1px solid var(--paper-edge)",
        borderRadius: "var(--radius-lg)",
        background: "var(--paper)",
        padding: 14,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: session.signedIn ? 10 : 4 }}>
        <span
          style={{
            width: 8,
            height: 8,
            borderRadius: "50%",
            background: online ? "var(--green-deep)" : "var(--paper-edge)",
            flexShrink: 0,
          }}
        />
        <strong style={{ fontSize: 13, fontFamily: "var(--font-head)", flex: 1 }}>
          {t("agents.cloud.title")}
        </strong>
        <span style={{ fontSize: 10.5, color: "var(--muted-deep)" }}>{statusText}</span>
        {session.signedIn && (
          <button onClick={() => void onRefresh()} aria-label={t("agents.cloud.refresh")} title={t("agents.cloud.refresh")} style={{ ...iconBtnSm }}>
            <IconRefresh size={13} />
          </button>
        )}
      </div>

      {!session.signedIn ? (
        <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
          <span style={{ fontSize: 12, color: "var(--muted-deep)", flex: 1, minWidth: 160 }}>
            {t("agents.cloud.signin_hint")}
          </span>
          <button
            onClick={() => void onSignIn()}
            style={{ ...pillBtn, background: "var(--accent)", color: "white" }}
          >
            {t("account.sign_in")}
          </button>
        </div>
      ) : loading ? (
        <div style={{ fontSize: 12, color: "var(--muted-deep)", padding: "6px 0" }}>{t("import.loading")}</div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          {/* 내 에이전트 */}
          <div>
            <SectionLabel icon={<IconSparkles size={11} />} text={t("agents.cloud.section_agents")} />
            {importableAgents.length === 0 ? (
              <EmptyMini>{t("agents.cloud.empty_agents")}</EmptyMini>
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                {importableAgents.map((a) => {
                  const loc = pickLocalized(a, locale);
                  return (
                    <CloudRow
                      key={a.slug}
                      title={loc.name}
                      subtitle={loc.tagline}
                      icon={<IconSparkles size={13} style={{ color: "var(--accent)" }} />}
                      busy={importing === a.slug}
                      label={t("agents.cloud.import")}
                      onClick={() => void onImportAgent(a.slug)}
                    />
                  );
                })}
              </div>
            )}
          </div>

          {/* 팀(회사) */}
          <div>
            <SectionLabel icon={<IconBuilding size={11} />} text={t("agents.cloud.section_teams")} />
            {cloudFirms.length === 0 ? (
              <EmptyMini>{t("agents.cloud.empty_teams")}</EmptyMini>
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                {cloudFirms.map((f) => {
                  const loc = pickLocalized(f, locale);
                  const already = installedFirmSlugs.has(f.slug);
                  return (
                    <CloudRow
                      key={f.slug}
                      title={loc.name}
                      subtitle={loc.tagline}
                      icon={<IconBuilding size={13} style={{ color: "var(--accent)" }} />}
                      busy={importing === f.slug}
                      installed={already}
                      label={already ? t("import.installed") : t("agents.cloud.import")}
                      onClick={() => void onImportFirm(f.slug)}
                    />
                  );
                })}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function CloudRow({
  title,
  subtitle,
  icon,
  busy,
  installed,
  label,
  onClick,
}: {
  title: string;
  subtitle: string;
  icon: React.ReactNode;
  busy: boolean;
  installed?: boolean;
  label: string;
  onClick: () => void;
}) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 10,
        padding: "8px 10px",
        borderRadius: "var(--radius-md)",
        background: "var(--paper-2)",
        border: "1px solid var(--paper-edge)",
      }}
    >
      <span style={{ flexShrink: 0, display: "inline-flex" }}>{icon}</span>
      <span style={{ flex: 1, minWidth: 0 }}>
        <span style={{ display: "block", fontSize: 12.5, fontWeight: 600, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
          {title}
        </span>
        <span style={{ display: "block", fontSize: 11, color: "var(--muted-deep)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
          {subtitle}
        </span>
      </span>
      {installed ? (
        <span style={{ fontSize: 11, color: "var(--green-deep)", fontWeight: 600, display: "inline-flex", alignItems: "center", gap: 3, flexShrink: 0 }}>
          <IconCheck size={12} /> {label}
        </span>
      ) : (
        <button
          onClick={onClick}
          disabled={busy}
          style={{
            flexShrink: 0,
            padding: "4px 12px",
            borderRadius: 999,
            fontSize: 11.5,
            fontWeight: 600,
            background: "var(--accent)",
            color: "white",
            border: "none",
            display: "inline-flex",
            alignItems: "center",
            gap: 4,
          }}
        >
          <IconPlus size={11} />
          {busy ? t_busy(label) : label}
        </button>
      )}
    </div>
  );
}

// busy 표시는 라벨 그대로 두되 살짝 흐리게 — 별도 문구 없이 단순화
function t_busy(label: string): string {
  return label + "…";
}

function SectionLabel({ icon, text }: { icon: React.ReactNode; text: string }) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 6,
        fontSize: 10,
        fontFamily: "var(--font-mono)",
        textTransform: "uppercase",
        letterSpacing: 0.6,
        color: "var(--muted-deep)",
        marginBottom: 6,
      }}
    >
      {icon}
      {text}
    </div>
  );
}

function EmptyMini({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ fontSize: 11.5, color: "var(--muted)", padding: "4px 2px" }}>{children}</div>
  );
}

const iconBtnSm: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  padding: 5,
  borderRadius: 8,
  color: "var(--muted-deep)",
  background: "transparent",
  border: "1px solid var(--paper-edge)",
  cursor: "pointer",
};
