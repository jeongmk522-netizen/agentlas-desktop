// Main 프로세스 ↔ Renderer 간 공유 타입.
// renderer/lib/types.ts에서 re-export.

export type RuntimeKind = "claude-code" | "codex" | "gemini" | "byok";

export type RuntimeBackend = "anthropic" | "openai" | "google";

export interface RuntimeSelection {
  kind: RuntimeKind;
  backend?: RuntimeBackend;
  source?: string;
}

export interface RuntimeStatus {
  kind: RuntimeKind;
  backend: RuntimeBackend;
  /** CLI 경로 또는 "byok:<backend>" */
  source: string;
  /** CLI 감지된 버전 — BYOK은 null */
  version: string | null;
  /** 사용자가 현재 이 백엔드를 활성으로 선택했는지 */
  active: boolean;
}

/**
 * 에이전트가 동작하려면 필요한 환경변수 1개.
 * 예: Notion 통합 에이전트는 NOTION_API_KEY 필요.
 *
 * 데스크톱 글로벌 vault(keychain)에 한 번 저장하면 모든 에이전트가 재사용.
 * MCP 서버 spawn 시 자식 프로세스 env로 자동 주입 (M1).
 */
export interface AgentEnvRequirement {
  /** env 키 이름 — 외부 표준 따라가는 게 좋음 (NOTION_API_KEY 등) */
  key: string;
  label: string;
  labelEn: string;
  /** false면 없어도 동작은 함 (제한된 기능) */
  required: boolean;
  /** 어디서 얻는지 한 줄 안내 (URL이면 클릭 가능하게) */
  hint?: string;
  hintEn?: string;
}

export interface InstalledAgent {
  id: string;
  slug: string;
  /** 한국어 표시명 (기본 / fallback) */
  name: string;
  /** 영어 표시명. 비어있으면 name fallback */
  nameEn: string;
  /** 한국어 한 줄 설명 */
  tagline: string;
  /** 영어 한 줄 설명 */
  taglineEn: string;
  /** LLM에 보낼 시스템 프롬프트 — 단일. LLM이 사용자 입력 언어에 자동 매칭 */
  systemPrompt: string;
  mcpServers: string[];
  /** 이 에이전트가 동작에 필요한 env 변수들 */
  envRequirements: AgentEnvRequirement[];
  preferredBackend: RuntimeBackend | null;
  trustGrade: "A" | "B" | "C" | "unknown";
  installedAt: string;
  tone: "blue" | "green" | "purple" | "amber" | "peach";
}

/**
 * UI용 env 메타 — 값 자체는 main에만, renderer는 hasValue boolean만 받는다.
 */
export interface EnvVarMeta {
  key: string;
  hasValue: boolean;
  /** 이 env를 요구하는 설치된 에이전트들 (없으면 사용자가 직접 추가한 free-form) */
  requiredBy: Array<{
    agentId: string;
    agentName: string;
    agentNameEn: string;
    /** 그 에이전트의 envRequirements에서 따온 라벨 — 키별로 다른 라벨 가능 */
    label?: string;
    labelEn?: string;
    hint?: string;
    hintEn?: string;
  }>;
}

export interface TeamBundle {
  id: string;
  slug: string;
  name: string;
  nameEn: string;
  tagline: string;
  taglineEn: string;
  persona: string;
  agents: Array<Pick<InstalledAgent, "slug" | "name" | "nameEn" | "tagline" | "taglineEn" | "tone">>;
}

export interface MarketplaceListing {
  slug: string;
  name: string;
  nameEn: string;
  tagline: string;
  taglineEn: string;
  trustGrade: "A" | "B" | "C" | "unknown";
  installCount: number;
  manifestUrl: string;
}

export interface MarketplaceSourceStatus {
  mode: "mcp" | "memory";
  baseUrl: string | null;
  online: boolean;
  usingFallback: boolean;
  lastError: string | null;
  lastCheckedAt: string | null;
}

// ── Firm = 위계 조직을 가진 에이전트 회사 풀패키지 ──────────
// Agentlas 웹의 핵심 — 데스크톱은 설치된 firm을 갖고 채팅/자동화.
//
// 예: "쇼핑몰 운영 풀패키지"
//   CEO (오케스트레이터 에이전트) — 사용자 명령 수신, 부서장에게 위임
//   ├─ 콘텐츠 부서장 → 상품설명 작가, 광고 카피라이터
//   ├─ CS 부서장 → CS 답변 도우미, 리뷰 모니터
//   └─ 분석 부서장 → 가격 스카우터, 키워드 발굴자
export interface FirmOrgNode {
  /** 이 노드의 에이전트 slug */
  agentSlug: string;
  /** "CEO" / "마케팅 부서장" / "디자이너" 같은 회사 내 역할 */
  role: string;
  /** 상사 agentSlug — null이면 최상위(CEO) */
  reportsTo: string | null;
}

