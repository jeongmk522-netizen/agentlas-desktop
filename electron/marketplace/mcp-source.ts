// MCP source — agentlas.cloud/api/mcp/v1 HTTPS 호출.
// Node 20+ 글로벌 fetch. 인증 토큰은 옵션 (anonymous read-only).
//
// 응답 실패/타임아웃 시 fallback으로 InMemorySource를 자동 사용 (오프라인 보호).
import type { FirmListing, MarketplaceListing, TeamBundle } from "../../shared/types";
import type { MarketplaceSource, SeedListingFull } from "./source";

interface McpSourceOptions {
  baseUrl: string;
  /** 인증 토큰 (있으면 cargo/builder 호출 가능) */
  bearer?: string;
  /** 요청 타임아웃 (ms) — 기본 15000 */
  timeoutMs?: number;
  /** 매 호출 직전에 평가되는 cookie 헤더 — agentlas_session=... 또는 null. 로그인 상태가 바뀔 수 있어 함수로 받는다. */
  cookieProvider?: () => string | null;
}

export class McpSource implements MarketplaceSource {
  constructor(private opts: McpSourceOptions) {}

  private async call<T>(method: string, params?: Record<string, unknown>): Promise<T> {
    const url = `${this.opts.baseUrl}/tools/call`;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.opts.timeoutMs ?? 15000);
    try {
      const headers: Record<string, string> = { "content-type": "application/json" };
      if (this.opts.bearer) headers.authorization = `Bearer ${this.opts.bearer}`;
      // 로그인되어 있으면 세션 cookie를 첨부 — server-side에서 인증된 사용자로 인식
      const cookie = this.opts.cookieProvider?.();
      if (cookie) headers.cookie = cookie;
      const resp = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify({ method, params: { name: method, arguments: params ?? {} } }),
        signal: ctrl.signal,
      });
      if (!resp.ok) throw new Error(`MCP ${method} ${resp.status}`);
      const json = (await resp.json()) as { result?: T; error?: { message: string } };
      if (json.error) throw new Error(`MCP ${method}: ${json.error.message}`);
      return json.result as T;
    } finally {
      clearTimeout(timer);
    }
  }

  listFirms(): Promise<FirmListing[]> {
    return this.call<FirmListing[]>("marketplace.list_firms", {});
  }

  listBundles(): Promise<TeamBundle[]> {
    return this.call<TeamBundle[]>("marketplace.list_bundles", {});
  }

  searchAgents(q: string): Promise<MarketplaceListing[]> {
    return this.call<MarketplaceListing[]>("marketplace.search_agents", { q });
  }

  async getListingBySlug(
    slug: string,
  ): Promise<(SeedListingFull & MarketplaceListing) | null> {
    return this.call<(SeedListingFull & MarketplaceListing) | null>(
      "marketplace.get_manifest",
      { kind: "agent", slug },
    );
  }

  getFirmBySlug(slug: string): Promise<FirmListing | null> {
    return this.call<FirmListing | null>("marketplace.get_manifest", {
      kind: "firm",
      slug,
    });
  }
}
