// 로그인 후 로컬 에이전트가 없을 때 뜨는 "내 에이전트/팀 가져오기" 팝업 (요청 ①+③).
// agentlas.cloud에서 만든 내 에이전트(cargo) + 팀(firm)을 골라서 한 번에 가져온다.
"use client";
import { useCallback, useEffect, useState } from "react";
import { ipc } from "@/lib/ipc";
import { pickLocalized, useT } from "@/lib/i18n";
import type { FirmListing, MarketplaceListing } from "@/lib/types";
import { IconCheck, IconClose, IconSparkles, IconBuilding } from "@/components/Icon";

const BUILD_URL = "https://agentlas.cloud/build";

export function ImportAgentsModal({
  open,
  onClose,
  onImported,
}: {
  open: boolean;
  onClose: () => void;
  onImported: () => void | Promise<void>;
}) {
  const { t, locale } = useT();
  const [signedIn, setSignedIn] = useState<boolean | null>(null);
  const [loading, setLoading] = useState(true);
  const [myAgents, setMyAgents] = useState<MarketplaceListing[]>([]);
  const [firms, setFirms] = useState<FirmListing[]>([]);
  const [installedFirmSlugs, setInstalledFirmSlugs] = useState<Set<string>>(new Set());
  const [selAgents, setSelAgents] = useState<Set<string>>(new Set());
  const [selFirms, setSelFirms] = useState<Set<string>>(new Set());
  const [importing, setImporting] = useState(false);

  const load = useCallback(async () => {
    const api = ipc();
    if (!api) return;
    setLoading(true);
    try {
      const session = await api.auth.getSession();
      setSignedIn(session.signedIn);
      if (!session.signedIn) {
        setMyAgents([]);
        setFirms([]);
        return;
      }
      const [mine, allFirms, installedFirms] = await Promise.all([
        api.marketplace.listMine(),
        api.marketplace.listFirms(),
        api.firms.list(),
      ]);
      setMyAgents(mine);
      setFirms(allFirms);
      setInstalledFirmSlugs(new Set(installedFirms.map((f) => f.slug)));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (open) void load();
  }, [open, load]);

  async function signIn() {
    const api = ipc();
    if (!api) return;
    const next = await api.auth.signInWithGoogle();
    setSignedIn(next.signedIn);
    if (next.signedIn) void load();
  }

  function toggle(set: Set<string>, key: string, setter: (s: Set<string>) => void) {
    const next = new Set(set);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    setter(next);
  }

  const totalSelected = selAgents.size + selFirms.size;

  async function importSelected() {
    const api = ipc();
    if (!api || totalSelected === 0) return;
    setImporting(true);
    try {
      for (const slug of selAgents) {
        await api.team.installMine(slug).catch(() => null);
      }
      for (const slug of selFirms) {
        await api.firms.install(slug).catch(() => null);
      }
      await onImported();
      onClose();
    } finally {
      setImporting(false);
    }
  }

  if (!open) return null;

  return (
    <div
      role="dialog"
      aria-modal
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 200,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: "rgba(11,11,15,0.32)",
        backdropFilter: "blur(2px)",
      }}
      onClick={onClose}
    >
      <div
        className="glass-lift"
        onClick={(e) => e.stopPropagation()}
        style={{
          width: "min(560px, 92vw)",
          maxHeight: "82vh",
          display: "flex",
          flexDirection: "column",
          borderRadius: "var(--radius-xl)",
          background: "var(--paper)",
          border: "1px solid var(--glass-border)",
          boxShadow: "0 20px 60px rgba(11,11,15,0.24)",
          overflow: "hidden",
        }}
      >
        <header style={{ padding: "18px 20px 12px", borderBottom: "1px solid var(--paper-edge)" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <h2 style={{ margin: 0, fontFamily: "var(--font-head)", fontSize: 17, fontWeight: 700, flex: 1 }}>
              {t("import.title")}
            </h2>
            <button
              onClick={onClose}
              aria-label={t("import.skip")}
              style={{ color: "var(--muted-deep)", background: "transparent", border: "none", padding: 4 }}
            >
              <IconClose size={16} />
            </button>
          </div>
          <p style={{ margin: "6px 0 0", fontSize: 12.5, color: "var(--muted-deep)", lineHeight: 1.5 }}>
            {t("import.subtitle")}
          </p>
        </header>

        <div style={{ flex: 1, overflowY: "auto", padding: "14px 20px" }}>
          {loading ? (
            <div style={{ padding: 24, textAlign: "center", color: "var(--muted-deep)", fontSize: 13 }}>
              {t("import.loading")}
            </div>
          ) : signedIn === false ? (
            <div style={{ padding: "20px 8px", textAlign: "center" }}>
              <p style={{ fontSize: 13, color: "var(--ink-soft)", marginBottom: 14 }}>
                {t("import.signin_needed")}
              </p>
              <button
                onClick={() => void signIn()}
                style={{
                  padding: "9px 18px",
                  borderRadius: 999,
                  background: "var(--paper)",
                  color: "var(--ink)",
                  fontWeight: 600,
                  fontSize: 13,
                  border: "1px solid var(--paper-edge)",
                  boxShadow: "var(--neu-raised)",
                }}
              >
                {t("account.sign_in")}
              </button>
            </div>
          ) : (
            <>
              <SectionLabel icon={<IconSparkles size={12} />} text={t("import.section.agents")} />
              {myAgents.length === 0 ? (
                <EmptyRow>
                  {t("import.empty_agents")}{" "}
                  <a href={BUILD_URL} target="_blank" rel="noreferrer" style={{ color: "var(--accent)", fontWeight: 600 }}>
                    {t("import.build_link")}
                  </a>
                </EmptyRow>
              ) : (
                myAgents.map((a) => {
                  const loc = pickLocalized(a, locale);
                  return (
                    <SelectRow
                      key={a.slug}
                      checked={selAgents.has(a.slug)}
                      onToggle={() => toggle(selAgents, a.slug, setSelAgents)}
                      title={loc.name}
                      subtitle={loc.tagline}
                      icon={<IconSparkles size={14} style={{ color: "var(--accent)" }} />}
                    />
                  );
                })
              )}

              <div style={{ height: 14 }} />
              <SectionLabel icon={<IconBuilding size={12} />} text={t("import.section.teams")} />
              {firms.length === 0 ? (
                <EmptyRow>{t("import.empty_teams")}</EmptyRow>
              ) : (
                firms.map((f) => {
                  const loc = pickLocalized(f, locale);
                  const already = installedFirmSlugs.has(f.slug);
                  return (
                    <SelectRow
                      key={f.slug}
                      checked={already || selFirms.has(f.slug)}
                      disabled={already}
                      installedLabel={already ? t("import.installed") : undefined}
                      onToggle={() => toggle(selFirms, f.slug, setSelFirms)}
                      title={loc.name}
                      subtitle={loc.tagline}
                      icon={<IconBuilding size={14} style={{ color: "var(--accent)" }} />}
                    />
                  );
                })
              )}
            </>
          )}
        </div>

        {signedIn && !loading && (
          <footer
            style={{
              padding: "12px 20px",
              borderTop: "1px solid var(--paper-edge)",
              display: "flex",
              alignItems: "center",
              gap: 10,
            }}
          >
            <button
              onClick={onClose}
              style={{
                fontSize: 12.5,
                color: "var(--muted-deep)",
                background: "transparent",
                border: "1px solid var(--paper-edge)",
                borderRadius: 999,
                padding: "8px 14px",
              }}
            >
              {t("import.skip")}
            </button>
            <div style={{ flex: 1 }} />
            <button
              onClick={() => void importSelected()}
              disabled={totalSelected === 0 || importing}
              style={{
                fontSize: 13,
                fontWeight: 600,
                padding: "8px 18px",
                borderRadius: 999,
                background: totalSelected > 0 ? "var(--paper)" : "var(--paper-2)",
                color: totalSelected > 0 ? "var(--ink)" : "var(--muted-deep)",
                border: "1px solid var(--paper-edge)",
                boxShadow: totalSelected > 0 ? "var(--neu-raised)" : "none",
              }}
            >
              {importing ? t("import.importing") : t("import.import_selected", { n: totalSelected })}
            </button>
          </footer>
        )}
      </div>
    </div>
  );
}

function SectionLabel({ icon, text }: { icon: React.ReactNode; text: string }) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 6,
        fontSize: 10.5,
        fontFamily: "var(--font-mono)",
        textTransform: "uppercase",
        letterSpacing: 0.6,
        color: "var(--muted-deep)",
        marginBottom: 8,
      }}
    >
      {icon}
      {text}
    </div>
  );
}

