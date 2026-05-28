// 외부 MCP 툴 카탈로그 — 사용자가 한 번에 연결할 수 있는 "외부 툴" 목록.
// 설정 가이드(setting_guide)의 Slack/Discord/GitHub 같은 통합들이 여기 산다.
//
// 대부분 stdio 트랜스포트로 `npx -y <패키지>` 형태. 연결 시 글로벌 vault의 env가
// 자식 프로세스에 주입된다. URL형(sse/http) MCP 서버도 지원.
//
// 이 목록은 "추천 큐레이션"일 뿐 — 사용자는 installCustom으로 임의 서버도 붙일 수 있다.
import type { McpToolCatalogEntry } from "../../shared/types";

export const MCP_TOOL_CATALOG: McpToolCatalogEntry[] = [
  // ── 커뮤니케이션 ──────────────────────────────────────────
  {
    id: "slack",
    name: "Slack",
    nameEn: "Slack",
    description: "채널 메시지 읽기·전송, 스레드 답글, 사용자 조회",
    descriptionEn: "Read/post channel messages, reply in threads, look up users",
    category: "communication",
    transport: "stdio",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-slack"],
    trust: "official",
    docsUrl: "https://github.com/modelcontextprotocol/servers/tree/main/src/slack",
    envRequirements: [
      {
        key: "SLACK_BOT_TOKEN",
        label: "Slack 봇 토큰",
        labelEn: "Slack Bot Token",
        required: true,
        hint: "api.slack.com/apps → OAuth & Permissions → Bot User OAuth Token (xoxb-...)",
        hintEn: "api.slack.com/apps → OAuth & Permissions → Bot User OAuth Token (xoxb-...)",
      },
      {
        key: "SLACK_TEAM_ID",
        label: "Slack 팀 ID",
        labelEn: "Slack Team ID",
        required: true,
        hint: "워크스페이스 설정 또는 URL의 T로 시작하는 ID",
        hintEn: "Workspace settings or the T-prefixed ID in the URL",
      },
    ],
  },
  {
    id: "discord",
    name: "Discord",
    nameEn: "Discord",
    description: "서버·채널 메시지 읽기/전송, 멤버 조회",
    descriptionEn: "Read/send server & channel messages, look up members",
    category: "communication",
    transport: "stdio",
    command: "npx",
    args: ["-y", "mcp-discord"],
    trust: "community",
    docsUrl: "https://github.com/barryyip0625/mcp-discord",
    envRequirements: [
      {
        key: "DISCORD_TOKEN",
        label: "Discord 봇 토큰",
        labelEn: "Discord Bot Token",
        required: true,
        hint: "discord.com/developers → Bot → Reset Token",
        hintEn: "discord.com/developers → Bot → Reset Token",
      },
    ],
  },

  // ── 개발 ──────────────────────────────────────────────────
  {
    id: "github",
    name: "GitHub",
    nameEn: "GitHub",
    description: "이슈·PR·코드 검색, 파일 읽기, 리포 관리",
    descriptionEn: "Search issues/PRs/code, read files, manage repos",
    category: "dev",
    transport: "stdio",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-github"],
    trust: "official",
    docsUrl: "https://github.com/modelcontextprotocol/servers/tree/main/src/github",
    envRequirements: [
      {
        key: "GITHUB_PERSONAL_ACCESS_TOKEN",
        label: "GitHub 개인 액세스 토큰",
        labelEn: "GitHub Personal Access Token",
        required: true,
        hint: "github.com/settings/tokens → Fine-grained 또는 classic 토큰",
        hintEn: "github.com/settings/tokens → fine-grained or classic token",
      },
    ],
  },
  {
    id: "filesystem",
    name: "파일 시스템",
    nameEn: "Filesystem",
    description: "허용한 로컬 폴더의 파일 읽기·쓰기·검색 (env 불필요)",
    descriptionEn: "Read/write/search files in folders you allow (no env)",
    category: "dev",
    transport: "stdio",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-filesystem", "~"],
    trust: "official",
    docsUrl: "https://github.com/modelcontextprotocol/servers/tree/main/src/filesystem",
    envRequirements: [],
  },
  {
    id: "postgres",
    name: "PostgreSQL",
    nameEn: "PostgreSQL",
    description: "읽기 전용 SQL 쿼리, 스키마 조회",
    descriptionEn: "Read-only SQL queries and schema inspection",
    category: "data",
    transport: "stdio",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-postgres"],
    trust: "official",
    docsUrl: "https://github.com/modelcontextprotocol/servers/tree/main/src/postgres",
    envRequirements: [
      {
        key: "DATABASE_URL",
        label: "PostgreSQL 연결 문자열",
        labelEn: "PostgreSQL connection string",
        required: true,
        hint: "postgres://user:pass@host:5432/dbname",
        hintEn: "postgres://user:pass@host:5432/dbname",
      },
    ],
  },

  // ── 생산성 ────────────────────────────────────────────────
  {
    id: "notion",
    name: "Notion",
    nameEn: "Notion",
    description: "페이지·데이터베이스 검색, 읽기, 생성",
    descriptionEn: "Search, read, and create pages & databases",
    category: "productivity",
    transport: "stdio",
    command: "npx",
    args: ["-y", "@notionhq/notion-mcp-server"],
    trust: "official",
    docsUrl: "https://github.com/makenotion/notion-mcp-server",
    envRequirements: [
      {
        key: "NOTION_API_KEY",
        label: "Notion 통합 키",
        labelEn: "Notion Integration Key",
        required: true,
        hint: "notion.so/my-integrations → Internal Integration Token (secret_...)",
        hintEn: "notion.so/my-integrations → Internal Integration Token (secret_...)",
      },
    ],
  },
  {
    id: "linear",
    name: "Linear",
    nameEn: "Linear",
    description: "이슈 생성·검색·업데이트, 프로젝트 조회",
    descriptionEn: "Create/search/update issues, view projects",
    category: "productivity",
    transport: "stdio",
    command: "npx",
    args: ["-y", "mcp-linear"],
    trust: "community",
    docsUrl: "https://github.com/tacticlaunch/mcp-linear",
    envRequirements: [
      {
        key: "LINEAR_API_KEY",
        label: "Linear API 키",
        labelEn: "Linear API Key",
        required: true,
        hint: "linear.app → Settings → Security & access → API → Personal API key",
        hintEn: "linear.app → Settings → Security & access → API → Personal API key",
      },
    ],
  },

  // ── 웹 ────────────────────────────────────────────────────
  {
    id: "brave-search",
    name: "Brave 검색",
    nameEn: "Brave Search",
    description: "웹·로컬 검색 (실시간 정보)",
    descriptionEn: "Web & local search (real-time info)",
    category: "web",
    transport: "stdio",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-brave-search"],
    trust: "official",
    docsUrl: "https://github.com/modelcontextprotocol/servers/tree/main/src/brave-search",
    envRequirements: [
      {
        key: "BRAVE_API_KEY",
        label: "Brave Search API 키",
        labelEn: "Brave Search API Key",
        required: true,
        hint: "brave.com/search/api → 무료 플랜 API 키",
        hintEn: "brave.com/search/api → free-plan API key",
      },
    ],
  },
];

export function getCatalogEntry(id: string): McpToolCatalogEntry | null {
  return MCP_TOOL_CATALOG.find((e) => e.id === id) ?? null;
}
