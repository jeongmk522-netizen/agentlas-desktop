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

type State = { error: Error | null; attempts: number };

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null, attempts: 0 };
  private retryTimer: ReturnType<typeof setTimeout> | null = null;

  /*
   * ★몇 번까지 스스로 다시 그려 볼 것인가.
   *   예전에는 상한이 없었다: 다시 그리고 또 터지면 또 2.5초 뒤에 다시 그린다.
   *   화면에는 "곧 완료" 만 영원히 남고 **누를 것이 하나도 없었다**(빈 상태 실측
   *   2026-09-08). 자동 복구는 두 번까지만 하고, 그 뒤에는 사실을 말하고 길을 준다.
   */
  static RETRY_LIMIT = 2;

  /*
   * ★여기서 attempts 를 0 으로 되돌리면 상한이 무의미해진다 — 다시 그릴 때마다
   *   세던 횟수가 초기화돼 "곧 완료 · 1초 경과" 가 영원히 반복된다(실측으로 확인).
   *   React 는 부분 상태를 병합하므로 error 만 준다.
   */
  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error };
  }

  componentDidCatch(error: Error, info: { componentStack: string }) {
    // 콘솔에 남겨 두면 메인 프로세스 로그/DevTools에서 추적 가능.
    console.error("[ErrorBoundary]", error, info.componentStack);
    this.setState((current) => {
      const attempts = current.attempts + 1;
      if (attempts <= ErrorBoundary.RETRY_LIMIT) {
        if (this.retryTimer) clearTimeout(this.retryTimer);
        this.retryTimer = setTimeout(this.reset, 2_500);
      }
      return { error, attempts };
    });
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

  reset = () => this.setState((current) => ({ error: null, attempts: current.attempts }));

  retryByHand = () => this.setState({ error: null, attempts: 0 });

  render() {
    if (!this.state.error) return this.props.children;
    const ko = readLocale() === "ko";
    const givenUp = this.state.attempts > ErrorBoundary.RETRY_LIMIT;
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
          {givenUp
            ? (ko ? "이 화면을 다시 그리지 못했습니다" : "This view could not be restored")
            : (ko ? "화면을 다시 불러오는 중입니다" : "Reloading this view")}
        </div>
        <p style={{ margin: 0, fontSize: 13, color: "var(--ink-soft)", maxWidth: 360, lineHeight: 1.5 }}>
          {givenUp
            ? (ko
              ? "현재 작업은 그대로 보존됩니다. 다시 시도하거나 다른 화면으로 이동해 주세요."
              : "Your current work is preserved. Try again, or move to another screen.")
            : (ko
              ? "현재 작업은 그대로 보존됩니다. 잠시 후 이 화면에서 이어집니다."
              : "Your current work is preserved. This view will resume shortly.")}
        </p>
        {givenUp ? (
          <div style={{ display: "flex", gap: 8 }}>
            <button
              type="button"
              onClick={this.retryByHand}
              style={{ padding: "9px 14px", borderRadius: 10, border: "1px solid var(--paper-edge)", background: "var(--paper)", color: "var(--ink)", fontSize: 13, fontWeight: 700 }}
            >
              {ko ? "다시 시도" : "Try again"}
            </button>
            <button
              type="button"
              onClick={() => { window.location.href = "/index.html"; }}
              style={{ padding: "9px 14px", borderRadius: 10, border: "1px solid var(--paper-edge)", background: "var(--paper-2)", color: "var(--ink)", fontSize: 13, fontWeight: 700 }}
            >
              {ko ? "대시보드로" : "Go to dashboard"}
            </button>
          </div>
        ) : (
          <LoadingEstimate locale={ko ? "ko" : "en"} operationKey="desktop-view-recovery" expectedSeconds={[2, 3]} />
        )}
      </div>
    );
  }
}
