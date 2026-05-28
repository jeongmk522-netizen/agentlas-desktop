// 우측 슬라이드 패널 — Claude Code 스타일 artifact viewer.
// 코드 블록 미리보기 + 라인 넘버 + 복사 + 닫기.
"use client";
import type { CodeArtifact } from "./Markdown";
import { useT } from "@/lib/i18n";

export function ArtifactPanel({
  artifact,
  onClose,
}: {
  artifact: CodeArtifact | null;
  onClose: () => void;
}) {
  const { t } = useT();
  if (!artifact) return null;
  const lines = artifact.code.split("\n");
  const lineNumWidth = String(lines.length).length;

  return (
    <aside
      style={{
        width: 480,
        flexShrink: 0,
        height: "100%",
        background: "#1c1a17",
        borderLeft: "1px solid var(--paper-edge)",
        display: "flex",
        flexDirection: "column",
        overflow: "hidden",
        animation: "slide-in 0.18s ease",
      }}
    >
      <style>{`
        @keyframes slide-in {
          from { transform: translateX(20px); opacity: 0; }
          to { transform: translateX(0); opacity: 1; }
        }
      `}</style>
      <header
        style={{
          padding: "10px 16px",
          display: "flex",
          alignItems: "center",
          gap: 10,
          background: "rgba(255,255,255,0.04)",
          borderBottom: "1px solid rgba(255,255,255,0.08)",
          minHeight: 44,
        }}
      >
        <span
          style={{
            fontSize: 10,
            fontFamily: "var(--font-mono)",
            color: "white",
            background: "var(--accent)",
            padding: "2px 8px",
            borderRadius: 999,
            textTransform: "uppercase",
            letterSpacing: 0.6,
            fontWeight: 700,
          }}
        >
          {artifact.language}
        </span>
        <span style={{ fontSize: 11, color: "#a1a1aa" }}>{t("chatstream.lines", { count: lines.length })}</span>
        <div style={{ flex: 1 }} />
        <button
          onClick={() => void navigator.clipboard.writeText(artifact.code)}
          style={{
            fontSize: 11,
            padding: "4px 12px",
            borderRadius: 999,
            background: "rgba(255,255,255,0.08)",
            color: "white",
            border: "none",
            fontWeight: 600,
          }}
        >
          {t("chatstream.copy")}
        </button>
        <button
          onClick={onClose}
          aria-label={t("chatstream.close_panel")}
          title={t("chatstream.close")}
          style={{
            width: 28,
            height: 28,
            borderRadius: 8,
            background: "transparent",
            color: "#a1a1aa",
            border: "none",
            fontSize: 16,
            fontWeight: 600,
          }}
        >
          ✕
        </button>
      </header>
      <pre
        style={{
          flex: 1,
          margin: 0,
          padding: "16px 0",
          overflow: "auto",
          fontFamily: "var(--font-mono)",
          fontSize: 12.5,
          lineHeight: 1.6,
          color: "#fafafa",
          background: "#1c1a17",
        }}
      >
        {lines.map((line, i) => (
          <div
            key={i}
            style={{
              display: "flex",
              gap: 16,
              padding: "0 16px",
            }}
          >
            <span
              style={{
                color: "#52525b",
                fontVariantNumeric: "tabular-nums",
                userSelect: "none",
                minWidth: lineNumWidth * 9,
                textAlign: "right",
              }}
            >
              {i + 1}
            </span>
            <span style={{ whiteSpace: "pre", flex: 1 }}>{line || " "}</span>
          </div>
        ))}
      </pre>
    </aside>
  );
}
