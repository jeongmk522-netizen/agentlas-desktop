// MCP 서버 라이브러리 — 설치된 에이전트의 mcpServers 집합.
"use client";
import { useEffect, useMemo, useState } from "react";
import { ipc } from "@/lib/ipc";
import { useT } from "@/lib/i18n";
import type { InstalledAgent } from "@/lib/types";

interface McpRow {
  name: string;
  usedBy: string[]; // 이 MCP를 쓰는 에이전트 이름들
}

export default function LibraryMcpsPage() {
  const { t } = useT();
  const [agents, setAgents] = useState<InstalledAgent[]>([]);

  useEffect(() => {
    const api = ipc();
    if (!api) return;
    void api.team.list().then(setAgents);
  }, []);

  const rows = useMemo<McpRow[]>(() => {
    const map = new Map<string, Set<string>>();
    for (const a of agents) {
      for (const m of a.mcpServers) {
        if (!map.has(m)) map.set(m, new Set());
        map.get(m)!.add(a.name);
      }
    }
    return [...map.entries()].map(([name, set]) => ({ name, usedBy: [...set] }));
  }, [agents]);

  return (
    <section style={{ padding: "24px 32px", maxWidth: 880, margin: "0 auto" }}>
      <p style={{ margin: 0, color: "var(--muted-deep)", fontSize: 13, marginBottom: 16 }}>
        {t("library.mcps.desc")}
      </p>

      {rows.length === 0 ? (
        <div
          style={{
            padding: 32,
            textAlign: "center",
            color: "var(--muted-deep)",
            border: "1px dashed var(--paper-edge)",
            borderRadius: "var(--radius-md)",
          }}
        >
          {t("library.mcps.empty")}
        </div>
      ) : (
        <ul style={{ listStyle: "none", padding: 0, margin: 0, display: "flex", flexDirection: "column", gap: 8 }}>
          {rows.map((row) => (
            <li
              key={row.name}
              style={{
                background: "var(--paper)",
                border: "1px solid var(--paper-edge)",
                borderRadius: "var(--radius-md)",
                padding: "12px 16px",
                display: "flex",
                alignItems: "center",
                gap: 12,
              }}
            >
              <code
                style={{
                  flex: 1,
                  fontFamily: "var(--font-mono)",
                  fontSize: 12,
                  color: "var(--ink)",
                  background: "transparent",
                }}
              >
                {row.name}
              </code>
              <span
                style={{
                  fontSize: 10,
                  color: "var(--muted-deep)",
                  background: "var(--paper-2)",
                  padding: "2px 8px",
                  borderRadius: 999,
                }}
              >
                M0 stub
              </span>
              <span style={{ fontSize: 11, color: "var(--muted-deep)" }}>
                {t("library.mcps.used_by", { n: row.usedBy.length })}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
