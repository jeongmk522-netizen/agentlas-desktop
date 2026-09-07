// 루트 React ErrorBoundary — 한 화면(pane)의 렌더 throw가 앱 전체를 흰 화면으로
// 무너뜨리지 않도록 격리한다. AppShell의 메인 콘텐츠를 감싸 per-pane으로 동작하며,
// 라우트 변경 시 resetKey(보통 pathname)가 바뀌면 자동으로 복구된다.
"use client";
import { Component, type ReactNode } from "react";
import { LoadingEstimate } from "./LoadingEstimate";

// 클래스 컴포넌트라 useT() 훅을 쓸 수 없어, i18n과 동일한 override 키를 직접 읽는다.
// (lib/i18n.tsx: STORAGE_KEY "agentlas.locale", SSR 기본값 en)
/*
 * ★이 함수는 **언제나 "en" 을 돌려주고 있었다** (실측 2026-09-08).
 *
 *     if (raw === "en") return "en";
 *     ...
 *     return "en";        ← 어느 길로 가도 en
 *
 *   그래서 이 화면의 한국어 문구는 **한 번도 그려진 적이 없다.** 코드에는 번역이
 *   있으니 grep 으로는 "번역돼 있다"로 보인다 — 화면을 훑어서야 잡혔다
 *   ("화면을 다시 불러오는 중입니다" 가 늘 "Reloading this view" 로 나왔다).
 *
 *   클래스 컴포넌트라 useT() 를 못 쓰므로 i18n 과 같은 override 키를 직접 읽는다.
 *   override 가 없으면 i18n 처럼 OS/브라우저 언어로 떨어진다(그쪽은 IPC 로 읽지만
 *   여기서는 훅을 못 쓰므로 문서·브라우저 언어까지가 최선이다).
 */
function readLocale(): "ko" | "en" {
  try {
    const raw = window.localStorage.getItem("agentlas.locale");
    if (raw === "ko") return "ko";
    if (raw === "en") return "en";
    const documentLang = document.documentElement.lang || "";
    if (documentLang.toLowerCase().startsWith("ko")) return "ko";
    const navigatorLang = navigator.language || "";
    if (navigatorLang.toLowerCase().startsWith("ko")) return "ko";
  } catch {
    // 저장소를 못 읽어도 화면은 떠야 한다.
  }
  return "en";
}

type Props = {
  children: ReactNode;
  // 이 값이 바뀌면(예: pathname) 폴백 상태를 자동으로 리셋한다.
  resetKey?: unknown;
};

type State = { error: Error | null };

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };
  private retryTimer: ReturnType<typeof setTimeout> | null = null;

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: { componentStack: string }) {
    // 콘솔에 남겨 두면 메인 프로세스 로그/DevTools에서 추적 가능.
    console.error("[ErrorBoundary]", error, info.componentStack);
    this.retryTimer = setTimeout(this.reset, 2_500);
  }

  componentWillUnmount() {
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
  }

  componentDidUpdate(prev: Props) {
    if (this.state.error && prev.resetKey !== this.props.resetKey) {
      this.reset();
    }
  }

  reset = () => this.setState({ error: null });

  render() {
    if (!this.state.error) return this.props.children;
    const ko = readLocale() === "ko";
    return (
      <div
        aria-live="polite"
        style={{
          flex: 1,
          minWidth: 0,
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          gap: 14,
          padding: 32,
          textAlign: "center",
          background: "var(--paper)",
          color: "var(--ink)",
        }}
      >
        <div style={{ fontSize: 15, fontWeight: 800 }}>
          {ko ? "화면을 다시 불러오는 중입니다" : "Reloading this view"}
        </div>
        <p style={{ margin: 0, fontSize: 13, color: "var(--ink-soft)", maxWidth: 360, lineHeight: 1.5 }}>
          {ko
            ? "현재 작업은 그대로 보존됩니다. 잠시 후 이 화면에서 이어집니다."
            : "Your current work is preserved. This view will resume shortly."}
        </p>
        <LoadingEstimate locale={ko ? "ko" : "en"} operationKey="desktop-view-recovery" expectedSeconds={[2, 3]} />
      </div>
    );
  }
}