export interface FirmListing {
  /** 마켓 slug */
  slug: string;
  /** 회사 이름 (한국어) */
  name: string;
  nameEn: string;
  /** 한 줄 설명 (한국어) */
  tagline: string;
  taglineEn: string;
  /** ICP / 페르소나 */
  persona: string;
  /** CEO 에이전트 slug (orgChart에 반드시 포함, reportsTo === null) */
  ceoSlug: string;
  /** 조직도 */
  orgChart: FirmOrgNode[];
  /** 의존하는 모든 에이전트 slug (설치 시 한꺼번에 install) */
  agentSlugs: string[];
}

export interface InstalledFirm {
  id: string;
  slug: string;
  name: string;
  nameEn: string;
  tagline: string;
  taglineEn: string;
  persona: string;
  /** orgChart의 CEO 에이전트 id (installed_agents.id, slug 아님) */
  ceoAgentId: string;
  /** orgChart의 각 노드를 installed agent id로 resolve */
  orgChart: Array<FirmOrgNode & { agentId: string }>;
  installedAt: string;
}

// ── 프로젝트 / 채팅 (Claude Desktop / Codex 스타일) ──────────
export interface Project {
  id: string;
  name: string;
  description: string | null;
  /** 프로젝트의 기본 에이전트 (선택). 없으면 채팅마다 골라야 함 */
  defaultAgentId: string | null;
  /** 프로젝트 단위로 시스템 프롬프트에 더 얹을 컨텍스트 */
  contextNote: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface Chat {
  id: string;
  /** 프로젝트 소속이면 그 id, 아니면 null */
  projectId: string | null;
  /** 회사 채팅이면 firm id, 아니면 null. firmId가 있으면 agentId = firm.ceoAgentId */
  firmId: string | null;
  /** 이 채팅에 묶인 에이전트 (개별) 또는 firm의 CEO 에이전트 */
  agentId: string;
  /** 사용자 첫 메시지로 자동 생성된 제목 (사용자 rename 가능) */
  title: string;
  /** 보관 시각 — null이면 활성, 있으면 사이드바에서 숨김 (보관함에서만 보임) */
  archivedAt: string | null;
  createdAt: string;
  /** 마지막 메시지 시각 — 사이드바 정렬 키 */
  updatedAt: string;
}

export interface ChatHistoryEntry {
  id: string;
  role: "user" | "assistant" | "system";
  text: string;
  createdAt: string;
  /** 사용자 메시지에 첨부된 이미지 — 영구화는 V1, 현재는 in-flight만 */
  imageDataUrls?: string[];
}

// ── 자동화 (M0 stub — UI만 구현, 실제 cron은 M1) ────────────
export interface Automation {
  id: string;
  name: string;
  /** "매일 9시", "매주 월 14:00" 같은 사용자 친화 텍스트 */
  scheduleHuman: string;
  /** 자동화 타깃: "agent"면 agentId, "firm"이면 firmId (CEO 호출) */
  targetType: "agent" | "firm";
  /** targetType에 따라 installed_agents.id 또는 installed_firms.id */
  targetId: string;
  /** 실행 시 사용자 입력 대신 들어갈 프롬프트 템플릿 */
  promptTemplate: string;
  enabled: boolean;
  createdAt: string;
  lastRunAt: string | null;
}

// ── invocation ───────────────────────────────────────────────
export interface ImageAttachment {
  /** "image/png" | "image/jpeg" | "image/gif" | "image/webp" */
  mediaType: string;
  /** base64 (data: 접두사 없이 순수 인코딩) */
  data: string;
}

export interface McpInvocationRequest {
  /** 새 모델: chatId 기반. 에이전트는 chat에서 lookup */
  chatId: string;
  userPrompt: string;
  /** 첨부 이미지 — BYOK API는 멀티모달로 전송. CLI는 무시 (warning 추가) */
  images?: ImageAttachment[];
  /** UI 사용자 locale — main이 emit하는 상태/오류 메시지가 이 언어로 나옴.
   *  영어 사용자에게 한국어 status가 새지 않도록 renderer가 항상 동봉. */
  locale?: "ko" | "en";
}

export interface McpInvocationEvent {
  kind: "thinking" | "tool-use" | "partial" | "final" | "error";
  status?: string;
  text?: string;
  error?: { code: string; message: string };
}

/** 워킹 폴더 트리의 한 엔트리 — lazy expand. dir이면 hasChildren 힌트로 chevron 표시. */
export interface WorkspaceNode {
  name: string;
  /** 절대 경로 — 다음 expand 요청에 그대로 사용 */
  path: string;
  kind: "dir" | "file";
  size: number;
  hasChildren?: boolean;
  isTextLike?: boolean;
}

export interface DirListing {
  path: string;
  exists: boolean;
  entries: WorkspaceNode[];
}

export interface TextFilePreview {
  path: string;
  content: string;
  truncated: boolean;
  size: number;
  reason?: "binary" | "too-large" | "not-text-ext";
}

/** 로그인 세션 — 백엔드(agentlas.cloud)에서 cookie 기반으로 받아 main에 보관. renderer는 메타만. */
export interface AuthSession {
  /** 로그인되어 있으면 true */
  signedIn: boolean;
  email?: string;
  name?: string;
  workspaceId?: string;
  /** 세션이 만료될 epoch ms — 알 수 없으면 미설정 */
  expiresAt?: number;
}

/** electron-updater의 자동 업데이트 상태. main → renderer로 broadcast. */
export interface UpdaterState {
  status:
    | "idle"
    | "checking"
    | "available"
    | "downloading"
    | "downloaded"
    | "not-available"
    | "error";
  /** update-available / update-downloaded 시 채워짐 */
  version?: string;
  /** download-progress의 백분율 (0-100). downloading 상태일 때만 의미 있음 */
  progress?: number;
  error?: string;
}

export interface AgentlasIpc {
  /** Electron 메인이 알려주는 OS 환경 정보 (Apple/Codex/Claude 데스크톱과 동일 패턴) */
  app: {
    /** macOS 시스템 설정의 1순위 언어 — "ko-KR" / "en-US" 등. i18n 자동 감지에 사용 */
    getLocale: () => Promise<string>;
    /** package.json의 version — 사이드바 푸터 표기/디버그 용 */
    getVersion: () => Promise<string>;
  };
  /** 워킹 폴더 — 채팅 우측의 폴더 트리 패널이 사용. read-only. */
  fs: {
    pickDirectory: () => Promise<string | null>;
    listDirectory: (absPath: string, showHidden?: boolean) => Promise<DirListing>;
    readTextFile: (absPath: string) => Promise<TextFilePreview>;
  };
  /** 채팅마다 마지막에 연 워킹 폴더 — SQLite에 저장. null이면 미설정. */
  workspace: {
    get: (chatId: string) => Promise<string | null>;
    set: (chatId: string, absPath: string | null) => Promise<void>;
  };
  /** 로그인 — agentlas.cloud 구글 OAuth. BrowserWindow 열고 cookie 추출 → Keychain. */
  auth: {
    /** 현재 세션 메타데이터 — 로그인되어 있지 않으면 signedIn=false */
    getSession: () => Promise<AuthSession>;
    /** Google 로그인 시작 — BrowserWindow를 띄우고 사용자가 끝낼 때까지 await */
    signInWithGoogle: () => Promise<AuthSession>;
    signOut: () => Promise<void>;
  };
  /** 자동 업데이트 — electron-updater 래퍼. broadcast는 window.agentlasUpdater.onState로 받음. */
  updater: {
    /** 마운트 직후 현재 상태 동기 조회. broadcast 이전에 새 창이 열려도 onState로 미스되지 않음. */
    getState: () => Promise<UpdaterState>;
    /** 사용자가 "지금 확인" 누름 — 실패해도 throw 안 함 (에러는 broadcast로) */
    check: () => Promise<void>;
    /** "재시작 업데이트" 클릭. downloaded 상태에서만 실제로 동작 */
    install: () => Promise<void>;
  };
  runtime: {
    detect: () => Promise<RuntimeStatus[]>;
    setActive: (selection: RuntimeSelection) => Promise<RuntimeStatus[]>;
  };
  secrets: {
    saveApiKey: (backend: RuntimeBackend, key: string) => Promise<void>;
    hasApiKey: (backend: RuntimeBackend) => Promise<boolean>;
    deleteApiKey: (backend: RuntimeBackend) => Promise<void>;
  };
  /** 글로벌 env vault — 에이전트들이 공유하는 외부 API 키.
   *  값은 macOS Keychain에 저장, renderer는 metadata만 받음.
   *  M1: MCP 서버 spawn 시 envRequirements 매칭해 자동 주입. */
  env: {
    /** 모든 env 키 + 등록 여부 + 어떤 에이전트가 요구하는지 */
    list: () => Promise<EnvVarMeta[]>;
    /** 값 저장 (편집도 동일) */
    set: (key: string, value: string) => Promise<void>;
    /** 값 존재 여부만 — 실제 값은 renderer로 안 보냄 */
    has: (key: string) => Promise<boolean>;
    remove: (key: string) => Promise<void>;
  };
  team: {
    list: () => Promise<InstalledAgent[]>;
    install: (slug: string) => Promise<InstalledAgent>;
    uninstall: (id: string) => Promise<void>;
  };
  marketplace: {
    listBundles: () => Promise<TeamBundle[]>;
    search: (q: string) => Promise<MarketplaceListing[]>;
    listFirms: () => Promise<FirmListing[]>;
    status: () => Promise<MarketplaceSourceStatus>;
  };
  firms: {
    list: () => Promise<InstalledFirm[]>;
    get: (id: string) => Promise<InstalledFirm | null>;
    install: (slug: string) => Promise<InstalledFirm>;
    uninstall: (id: string) => Promise<void>;
  };
  projects: {
    list: () => Promise<Project[]>;
    create: (input: { name: string; defaultAgentId?: string | null; contextNote?: string | null }) => Promise<Project>;
    get: (id: string) => Promise<Project | null>;
    update: (id: string, patch: Partial<Pick<Project, "name" | "contextNote" | "defaultAgentId">>) => Promise<Project>;
    remove: (id: string) => Promise<void>;
  };
  chats: {
    /** 최신순 활성 채팅 (보관된 것 제외). 사이드바 "최근 채팅" 섹션에서 사용 */
    listRecent: (limit?: number) => Promise<Chat[]>;
    /** 보관된 채팅 — 보관함 페이지용 */
    listArchived: () => Promise<Chat[]>;
    listByProject: (projectId: string) => Promise<Chat[]>;
    listByFirm: (firmId: string) => Promise<Chat[]>;
    get: (id: string) => Promise<Chat | null>;
    /** firmId가 있으면 firm의 CEO 에이전트로 자동 묶임. agentId 직접 지정도 가능 (개별 에이전트) */
    create: (input: {
      agentId?: string;
      firmId?: string | null;
      projectId?: string | null;
      title?: string;
    }) => Promise<Chat>;
    rename: (id: string, title: string) => Promise<Chat>;
    /** 채팅의 에이전트 변경. firm 채팅이면 firm 해제 후 개별 에이전트 모드로 전환 */
    switchAgent: (id: string, agentId: string) => Promise<Chat>;
    /** 보관 — 사이드바에서 숨김. 채팅·메시지는 그대로 유지 */
    archive: (id: string) => Promise<Chat>;
    /** 보관 해제 — 다시 사이드바에 등장 */
    unarchive: (id: string) => Promise<Chat>;
    /** 영구 삭제 — 메시지까지 cascade */
    remove: (id: string) => Promise<void>;
  };
  automations: {
    list: () => Promise<Automation[]>;
    /** M0: 메모리 stub. M1에서 SQLite + 실제 스케줄러 */
    create: (input: Omit<Automation, "id" | "createdAt" | "lastRunAt" | "enabled">) => Promise<Automation>;
    toggle: (id: string, enabled: boolean) => Promise<Automation>;
    remove: (id: string) => Promise<void>;
  };
  /** invoke:run의 chatId가 firm 채팅인지 일반 채팅인지로 자동 라우팅 */
  invoke: {
    run: (req: McpInvocationRequest) => Promise<{ runId: string }>;
    eventChannel: (runId: string) => string;
    history: (chatId: string) => Promise<ChatHistoryEntry[]>;
    clearHistory: (chatId: string) => Promise<void>;
  };
}

declare global {
  interface Window {
    agentlas: AgentlasIpc;
  }
}

/** preload가 contextBridge로 노출하는 updater 이벤트 채널 — onState 구독자에게 UpdaterState 푸시. */
export interface AgentlasUpdaterEvents {
  onState: (handler: (state: UpdaterState) => void) => () => void;
}
