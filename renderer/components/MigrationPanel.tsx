// 설정 > 마이그레이션 — OpenClaw / Hermes에서 가져오기.
// scan으로 디스크 preview(이름/개수만)를 받고, import로 적용. 시크릿 값은 표시 안 함.
"use client";
import { useCallback, useEffect, useState } from "react";
import { ipc } from "@/lib/ipc";
import type {
  MigrationResult,
  MigrationSourceKind,
  MigrationSourcePreview,
} from "@/lib/types";

export function MigrationPanel() {
  const [sources, setSources] = useState<MigrationSourcePreview[]>([]);
  const [loading, setLoading] = useState(true);
  const [overwrite, setOverwrite] = useState(false);
  const [busy, setBusy] = useState<MigrationSourceKind | null>(null);
  const [results, setResults] = useState<Record<string, MigrationResult>>({});

  const scan = useCallback(async () => {
    const api = ipc();
    if (!api) {
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      setSources(await api.migration.scan());
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void scan();
  }, [scan]);

  async function runImport(kind: MigrationSourceKind) {
    const api = ipc();
    if (!api) return;
    setBusy(kind);
    try {
      const res = await api.migration.import({ source: kind, overwrite, importKeys: true });
      setResults((r) => ({ ...r, [kind]: res }));
      await scan();
    } finally {
      setBusy(null);
    }
  }

  const available = sources.filter((s) => s.available);

  return (
    <>
      <h2 style={{ fontFamily: "var(--font-head)", fontSize: 15, margin: "32px 0 4px" }}>
        다른 도구에서 가져오기
      </h2>
      <p style={{ fontSize: 12, color: "var(--muted-deep)", margin: "0 0 12px" }}>
        OpenClaw / Hermes의 SOUL·API 키·자동화를 Agentlas로 옮깁니다. 키는 OS 키체인에만 저장됩니다.
      </p>

      {loading ? (
        <div style={{ fontSize: 13, color: "var(--muted-deep)" }}>스캔 중…</div>
      ) : available.length === 0 ? (
        <div
          style={{
            padding: 12,
            border: "1px dashed var(--paper-edge)",
            borderRadius: "var(--radius-md)",
            color: "var(--muted-deep)",
            fontSize: 13,
          }}
        >
          가져올 수 있는 OpenClaw / Hermes 설치를 찾지 못했습니다.
          <br />
          (~/.openclaw, ~/.hermes 를 확인했어요.)
        </div>
      ) : (
        <>
          <label
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              fontSize: 12,
              color: "var(--ink-soft)",
              marginBottom: 12,
            }}
          >
            <input
              type="checkbox"
              checked={overwrite}
              onChange={(e) => setOverwrite(e.target.checked)}
            />
            이미 가져온 에이전트가 있으면 덮어쓰기
          </label>

          {available.map((s) => (
            <div
              key={s.kind}
              style={{
                padding: 14,
                marginBottom: 12,
                border: "1px solid var(--paper-edge)",
                borderRadius: "var(--radius-md)",
                background: "var(--paper)",
              }}
            >
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <strong style={{ fontSize: 14 }}>{s.label}</strong>
                <span style={{ fontSize: 11, color: "var(--muted-deep)" }}>{s.rootPath}</span>
              </div>

              <ul
                style={{
                  listStyle: "none",
                  padding: 0,
                  margin: "10px 0",
                  fontSize: 12.5,
                  color: "var(--ink-soft)",
                  display: "flex",
                  flexDirection: "column",
                  gap: 4,
                }}
              >
                <li>
                  • 에이전트: <strong>{s.agent?.name ?? "—"}</strong>
                  {s.agent ? ` (${Math.round(s.agent.personaBytes / 1024)}KB)` : ""}
                </li>
                <li>
                  • API 키 {s.apiKeys.length}개
                  {s.apiKeys.length > 0 && (
                    <span style={{ color: "var(--muted-deep)" }}>
                      {" "}
                      — {s.apiKeys.map((k) => k.envKey).join(", ")}
                    </span>
                  )}
                </li>
                <li>• 자동화 {s.automations}개 · 메모리 {s.memories}개</li>
              </ul>

              <button
                onClick={() => void runImport(s.kind)}
                disabled={busy === s.kind}
                style={{
                  padding: "8px 16px",
                  borderRadius: "var(--radius-md)",
                  background: busy === s.kind ? "var(--paper-2)" : "var(--accent)",
                  color: busy === s.kind ? "var(--muted-deep)" : "white",
                  fontWeight: 600,
                  fontSize: 12.5,
                  border: "none",
                }}
              >
                {busy === s.kind ? "가져오는 중…" : `${s.label}에서 가져오기`}
              </button>

              {results[s.kind] && <ResultNote result={results[s.kind]} />}
            </div>
          ))}
        </>
      )}
    </>
  );
}

function ResultNote({ result }: { result: MigrationResult }) {
  const ok = result.agentImported || result.keysImported.length > 0;
  return (
    <div
      style={{
        marginTop: 12,
        padding: "10px 12px",
        borderRadius: "var(--radius-md)",
        background: ok ? "rgba(168,217,155,0.16)" : "var(--paper-2)",
        fontSize: 12,
        color: "var(--ink-soft)",
        lineHeight: 1.55,
      }}
    >
      <div style={{ fontWeight: 600 }}>
        {ok ? "가져오기 완료" : "변경 없음"}
      </div>
      <div style={{ color: "var(--muted-deep)", marginTop: 2 }}>
        에이전트 {result.agentImported ? "1" : "0"}개 · 키 {result.keysImported.length}개 · 자동화{" "}
        {result.automationsImported}개
      </div>
      {result.warnings.map((w, i) => (
        <div key={i} style={{ color: "var(--amber-deep, var(--muted-deep))", marginTop: 4 }}>
          ⚠ {w}
        </div>
      ))}
    </div>
  );
}
