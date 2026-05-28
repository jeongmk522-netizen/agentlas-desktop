import type { Metadata } from "next";
import "./globals.css";
import { I18nProvider } from "@/lib/i18n";

export const metadata: Metadata = {
  title: "Agentlas",
  description: "Run expert assistant teams on your existing AI subscriptions",
};

// 루트 layout은 셸 없이 — 셸은 (shell)/layout.tsx에서 입힌다.
// /onboarding은 (no-shell)/onboarding에 두어서 셸을 우회.
export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="ko">
      <body>
        <I18nProvider>{children}</I18nProvider>
      </body>
    </html>
  );
}
