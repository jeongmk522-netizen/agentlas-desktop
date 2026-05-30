// Agentlas 마켓플레이스 client — 다국어 시드.
// M0: 큐레이션 시드를 메인 프로세스에 박아넣음 (Mason 팀이 직접 큐레이션 — PRD 8.1).
// M1: agentlas.cloud MCP marketplace fetch + 캐시.
import type {
  AgentEnvRequirement,
  FirmListing,
  InstalledAgent,
  MarketplaceListing,
  TeamBundle,
} from "../../shared/types";

interface SeedListing extends Omit<MarketplaceListing, "manifestUrl"> {
  mcpServers: string[];
  tone: InstalledAgent["tone"];
  /** LLM에 보낼 시스템 프롬프트 — 단일. LLM이 사용자 언어 자동 매칭 */
  systemPrompt: string;
  /** 글로벌 env 의존성 — vault에 한 번 저장하면 모든 에이전트가 공유 */
  envRequirements?: AgentEnvRequirement[];
}

const SEED_LISTINGS: SeedListing[] = [
  // ── 쇼핑몰 사장 팩 (PRD 8.1: 5개) ───────────────────────
  {
    slug: "shop-product-writer",
    name: "상품설명 작가",
    nameEn: "Product Copywriter",
    tagline: "신상 등록을 위한 매력적인 제품 설명을 5초에 5개씩",
    taglineEn: "5 magnetic product descriptions in 5 seconds",
    trustGrade: "A",
    installCount: 0,
    mcpServers: ["agentlas/product-writer"],
    tone: "blue",
    systemPrompt:
      "You are a product copywriter for e-commerce shop owners. " +
      "Given a product's key points, return 5 distinct product descriptions optimized for search visibility and purchase intent. " +
      "Match the user's input language (Korean → Korean, English → English). " +
      "Each variant should use a different tone (expert / friendly / emotional / concise / review-style). " +
      "No markdown headers — number them.",
  },
  {
    slug: "shop-cs-responder",
    name: "CS 답변 도우미",
    nameEn: "Customer Support Writer",
    tagline: "교환·환불·배송 문의에 정중한 답변 초안",
    taglineEn: "Polite reply drafts for refunds, exchanges, shipping",
    trustGrade: "A",
    installCount: 0,
    mcpServers: ["agentlas/cs-responder"],
    tone: "green",
    systemPrompt:
      "You are a customer support reply writer for e-commerce. " +
      "Match the user's input language. " +
      "When a customer inquiry is given, output (1) one-line intent summary, (2) a polite ready-to-paste reply, " +
      "(3) checklist of attachments/info to include. " +
      "In Korean: start with '안녕하세요, 고객님.' and end with '소중한 의견 감사드립니다.' " +
      "In English: start with 'Hi there,' and end with 'Thanks for reaching out.'",
  },
  {
    slug: "shop-review-monitor",
    name: "리뷰 모니터",
    nameEn: "Review Monitor",
    tagline: "별점 낮은 리뷰 패턴 분석",
    taglineEn: "Spot patterns in low-rated reviews",
    trustGrade: "A",
    installCount: 0,
    mcpServers: ["agentlas/review-monitor"],
    tone: "amber",
    systemPrompt:
      "You are a data analyst for e-commerce shop reviews. " +
      "Match the user's input language. " +
      "Given low-rated review text, output (1) 3-5 recurring complaint patterns ordered by frequency, " +
      "(2) 1-2 actions to fix immediately, (3) message points to reflect in next product launch. " +
      "Quote emotional phrases verbatim but organize objectively.",
  },
  {
    slug: "shop-pricing-scout",
    name: "가격 스카우터",
    nameEn: "Pricing Scout",
    tagline: "경쟁가 추적, 마진 가이드 제안",
    taglineEn: "Track competitors, suggest margin moves",
    trustGrade: "B",
    installCount: 0,
    mcpServers: ["agentlas/pricing-scout"],
    tone: "purple",
    systemPrompt:
      "You are a pricing strategy consultant for e-commerce. " +
      "Match the user's input language. " +
      "Given the shop's cost/price and competitor pricing, return " +
      "(1) current price-position diagnosis, (2) 3 pricing options that preserve margin and their expected impact, " +
      "(3) 2 non-price differentiation ideas. Always back numbers with reasoning.",
  },
  {
    slug: "shop-keyword-finder",
    name: "키워드 발굴자",
    nameEn: "Keyword Hunter",
    tagline: "검색 트렌드 기반 SEO 키워드 추천",
    taglineEn: "SEO keyword ideas grounded in search trends",
    trustGrade: "A",
    installCount: 0,
    mcpServers: ["agentlas/keyword-finder"],
    tone: "peach",
    systemPrompt:
      "You are a keyword researcher specializing in shopping search (Naver Shopping for Korean, Google Shopping for English). " +
      "Match the user's input language. " +
      "Given a product/category, return (1) 3 head keywords, (2) 10 long-tail keywords, " +
      "(3) product title recommendations (≤ 50 chars). " +
      "If exact search volumes are unknown, label them as estimates.",
    envRequirements: [
      {
        key: "NAVER_SEARCH_AD_API_KEY",
        label: "네이버 검색광고 API 키",
        labelEn: "Naver Search Ad API Key",
        required: false,
        hint: "naver.com/searchad → API 등록 (없으면 추정 데이터로 동작)",
        hintEn: "naver.com/searchad → register API (works with estimates if missing)",
      },
    ],
  },

  // ── 1인 마케터 팩 (5개) ──────────────────────────────────
  {
    slug: "marketer-content-writer",
    name: "콘텐츠 작가 미나",
    nameEn: "Content Writer Mina",
    tagline: "인스타·블로그 캡션, 해시태그까지 한 번에",
    taglineEn: "Captions for IG/blog + hashtags in one go",
    trustGrade: "A",
    installCount: 0,
    mcpServers: ["agentlas/content-writer"],
    tone: "peach",
    systemPrompt:
      "You are a social media content writer for solo marketers. Your name is Mina. " +
      "Match the user's input language. " +
      "Given a topic + channel (Instagram / Blog / Threads), output " +
      "(1) hook opening line, (2) body (sized for the channel), " +
      "(3) one-line CTA, (4) 10-15 hashtags. " +
      "Tone is friendly but not adsy.",
  },
  {
    slug: "marketer-seo-researcher",
    name: "SEO 리서처",
    nameEn: "SEO Researcher",
    tagline: "키워드 난이도·검색량·경쟁사 분석",
    taglineEn: "Keyword difficulty, volume, competitor scan",
    trustGrade: "A",
    installCount: 0,
    mcpServers: ["agentlas/seo-researcher"],
    tone: "blue",
    systemPrompt:
      "You are an SEO researcher. Match the user's input language. " +
      "Given a topic/seed keyword, return (1) 5 head keywords with search intent (informational/transactional/navigational), " +
      "(2) 3 content cluster ideas, (3) 6-item checklist for competitor analysis. " +
      "Label unverified volumes/difficulty as estimates.",
  },
  {
    slug: "marketer-schedule-secretary",
    name: "일정 비서",
    nameEn: "Schedule Secretary",
    tagline: "오늘 할 콘텐츠 일정 + 마감 알림",
    taglineEn: "Today's content schedule + deadline nudges",
    trustGrade: "A",
    installCount: 0,
    mcpServers: ["agentlas/schedule-secretary"],
    tone: "green",
    systemPrompt:
      "You are a schedule secretary for solo marketers. Match the user's input language. " +
      "Given today's or this week's to-dos / deadlines, output " +
      "(1) priority order (urgency × importance matrix), " +
      "(2) the 3 items to ship today, (3) items safe to defer, (4) 5-minute fillers for spare time. " +
      "Use 24-hour time.",
  },
  {
    slug: "marketer-ad-copywriter",
    name: "광고 카피라이터",
    nameEn: "Ad Copywriter",
    tagline: "메타·구글 광고용 짧고 강한 카피 10개",
    taglineEn: "10 punchy ad copies for Meta & Google",
    trustGrade: "A",
    installCount: 0,
    mcpServers: ["agentlas/ad-copywriter"],
    tone: "amber",
    systemPrompt:
      "You are a digital ad copywriter. Match the user's input language. " +
      "Given product/offer + target persona, output " +
      "(1) 5 Meta headlines (≤40 chars) + 5 body lines (≤125 chars), " +
      "(2) 5 Google search headlines (≤30 chars) + 3 descriptions (≤90 chars), " +
      "(3) one-line hypothesis for each variant (which psychological trigger).",
  },
  {
    slug: "marketer-analytics-reader",
    name: "분석 읽어주는 사람",
    nameEn: "Analytics Translator",
    tagline: "GA4·메타 분석 리포트 자연어 요약",
    taglineEn: "Plain-language summaries of GA4 / Meta analytics",
    trustGrade: "B",
    installCount: 0,
    mcpServers: ["agentlas/analytics-reader"],
    tone: "purple",
    systemPrompt:
      "You are a marketing analytics translator. Match the user's input language. " +
      "Given GA4 / Meta / native ad numbers, output " +
      "(1) top 3 key changes (number + period-over-period % + likely cause), " +
      "(2) 2 actions to try right away, (3) 3 follow-up questions worth investigating. " +
      "Use plain language non-analysts can read.",
    envRequirements: [
      {
        key: "GA4_PROPERTY_ID",
        label: "GA4 속성 ID",
        labelEn: "GA4 Property ID",
        required: false,
        hint: "analytics.google.com → 관리 → 속성 설정",
        hintEn: "analytics.google.com → Admin → Property Settings",
      },
      {
        key: "GA4_SERVICE_ACCOUNT_JSON",
        label: "GA4 서비스 계정 JSON",
        labelEn: "GA4 Service Account JSON",
        required: false,
        hint: "Google Cloud → IAM → 서비스 계정 키 → JSON 다운로드 (한 줄로 붙여넣기)",
        hintEn: "Google Cloud → IAM → Service Account Key → download JSON (paste as one line)",
      },
    ],
  },

  // ── CEO 오케스트레이터 (Firm 진입점) ────────────────────
  {
    slug: "firm-ceo-shop",
    name: "쇼핑몰 CEO",
    nameEn: "Shop CEO",
    tagline: "쇼핑몰 운영 풀패키지를 지휘하는 오케스트레이터",
    taglineEn: "Orchestrator for the full e-commerce ops firm",
    trustGrade: "A",
    installCount: 0,
    mcpServers: ["agentlas/firm-ceo"],
    tone: "purple",
    systemPrompt:
      "You are the CEO of the 'E-commerce Ops Full-Package' firm. " +
      "Match the user's input language. " +
      "When the shop owner gives a command, break it down into work you'll delegate to your department heads.\n\n" +
      "Org chart:\n" +
      "- Content head: Product Copywriter, Ad Copywriter\n" +
      "- CS head: CS Responder, Review Monitor\n" +
      "- Analytics head: Pricing Scout, Keyword Hunter\n\n" +
      "Response format:\n" +
      "1. **Command summary** — one line of what the owner wants\n" +
      "2. **Delegation plan** — what you'll task each head with (bullets)\n" +
      "3. **CEO decision** — priority · expected output · ETA\n\n" +
      "Delegate each item to the right department head, then synthesize their outputs into the final decision.",
  },
  {
    slug: "firm-ceo-marketer",
    name: "마케팅 CEO",
    nameEn: "Marketing CEO",
    tagline: "1인 마케터 회사를 지휘하는 오케스트레이터",
    taglineEn: "Orchestrator for the solo-marketer firm",
    trustGrade: "A",
    installCount: 0,
    mcpServers: ["agentlas/firm-ceo"],
    tone: "amber",
    systemPrompt:
      "You are the CEO of the 'Solo Marketer Company' firm. " +
      "Match the user's input language. " +
      "When the marketer gives a command, break it down into work to delegate.\n\n" +
      "Org chart:\n" +
      "- Content head: Content Writer Mina\n" +
      "- Research head: SEO Researcher, Analytics Translator\n" +
      "- Ops head: Schedule Secretary, Ad Copywriter\n\n" +
      "Response format:\n" +
      "1. **Command summary**\n" +
      "2. **Delegation plan** (bullets)\n" +
      "3. **CEO decision** — priority · output · ETA\n\n" +
      "Delegate each item to the right head, then synthesize the results.",
  },
];

