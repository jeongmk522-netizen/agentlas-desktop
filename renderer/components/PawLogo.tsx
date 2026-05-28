// Agentlas paw print 로고 — agentlas-mark.png 원본 사용 (AgentsAtlas web에서 복사).
// 사이드바 헤더, 온보딩, dock 아이콘 변환 등에 동일 자산 재사용.
"use client";
import Image from "next/image";
import type { CSSProperties } from "react";

export function PawLogo({
  size = 28,
  title,
  style,
}: {
  size?: number;
  title?: string;
  /** SVG 시절 시그니처 호환용 — png에는 단색 tint 적용 불가, 무시됨 */
  color?: string;
  style?: CSSProperties;
}) {
  return (
    <Image
      src="/brand/agentlas-mark.png"
      width={size}
      height={size}
      alt={title ?? "Agentlas"}
      priority
      style={{
        width: size,
        height: size,
        objectFit: "contain",
        display: "block",
        ...style,
      }}
    />
  );
}
