// 게임 라이브러리 카드 느낌 — 한 글자 이니셜 + tone 색.
// PRD 7.4: 에이전트 카드는 사람처럼 보이게.
"use client";
import type { CSSProperties } from "react";

const TONE_BG: Record<string, string> = {
  blue: "var(--blue)",
  green: "var(--green)",
  purple: "var(--purple)",
  amber: "var(--amber)",
  peach: "var(--peach-soft)",
};

const TONE_INK: Record<string, string> = {
  blue: "var(--blue-deep)",
  green: "var(--green-deep)",
  purple: "var(--purple-deep)",
  amber: "var(--amber-deep)",
  peach: "var(--peach-ink)",
};

export function AgentAvatar({
  name,
  tone = "blue",
  size = 32,
}: {
  name: string;
  tone?: "blue" | "green" | "purple" | "amber" | "peach";
  size?: number;
}) {
  const initial = (name?.trim()?.[0] ?? "?").toUpperCase();
  const style: CSSProperties = {
    width: size,
    height: size,
    borderRadius: "50%",
    background: TONE_BG[tone] ?? TONE_BG.blue,
    color: TONE_INK[tone] ?? TONE_INK.blue,
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    fontFamily: "var(--font-head)",
    fontWeight: 600,
    fontSize: Math.max(11, Math.floor(size * 0.42)),
    flexShrink: 0,
  };
  return <span style={style}>{initial}</span>;
}
