// App Router 전용 404 — pages/_error 폴백이 호출되는 것을 막아준다.
// 빈 정적 페이지 한 장.
export default function NotFound() {
  return (
    <main
      style={{
        height: "100vh",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        gap: 8,
        background: "var(--paper-2)",
        color: "var(--ink)",
        fontFamily: "var(--font-body)",
      }}
    >
      <h1
        style={{
          margin: 0,
          fontFamily: "var(--font-head)",
          fontSize: 28,
          fontWeight: 700,
        }}
      >
        길을 잃었어요
      </h1>
      <p style={{ margin: 0, color: "var(--muted-deep)" }}>
        찾으시는 페이지가 없습니다.
      </p>
      <a href="/" style={{ color: "var(--accent)", fontWeight: 600 }}>
        메인으로
      </a>
    </main>
  );
}
