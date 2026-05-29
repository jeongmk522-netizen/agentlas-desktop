// 자동 업데이트 배너 — Claude Code 데스크톱과 동일 패턴.
//   - downloading: 진행률 표시 (영구)
//   - downloaded:  "재시작 업데이트" 강조 버튼 (영구, dismissed 전까지)
//   - checking / not-available / error: 디버그용으로 잠깐(3.5s) 노출 후 자동 숨김
//
// 사용자가 "나중에"로 일단 닫으면 같은 다운로드 버전에 대해 다시 안 뜸 (세션 한정).
// 새 버전이 다시 다운로드되면 자동으로 다시 노출.
"use client";
import { useEffect, useRef, useState } from "react";
import { ipc, updaterEvents } from "@/lib/ipc";
import { useT } from "@/lib/i18n";
import type { UpdaterState } from "@/lib/types";

export function UpdateBanner() {
  const { t } = useT();
  const [state, setState] = useState<UpdaterState>({ status: "idle" });
  /** 사용자가 "나중에" 누른 버전. 그 버전에 대해서는 더 이상 안 띄움 */
  const [dismissedVersion, setDismissedVersion] = useState<string | null>(null);
  /** transient(checking/not-available/error) 상태는 자동으로 잠깐만 노출하고 사라지게 함 */
  const [transientUntil, setTransientUntil] = useState<number>(0);
  const lastFocusCheck = useRef(0);

  useEffect(() => {
    let cancelled = false;
    // 1) 마운트 직후 현재 상태 조회 — broadcast를 놓쳤을 경우의 백업
    const api = ipc();
    if (api) {
      void api.updater.getState().then((s) => {
        if (!cancelled) setState(s);
      });
    }
    // 창이 포커스될 때 자동 재확인(최대 10분에 1회) — 사용자가 수동으로 "업데이트 확인"을
    // 누르지 않아도 새 버전을 곧바로 발견·다운로드·알림.
    function onFocus() {
      const now = Date.now();
      if (now - lastFocusCheck.current < 10 * 60 * 1000) return;
      lastFocusCheck.current = now;
      void ipc()?.updater.check();
    }
    window.addEventListener("focus", onFocus);
    // 2) 이후 변화는 broadcast로 받음
    const events = updaterEvents();
    const off = events?.onState((next) => {
      if (cancelled) return;
      setState(next);
      // transient 상태는 3.5s 후 자동 숨김 — UpdateBanner는 디버깅용 보조
      if (
        next.status === "checking" ||
        next.status === "not-available" ||
        next.status === "error"
      ) {
        setTransientUntil(Date.now() + 3500);
      }
    });
    return () => {
      cancelled = true;
      off?.();
      window.removeEventListener("focus", onFocus);
    };
  }, []);

  // transient 상태에서 시간이 지나면 표시 종료
  useEffect(() => {
    if (transientUntil === 0) return;
    const id = setTimeout(() => setTransientUntil(0), Math.max(0, transientUntil - Date.now()));
    return () => clearTimeout(id);
  }, [transientUntil]);

  const isDownloaded = state.status === "downloaded";
  // "available"도 즉시 노출 — 새 버전 발견 순간 알림(자동 다운로드 중).
  const isDownloading = state.status === "downloading" || state.status === "available";
  const isDismissed =
    isDownloaded && state.version && dismissedVersion === state.version;
  const isTransient =
    transientUntil > Date.now() &&
    (state.status === "checking" ||
      state.status === "not-available" ||
      state.status === "error");
  if (!isDownloaded && !isDownloading && !isTransient) return null;
  if (isDownloaded && isDismissed) return null;

  async function install() {
    const api = ipc();
    if (!api) return;
    await api.updater.install();
  }

  return (
    <div
      style={{
        position: "absolute",
        top: 12,
        right: 16,
        zIndex: 50,
        display: "flex",
        alignItems: "center",
        gap: 10,
        padding: "8px 12px 8px 14px",
        borderRadius: 999,
        background: isDownloaded ? "var(--accent)" : "var(--paper)",
        color: isDownloaded ? "white" : "var(--ink)",
        border: isDownloaded ? "none" : "1px solid var(--paper-edge)",
        boxShadow: isDownloaded
          ? "0 8px 24px rgba(11,11,15,0.18)"
          : "0 2px 8px rgba(11,11,15,0.06)",
        fontSize: 12,
        fontWeight: 500,
      }}
      role="status"
      aria-live="polite"
    >
      {isTransient && !isDownloaded && !isDownloading ? (
        <>
          <Spinner />
          <span style={{ color: "var(--ink-soft)" }}>
            {state.status === "checking"
              ? t("update.checking")
              : state.status === "not-available"
                ? t("update.uptodate")
                : t("update.error_short")}
          </span>
        </>
      ) : isDownloaded ? (
        <>
          <span
            aria-hidden
            style={{
              width: 8,
              height: 8,
              borderRadius: "50%",
              background: "white",
              boxShadow: "0 0 0 4px rgba(255,255,255,0.25)",
            }}
          />
          <span>
            {t("update.ready", { version: state.version ?? "?" })}
          </span>
          <button
            onClick={() => void install()}
            style={{
              padding: "4px 12px",
              borderRadius: 999,
              background: "white",
              color: "var(--accent)",
              fontWeight: 700,
              fontSize: 12,
              border: "none",
              cursor: "pointer",
              boxShadow: "0 1px 3px rgba(0,0,0,0.12)",
            }}
          >
            {t("update.restart_now")}
          </button>
          <button
            onClick={() => state.version && setDismissedVersion(state.version)}
            aria-label={t("update.dismiss")}
            title={t("update.dismiss")}
            style={{
              padding: "2px 8px",
              borderRadius: 999,
              background: "transparent",
              color: "white",
              fontSize: 11,
              opacity: 0.85,
              border: "none",
              cursor: "pointer",
            }}
          >
            ×
          </button>
        </>
      ) : (
        <>
          <Spinner />
          <span style={{ color: "var(--ink-soft)" }}>
            {state.status === "available"
              ? t("update.found", { version: state.version ?? "?" })
              : t("update.downloading", { pct: state.progress ?? 0 })}
          </span>
        </>
      )}
    </div>
  );
}

function Spinner() {
  return (
    <span
      aria-hidden
      style={{
        width: 12,
        height: 12,
        borderRadius: "50%",
        border: "2px solid var(--paper-edge)",
        borderTopColor: "var(--accent)",
        animation: "agentlas-spin 0.8s linear infinite",
        display: "inline-block",
      }}
    />
  );
}