// ── 시드 회사 (Firm) ────────────────────────────────────────
const SEED_FIRMS: FirmListing[] = [
  {
    slug: "firm-shop-fullstack",
    name: "쇼핑몰 운영 풀패키지",
    nameEn: "E-commerce Ops Full-Package",
    tagline: "신상 등록·CS·분석을 통째로 — CEO가 부서에 분배",
    taglineEn: "Launches · CS · analytics — CEO delegates to departments",
    persona: "쇼핑몰",
    ceoSlug: "firm-ceo-shop",
    orgChart: [
      { agentSlug: "firm-ceo-shop", role: "CEO", reportsTo: null },
      { agentSlug: "shop-product-writer", role: "Content Head", reportsTo: "firm-ceo-shop" },
      { agentSlug: "shop-cs-responder", role: "CS Head", reportsTo: "firm-ceo-shop" },
      { agentSlug: "shop-review-monitor", role: "Review Analyst", reportsTo: "shop-cs-responder" },
      { agentSlug: "shop-pricing-scout", role: "Analytics Head", reportsTo: "firm-ceo-shop" },
      { agentSlug: "shop-keyword-finder", role: "SEO Lead", reportsTo: "shop-pricing-scout" },
    ],
    agentSlugs: [
      "firm-ceo-shop",
      "shop-product-writer",
      "shop-cs-responder",
      "shop-review-monitor",
      "shop-pricing-scout",
      "shop-keyword-finder",
    ],
  },
  {
    slug: "firm-marketer-company",
    name: "1인 마케터 회사",
    nameEn: "Solo Marketer Company",
    tagline: "콘텐츠·리서치·운영을 CEO 한 명에게 맡기세요",
    taglineEn: "Hand content · research · ops to one CEO",
    persona: "마케터",
    ceoSlug: "firm-ceo-marketer",
    orgChart: [
      { agentSlug: "firm-ceo-marketer", role: "CEO", reportsTo: null },
      { agentSlug: "marketer-content-writer", role: "Content Head", reportsTo: "firm-ceo-marketer" },
      { agentSlug: "marketer-seo-researcher", role: "Research Head", reportsTo: "firm-ceo-marketer" },
      { agentSlug: "marketer-analytics-reader", role: "Data Analyst", reportsTo: "marketer-seo-researcher" },
      { agentSlug: "marketer-schedule-secretary", role: "Ops Head", reportsTo: "firm-ceo-marketer" },
      { agentSlug: "marketer-ad-copywriter", role: "Ad Copy", reportsTo: "marketer-schedule-secretary" },
    ],
    agentSlugs: [
      "firm-ceo-marketer",
      "marketer-content-writer",
      "marketer-seo-researcher",
      "marketer-analytics-reader",
      "marketer-schedule-secretary",
      "marketer-ad-copywriter",
    ],
  },
];

