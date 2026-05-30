// 큐레이션 팀 번들 카드 — 마켓플레이스/온보딩에서 사용.
"use client";
import type { TeamBundle } from "@/lib/types";
import { AgentAvatar } from "./AgentAvatar";
import { useT } from "@/lib/i18n";

export function BundleCard({
  bundle,
  onInstall,
  installing,
}: {
  bundle: TeamBundle;
  onInstall: (bundle: TeamBundle) => void;
  installing?: boolean;
}) {
  const { t } = useT();
  return (
    <article
      style={{
        border: "1px solid var(--paper-edge)",
        borderRadius: "var(--radius-lg)",
        padding: 16,
        background: "var(--paper)",
        display: "flex",
        flexDirection: "column",
        gap: 12,
        boxShadow: "var(--shadow-1)",
      }}
    >
      <header style={{ display: "flex", flexDirection: "column", gap: 4 }}>
        <span
          style={{
            fontSize: 10,
            fontFamily: "var(--font-mono)",
            color: "var(--accent)",
            background: "var(--accent-soft)",
            padding: "2px 8px",
            borderRadius: 999,
            alignSelf: "flex-start",
          }}
        >
          {bundle.persona}
        </span>
        <h3
          style={{
            margin: 0,
            fontFamily: "var(--font-head)",
            fontSize: 16,
            fontWeight: 700,
            color: "var(--ink)",
          }}
        >
          {bundle.name}
        </h3>
        <p style={{ margin: 0, fontSize: 13, color: "var(--muted-deep)" }}>
          {bundle.tagline}
        </p>
      </header>

      <ul
        style={{
          listStyle: "none",
          padding: 0,
          margin: 0,
          display: "flex",
          flexDirection: "column",
          gap: 6,
        }}
      >
        {bundle.agents.map((a) => (
          <li
            key={a.slug}
            style={{
              display: "flex",
              gap: 8,
              alignItems: "center",
              fontSize: 12,
              color: "var(--ink-soft)",
              minWidth: 0,
            }}
          >
            <AgentAvatar name={a.name} tone={a.tone} size={22} />
            <span style={{ fontWeight: 600, flexShrink: 0 }}>{a.name}</span>
            <span style={{ color: "var(--muted-deep)", flex: 1, minWidth: 0, overflowWrap: "anywhere" }}>
              — {a.tagline}
            </span>
          </li>
        ))}
      </ul>

      <button
        onClick={() => onInstall(bundle)}
        disabled={installing}
        style={{
          marginTop: "auto",
          padding: "10px 16px",
          borderRadius: "var(--radius-md)",
          background: installing ? "var(--paper-2)" : "var(--paper)",
          color: installing ? "var(--muted-deep)" : "var(--ink)",
          fontWeight: 600,
          fontSize: 13,
          border: "1px solid var(--paper-edge)",
          boxShadow: installing ? "none" : "var(--neu-raised)",
        }}
      >
        {installing ? t("generic.installing") : t("market.bundle.install")}
      </button>
    </article>
  );
}
