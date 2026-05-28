// MCP 서버 번들 다운로드 + 의존성 점검.
// M0: stub. M1에서 다음을 구현:
//  1) agentlas.cloud/api/marketplace/bundle/<slug>.tar.gz fetch
//  2) SHA256 검증 (manifest에 포함된 해시)
//  3) userData/agents/<slug>/ 에 압축 해제
//  4) package.json 분석 → 필요한 node binary 확인 (Node 20+)
//  5) 보안검토 배지 (A/B 등급만) — registry.installAgent가 게이트
//
// PRD 6.2 — 사이드로드는 V0에서 거부. 마켓 등록은 사람이 본다.
import type { MarketplaceListing } from "../../shared/types";

export async function downloadBundle(_listing: MarketplaceListing): Promise<{
  installPath: string;
  manifestVersion: string;
}> {
  // M0 placeholder
  return {
    installPath: "/tmp/agentlas-stub",
    manifestVersion: "0.0.0-stub",
  };
}
