// In-memory 시드 — 데스크톱에 박힌 큐레이션. dev 오프라인 + MCP 실패 fallback.
// 데이터는 기존 client.ts의 그대로 재사용.
import {
  getSeedFirmBySlug,
  getSeedListingBySlug,
  listSeedBundles,
  listSeedFirms,
  searchMarketplace,
} from "./client";
import type { MarketplaceSource } from "./source";

export class InMemorySource implements MarketplaceSource {
  listFirms() {
    return listSeedFirms();
  }
  listBundles() {
    return listSeedBundles();
  }
  searchAgents(q: string) {
    return searchMarketplace(q);
  }
  getListingBySlug(slug: string) {
    return getSeedListingBySlug(slug);
  }
  getFirmBySlug(slug: string) {
    return getSeedFirmBySlug(slug);
  }
}
