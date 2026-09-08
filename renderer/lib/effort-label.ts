/**
 * 작업량(effort) 이름 — 한 곳에서만 만든다.
 *
 * ★왜 (언어 전환 실측 2026-09-08): 한국어 화면에서 작업량이 "Low / Medium / High" 로
 *   남아 있었다. 같은 표가 **세 곳에 복사**돼 있었고(라이브러리·자동화 만들기·대시보드
 *   런타임 제어) 셋 다 영어만 있었다. 사본이 셋이면 한 곳을 고쳐도 나머지는 그대로다.
 *
 * 모르는 값은 지어내지 않는다 — 받은 id 를 그대로 보여 준다(엔진이 새 단계를 더해도
 * 화면이 거짓말하지 않는다).
 */
const KO: Record<string, string> = {
  none: "없음",
  minimal: "최소",
  low: "낮음",
  medium: "보통",
  high: "높음",
  xhigh: "아주 높음",
  max: "최대",
  ultra: "울트라",
};

const EN: Record<string, string> = {
  none: "None",
  minimal: "Minimal",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "XHigh",
  max: "Max",
  ultra: "Ultra",
};

/**
 * locale 을 넘기지 않으면 **문서 언어**를 본다.
 *
 * ★그러려면 <html lang> 이 실제 언어를 들고 있어야 한다. 예전에는 layout.tsx 에
 *   "ko" 로 박혀 있어 영어 사용자에게도 ko 로 보였다 — i18n 이 확정된 언어를
 *   documentElement.lang 에 쓰도록 함께 고쳤다(같은 커밋).
 */
export function effortLabel(id: string, locale?: string): string {
  const resolved = locale
    ?? (typeof document !== "undefined" && (document.documentElement.lang || "").toLowerCase().startsWith("ko") ? "ko" : "en");
  const table = resolved === "ko" ? KO : EN;
  return table[id] ?? id.charAt(0).toUpperCase() + id.slice(1);
}

/**
 * 엔진이 준 목록을 사람 말로 바꾼다.
 *
 * ★엔진이 주는 `efforts` 는 라벨까지 들고 오는데 그게 영어다("Low"). 그 배열을
 *   그대로 화면에 올리던 자리가 세 곳이었고, 그래서 한국어 화면에 Low/Medium/High 가
 *   남아 있었다(언어 전환 실측 2026-09-08).
 *   아는 단계는 우리 말로, 모르는 단계는 **엔진이 준 라벨 그대로** — 지어내지 않는다.
 */
export function effortOptions(
  efforts: ReadonlyArray<{ id: string; label?: string }> | undefined | null,
  locale?: string,
): Array<{ id: string; label: string }> {
  const resolved = locale
    ?? (typeof document !== "undefined" && (document.documentElement.lang || "").toLowerCase().startsWith("ko") ? "ko" : "en");
  const table = resolved === "ko" ? KO : EN;
  return (efforts ?? []).map((entry) => ({
    id: entry.id,
    label: table[entry.id] ?? entry.label ?? entry.id,
  }));
}