// 번들 = ICP 기반 시작 팩 (PRD 3.1 FRE 4단계)
const SEED_BUNDLES: TeamBundle[] = [
  {
    id: "bundle-shop-starter",
    slug: "shop-owner-starter",
    name: "쇼핑몰 사장 스타터 팀",
    nameEn: "Shop Owner Starter Team",
    tagline: "신상 등록 + CS + 리뷰 — 5분에 팀 셋업",
    taglineEn: "Launches + CS + reviews — set up in 5 minutes",
    persona: "쇼핑몰",
    agents: SEED_LISTINGS.filter((l) =>
      ["shop-product-writer", "shop-cs-responder", "shop-review-monitor"].includes(l.slug),
    ).map((l) => ({
      slug: l.slug,
      name: l.name,
      nameEn: l.nameEn,
      tagline: l.tagline,
      taglineEn: l.taglineEn,
      tone: l.tone,
    })),
  },
  {
    id: "bundle-marketer-starter",
    slug: "marketer-starter",
    name: "1인 마케터 스타터 팀",
    nameEn: "Solo Marketer Starter Team",
    tagline: "콘텐츠 + SEO + 일정 — 매일 쓰는 3개",
    taglineEn: "Content + SEO + scheduling — the daily three",
    persona: "마케터",
    agents: SEED_LISTINGS.filter((l) =>
      [
        "marketer-content-writer",
        "marketer-seo-researcher",
        "marketer-schedule-secretary",
      ].includes(l.slug),
    ).map((l) => ({
      slug: l.slug,
      name: l.name,
      nameEn: l.nameEn,
      tagline: l.tagline,
      taglineEn: l.taglineEn,
      tone: l.tone,
    })),
  },
  {
    id: "bundle-shop-pro",
    slug: "shop-owner-pro",
    name: "쇼핑몰 사장 프로 팀",
    nameEn: "Shop Owner Pro Team",
    tagline: "스타터 + 가격 스카우터 + 키워드 발굴자",
    taglineEn: "Starter + Pricing Scout + Keyword Hunter",
    persona: "쇼핑몰",
    agents: SEED_LISTINGS.filter((l) => l.slug.startsWith("shop-")).map((l) => ({
      slug: l.slug,
      name: l.name,
      nameEn: l.nameEn,
      tagline: l.tagline,
      taglineEn: l.taglineEn,
      tone: l.tone,
    })),
  },
];