function EmptyRow({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        padding: "14px 12px",
        fontSize: 12.5,
        color: "var(--muted-deep)",
        border: "1px dashed var(--paper-edge)",
        borderRadius: "var(--radius-md)",
        lineHeight: 1.5,
      }}
    >
      {children}
    </div>
  );
}

function SelectRow({
  checked,
  disabled,
  installedLabel,
  onToggle,
  title,
  subtitle,
  icon,
}: {
  checked: boolean;
  disabled?: boolean;
  installedLabel?: string;
  onToggle: () => void;
  title: string;
  subtitle: string;
  icon: React.ReactNode;
}) {
  return (
    <button
      onClick={disabled ? undefined : onToggle}
      disabled={disabled}
      style={{
        width: "100%",
        textAlign: "left",
        display: "flex",
        alignItems: "center",
        gap: 10,
        padding: "10px 12px",
        marginBottom: 6,
        borderRadius: "var(--radius-md)",
        background: checked && !disabled ? "var(--fill-1)" : "var(--paper-2)",
        border: checked && !disabled ? "1px solid var(--accent)" : "1px solid var(--paper-edge)",
        cursor: disabled ? "default" : "pointer",
        opacity: disabled ? 0.6 : 1,
      }}
    >
      <span
        style={{
          width: 20,
          height: 20,
          borderRadius: 6,
          flexShrink: 0,
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          background: checked ? "var(--accent)" : "transparent",
          border: checked ? "none" : "1.5px solid var(--paper-edge)",
          color: "white",
        }}
      >
        {checked && <IconCheck size={13} />}
      </span>
      <span style={{ width: 26, display: "inline-flex", justifyContent: "center", flexShrink: 0 }}>{icon}</span>
      <span style={{ flex: 1, minWidth: 0 }}>
        <span style={{ display: "block", fontSize: 13, fontWeight: 600, color: "var(--ink)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
          {title}
        </span>
        <span style={{ display: "block", fontSize: 11.5, color: "var(--muted-deep)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
          {subtitle}
        </span>
      </span>
      {installedLabel && (
        <span style={{ fontSize: 11, color: "var(--green-deep)", fontWeight: 600, flexShrink: 0 }}>
          {installedLabel}
        </span>
      )}
    </button>
  );
}
