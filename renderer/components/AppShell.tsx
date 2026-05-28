// 모든 라우트의 공통 셸 — 좌측 Sidebar(glass) + 우측 페이지 슬롯.
// body 그라데이션 위에 떠 있는 frosted glass 레이아웃.
// + Electron 메뉴 → 라우터 브릿지.
// + 자동 업데이트 배너 (downloading/downloaded 상태에서만 노출).
"use client";
import { Sidebar } from "./Sidebar";
import { MenuBridge } from "./MenuBridge";
import { UpdateBanner } from "./UpdateBanner";

export function AppShell({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        display: "flex",
        height: "100vh",
        background: "transparent",
        overflow: "hidden",
      }}
    >
      <MenuBridge />
      <Sidebar />
      <main
        style={{
          position: "relative",
          flex: 1,
          minWidth: 0,
          display: "flex",
          flexDirection: "column",
          overflow: "hidden",
          background: "transparent",
        }}
      >
        <UpdateBanner />
        {children}
      </main>
    </div>
  );
}