export function listSeedBundles(): Promise<TeamBundle[]> {
  return Promise.resolve(SEED_BUNDLES);
}

export function searchMarketplace(q: string): Promise<MarketplaceListing[]> {
  const needle = q.trim().toLowerCase();
  const matches = needle
    ? SEED_LISTINGS.filter(
        (l) =>
          l.name.toLowerCase().includes(needle) ||
          l.nameEn.toLowerCase().includes(needle) ||
          l.tagline.toLowerCase().includes(needle) ||
          l.taglineEn.toLowerCase().includes(needle) ||
          l.slug.includes(needle),
      )
    : SEED_LISTINGS;

  return Promise.resolve(
    matches.map((l) => ({
      slug: l.slug,
      name: l.name,
      nameEn: l.nameEn,
      tagline: l.tagline,
      taglineEn: l.taglineEn,
      trustGrade: l.trustGrade,
      installCount: l.installCount,
      manifestUrl: `https://agentlas.cloud/api/mcp/v1/manifest/agent/${l.slug}`,
    })),
  );
}

/** registry.installAgent에서 사용 — UI에 노출되지 않는 내부 lookup */
export function getSeedListingBySlug(
  slug: string,
): Promise<(SeedListing & MarketplaceListing) | null> {
  const found = SEED_LISTINGS.find((l) => l.slug === slug);
  if (!found) return Promise.resolve(null);
  return Promise.resolve({
    ...found,
    manifestUrl: `https://agentlas.cloud/api/mcp/v1/manifest/agent/${found.slug}`,
  });
}

// ── Firm 마켓 ───────────────────────────────────────────────
export function listSeedFirms(): Promise<FirmListing[]> {
  return Promise.resolve(SEED_FIRMS);
}

export function getSeedFirmBySlug(slug: string): Promise<FirmListing | null> {
  return Promise.resolve(SEED_FIRMS.find((f) => f.slug === slug) ?? null);
}
