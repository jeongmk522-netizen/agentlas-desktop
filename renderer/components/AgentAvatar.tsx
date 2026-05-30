// 에이전트 프로필 — 한 글자 이니셜.
// 디자인 방향(2026-05): 다양한 밝은 톤색을 쓰지 않고 중성 모노크롬으로 통일.
// (tone prop은 호출부 호환을 위해 유지하되 색에는 더 이상 쓰지 않음.)
"use client";
import type { CSSProperties } from "react";

export function AgentAvatar({
  name,
  size = 32,
}: {
  name: string;
  /** @deprecated 색에 더 이상 사용하지 않음 — 모노크롬 통일. 호출부 호환용으로만 남김. */
  tone?: "blue" | "green" | "purple" | "amber" | "peach";
  size?: number;
}) {
  const initial = (name?.trim()?.[0] ?? "?").toUpperCase();
  const style: CSSProperties = {
    width: size,
    height: size,
    borderRadius: "50%",
    background: "var(--paper-edge)",
    color: "var(--ink-soft)",
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
