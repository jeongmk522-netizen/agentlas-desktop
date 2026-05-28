// 가벼운 i18n — 의존성 0. 자동 감지 + 사용자 override.
//
// 우선순위:
//   1) localStorage["agentlas.locale"] (사용자 override)
//   2) IPC app.getLocale() → macOS "시스템 설정 > 언어 및 지역" 1순위
//   3) "en" fallback
//
// Codex / Claude Desktop과 동일한 패턴 (별도 첫 화면 언어 선택 안 함).
"use client";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react";
import { ipc } from "./ipc";

export type Locale = "ko" | "en";
export type LocalePref = Locale | "system";

const STORAGE_KEY = "agentlas.locale";

// ── 사전 ──────────────────────────────────────────────────
// 새 문구 추가: ko/en 모두에 키를 추가하면 됨. 누락 시 타입 에러.
const dict = {
  ko: {
    // App-wide
    "app.name": "Agentlas",
    "app.tagline": "이미 내고 있는 구독으로 어시스턴트 팀을 무료로",

    // Sidebar sections
    "sidebar.new_chat": "새 채팅",
    "sidebar.chats": "채팅",
    "sidebar.firms": "회사",
    "sidebar.projects": "프로젝트",
    "sidebar.automations": "자동화",
    "sidebar.library": "라이브러리",
    "sidebar.agents": "에이전트",
    "sidebar.skills": "스킬",
    "sidebar.mcps": "MCP 서버",
    "sidebar.marketplace": "마켓플레이스",
    "sidebar.settings": "설정",
    "sidebar.archive": "보관함",
    "sidebar.empty_chats": "대화를 시작하면 여기 쌓여요",
    "sidebar.empty_firms_install": "회사 설치하기",
    "sidebar.empty_firms_hint": "CEO에게 일을 시키는 풀패키지",
    "sidebar.empty_projects": "첫 프로젝트 만들기",
    "sidebar.empty_automations": "자동화 만들기",
    "sidebar.collapse": "사이드바 접기",
    "sidebar.expand": "사이드바 펴기",
    "sidebar.backend_label": "백엔드",
    "sidebar.backend_none": "백엔드 미연결",
    "sidebar.byoc_free": "BYOC · 무료",

    // Chat row actions
    "chat.untitled": "새 채팅",
    "chat.action.rename": "이름 변경",
    "chat.action.archive": "보관",
    "chat.action.unarchive": "보관 해제",
    "chat.action.delete": "삭제",
    "chat.confirm_delete": "이 채팅을 삭제할까요? 메시지가 모두 사라집니다.",
    "chat.status.sending": "전송 중...",
    "chat.err.unknown": "알 수 없는 오류",

    // Onboarding
    "onb.welcome.title": "Agentlas에 오신 걸 환영해요",
    "onb.welcome.tagline": "이미 내고 있는 Claude · ChatGPT · Gemini 구독으로\n전문 어시스턴트 팀을 무료로 돌립니다.",
    "onb.highlight.free.title": "앱 자체 무료",
    "onb.highlight.free.desc": "구독 두 번 안 받습니다",
    "onb.highlight.key.title": "키는 로컬만",
    "onb.highlight.key.desc": "OS 키체인에 저장",
    "onb.highlight.team.title": "당신만의 팀",
    "onb.highlight.team.desc": "에이전트를 직접 골라 구성",

    // Positioning (홈 + 온보딩 핵심 가치 — Mason 포지셔닝)
    "pitch.threeInOne.title": "한 앱에 백엔드 3개",
    "pitch.threeInOne.desc": "Claude · ChatGPT · Gemini 구독을 그대로 활용",
    "pitch.hermes.title": "헤르메스 메모리 기본 탑재",
    "pitch.hermes.desc": "에이전트가 쓰면서 스스로 진화하는 컨텍스트",
    "pitch.firm.title": "에이전트 회사 원클릭",
    "pitch.firm.desc": "CEO 한 명에게 명령하면 부서로 위임",
    "pitch.opensource": "오픈소스 데스크톱 — Agentlas 계정 없이도 동작",
    "onb.step.prev": "이전",
    "onb.step.next": "다음",
    "onb.step.start": "시작하기",
    "onb.step.skip": "건너뛰기",
    "onb.backend.title": "백엔드 연결",
    "onb.backend.desc": "Agentlas는 LLM을 호스팅하지 않습니다. 당신의 머신에서 당신의 구독/키로 직접 호출합니다.",
    "onb.backend.detected_cli": "감지된 CLI",
    "onb.backend.no_cli": "로컬에 Claude Code / Codex / Gemini CLI가 설치되어 있지 않습니다. CLI 없이도 아래에서 API 키로 연결할 수 있어요.",
    "onb.backend.byok_title": "또는 API 키 (BYOK)",
    "onb.backend.byok_save": "저장",
    "onb.backend.ready": "연결 준비 완료. 다음 단계로 진행하세요.",
    "onb.backend.tip": "CLI 1개 또는 API 키 1개만 있으면 시작할 수 있습니다.",
    "onb.tour.title": "메뉴 안내",
    "onb.tour.desc": "왼쪽 사이드바에 있는 항목들이에요. ⌘[로 접고 펼 수 있습니다.",
    "onb.done.title": "준비 완료",
    "onb.done.desc": "다음 화면에서 어시스턴트 팀을 골라 설치하세요.",

    // Marketplace
    "market.title.before": "원하는 방식으로",
    "market.title.after": "를 활용하세요",
    "market.search.firms": "회사 검색",
    "market.search.bundles": "번들 검색",
    "market.search.agents": "에이전트 검색",
    "market.tab.firms": "회사",
    "market.tab.bundles": "번들",
    "market.tab.agents": "에이전트",
    "market.btn.manage": "관리",
    "market.btn.create": "만들기",
    "market.section.recommended_firms": "권장 회사",
    "market.section.recommended_bundles": "권장 번들",
    "market.section.recommended_agents": "개별 에이전트",
    "market.empty_firms": "이 페르소나의 회사는 아직 준비 중입니다.",
    "market.empty_bundles": "이 페르소나의 번들은 아직 준비 중입니다.",
    "market.empty_agents": "검색 결과 없음",
    "market.hero.install": "회사 통째로 설치",
    "market.hero.chat": "채팅에서 사용해 보세요",
    "market.installed": "설치됨",
    "market.install": "설치",

    // Persona labels
    "persona.all": "전체",
    "persona.shop": "쇼핑몰 사장",
    "persona.marketer": "1인 마케터",
    "persona.realestate": "부동산 중개",
    "persona.creator": "크리에이터",

    // Home composer
    "home.title": "오늘 뭐 도와드릴까요?",
    "home.subtitle.firm": "{name} CEO에게 명령하세요. 부서로 위임됩니다.",
    "home.subtitle.agent": "{name}에게 말해 보세요. ⌘↵로 보냅니다.",
    "home.subtitle.empty": "에이전트나 회사를 골라 시작하세요.",
    "home.mode.agent": "개별 에이전트",
    "home.mode.firm": "회사",
    "home.placeholder": "에이전트에게 할 일을 적어 주세요…",
    "home.send": "보내기",
    "home.starting": "시작 중…",
    "home.market_link": "마켓",

    // ChatInput
    "chatinput.placeholder": "에이전트에게 할 일을 적어 주세요 — ⌘↵ · 이미지 드래그·붙여넣기 가능",
    "chatinput.placeholder_rich": "에이전트에게 할 일을 적어 주세요 — / 커맨드 · @ 멘션 · ⌘↵ 보내기",
    "chatinput.placeholder_disabled": "에이전트가 없습니다 — 마켓에서 설치하세요",
    "chatinput.attach": "이미지 첨부 — 드래그·드롭·붙여넣기",
    "chatinput.remove_image": "이미지 제거",
    "chatinput.image_too_large": "{name}은 5MB를 초과합니다.",
    "chatinput.send": "보내기",
    "chatinput.plus": "추가 — 파일·플러그인·모드",
    "chatinput.slash": "슬래시 커맨드",
    "chatinput.mention": "에이전트·프로젝트·회사 멘션",
    "chatinput.slash_title": "슬래시 커맨드",
    "chatinput.mention_title": "멘션",
    "chatinput.no_match": "일치 없음",
    "chatinput.no_plugins": "설치된 에이전트가 없어 플러그인이 비어 있습니다.",
    "chatinput.cmd.new": "새 채팅 시작",
    "chatinput.cmd.clear": "이 채팅 메시지 모두 지우기",
    "chatinput.cmd.help": "키보드 단축키 보기",
    "chatinput.plus.attach": "사진 및 파일 추가",
    "chatinput.plus.plugins": "플러그인 (MCP 서버)",
    "chatinput.plan_mode": "플랜 모드",
    "chatinput.goal_mode": "목표 추진",
    "chatinput.perm.title": "에이전트 권한",
    "chatinput.perm.read": "읽기만",
    "chatinput.perm.read.desc": "파일·외부 자료 읽기만, 쓰기·실행 차단",
    "chatinput.perm.write": "읽기 + 쓰기",
    "chatinput.perm.write.desc": "파일 수정 OK, 셸·외부 자동 호출은 차단",
    "chatinput.perm.full": "전체 권한",
    "chatinput.perm.full.desc": "셸 명령·외부 API 호출 자동 허용 (주의)",
    "chatstream.empty_title": "{name}와 채팅 시작",
    "chatstream.firm_mode": "회사 모드 · CEO · {name}",
    "chatstream.empty_hint": "아래 입력창에 자연어로 적어 ⌘↵",
    "chatstream.copy": "복사",
    "chatstream.working_for": "생각 중 · {sec}",
    "chatstream.took": "{sec} 만에 완료",
    "chatstream.lines": "{count}줄",
    "chatstream.open_panel": "우측 패널에서 보기",
    "chatstream.panel": "패널 ↗",
    "chatstream.close_panel": "패널 닫기",
    "chatstream.close": "닫기 (Esc)",

    // Settings
    "settings.title": "설정 — 백엔드 연결",
    "settings.banner": "Agentlas는 LLM을 호스팅하지 않습니다. 모든 호출은 당신의 머신에서, 당신의 구독/키로 직접 발생합니다. API 키는 OS 키체인에만 저장되고 Agentlas 서버를 거치지 않습니다.",
    "settings.detected": "감지된 백엔드",
    "settings.byok": "BYOK — 직접 API 키 연결",
    "settings.byok.note": "키는 macOS Keychain에만 저장됩니다. Agentlas 서버를 거치지 않습니다.",
    "settings.active": "활성화",
    "settings.activated": "활성",
    "settings.save": "저장",
    "settings.delete": "삭제",
    "settings.saved": "저장됨",
    "settings.no_backends": "연결된 백엔드가 없습니다. 아래 BYOK 키를 등록하거나 CLI를 설치해 주세요.",
    "settings.lang.title": "언어",
    "settings.lang.system": "시스템 (자동)",
    "settings.lang.ko": "한국어",
    "settings.lang.en": "English",

    // Firm detail
    "firm.kind": "회사",
    "firm.ceo.command": "CEO에게 명령",
    "firm.section.orgchart": "조직도",
    "firm.section.chats": "이 회사와의 채팅",
    "firm.confirm_uninstall": "{name} 회사를 제거할까요? 소속 에이전트와 채팅은 그대로 남습니다.",
    "firm.empty_chats": "아직 회사 채팅이 없습니다. 우측 상단 CEO에게 명령으로 시작하세요.",

    // Project
    "project.kind": "프로젝트",
    "project.new.title": "새 프로젝트",
    "project.field.name": "이름",
    "project.field.name.hint": "예: 쇼핑몰 6월 캠페인, Q3 리서치",
    "project.field.context": "컨텍스트 노트",
    "project.field.context.hint": "이 프로젝트의 모든 채팅에 자동으로 추가되는 시스템 메모.",
    "project.field.default_agent": "기본 에이전트",
    "project.field.default_agent.hint": "이 프로젝트에서 새 채팅을 만들 때 자동으로 선택됨",
    "project.btn.create": "만들기",
    "project.btn.creating": "만드는 중...",
    "project.section.note": "컨텍스트 노트",
    "project.add_note": "+ 컨텍스트 노트 추가",
    "project.section.chats": "채팅",
    "project.empty_chats": "아직 채팅이 없습니다. 우측 상단 새 채팅으로 시작하세요.",
    "project.new_chat": "새 채팅",
    "project.confirm_delete": "'{name}' 프로젝트를 삭제할까요? 채팅은 root로 옮겨집니다.",

    // Automation
    "auto.title": "자동화",
    "auto.new": "새 자동화",
    "auto.stub_note": "M0 stub — UI는 동작하지만 실제 스케줄링은 V1에서 활성화됩니다. 기록한 항목은 앱을 다시 열면 사라집니다.",
    "auto.empty": "등록된 자동화가 없습니다. 우측 상단 새 자동화로 시작하세요.",
    "auto.on": "활성",
    "auto.off": "꺼짐",
    "auto.confirm_delete": "자동화를 삭제할까요?",
    "auto.field.name": "이름",
    "auto.field.name.placeholder": "예: 매일 인스타 캡션 3개",
    "auto.field.schedule": "언제 실행할까요?",
    "auto.field.target": "누구에게 시킬까요?",
    "auto.field.prompt": "기본 프롬프트",
    "auto.field.prompt.hint": "자동 실행될 때 사용자 입력으로 들어갈 텍스트",
    "auto.target.firm": "회사",
    "auto.target.agent": "개별 에이전트",
    "auto.empty_firms": "설치된 회사가 없습니다. 마켓플레이스 → 회사 탭에서 설치하세요.",
    "auto.empty_agents": "설치된 에이전트가 없습니다.",
    "auto.detail.firm_label": "회사 (CEO 위임)",
    "auto.detail.agent_label": "에이전트",
    "auto.preset.daily9": "매일 오전 9시",
    "auto.preset.weekday9": "평일 오전 9시",
    "auto.preset.weekly_mon10": "매주 월요일 오전 10시",
    "auto.preset.monthly1": "매월 1일 오전 9시",
    "auto.placeholder.firm": "예: 오늘 회사 차원에서 해야 할 일을 정리해줘",
    "auto.placeholder.agent": "예: 오늘 인스타 캡션 3개 만들어줘",
    "auto.row.schedule_with": "{schedule} · {target}",
    "auto.detail.schedule": "실행 주기",
    "auto.detail.last_run": "마지막 실행",
    "auto.detail.never": "아직 실행된 적 없음",
    "auto.detail.prompt": "프롬프트",
    "auto.detail.stub": "M0 stub — 실제 스케줄링은 V1에서. 앱을 다시 열면 메모리 저장이 비워집니다.",

    // Library
    "library.agents.subtitle": "내 팀에 설치된 어시스턴트",
    "library.agents.add": "+ 마켓에서 추가",
    "library.agents.empty": "아직 설치된 에이전트가 없습니다.",
    "library.agents.confirm_uninstall": "{name} 를 제거할까요? 채팅 기록도 함께 삭제됩니다.",
    "library.skills.title": "스킬 라이브러리",
    "library.skills.desc": "스킬은 에이전트가 호출하는 작은 작업 단위. Agentlas 웹 포털에서 만들면 자동 동기화됩니다.",
    "library.skills.coming": "곧 출시 — 스킬 마켓 + 원클릭 설치는 V1.",
    "library.mcps.desc": "설치된 에이전트가 의존하는 MCP 서버 목록.",
    "library.mcps.empty": "에이전트를 설치하면 여기 모입니다.",
    "library.mcps.used_by": "{n}개 에이전트 사용",

    // Archive
    "archive.empty": "보관된 채팅 없음",

    // Env vault (Library > Environment)
    "env.title": "환경변수",
    "env.subtitle": "에이전트들이 공유하는 외부 API 키. 한 번 저장하면 모든 에이전트가 자동으로 가져갑니다.",
    "env.security_note": "값은 macOS Keychain에만 저장됩니다. Agentlas 서버를 거치지 않고, 채팅 화면이나 다른 에이전트에 노출되지 않습니다.",
    "env.add_new": "+ 새 변수 추가",
    "env.field.key": "변수 이름",
    "env.field.key.placeholder": "예: NOTION_API_KEY, SLACK_TOKEN",
    "env.field.value": "값",
    "env.field.value.placeholder": "값 붙여넣기",
    "env.required_by": "{n}개 에이전트 사용",
    "env.required_by_none": "직접 추가한 변수",
    "env.saved": "저장됨",
    "env.not_set": "값 없음",
    "env.optional": "선택",
    "env.required": "필수",
    "env.empty": "등록된 환경변수가 없습니다. 위 + 새 변수 추가 또는 에이전트가 요구하는 변수가 자동으로 표시됩니다.",
    "env.confirm_delete": "{key}를 삭제할까요?",

    // Common
    "common.cancel": "취소",
    "common.save": "저장",
    "common.back": "이전",
    "common.delete": "삭제",
    "common.edit": "편집",
    "common.skip_select": "선택 안 함",
    "common.created_at": "{when}",

    // Auto-update (electron-updater)
    "update.downloading": "업데이트 다운로드 중 · {pct}%",
    "update.ready": "새 버전 준비됨 · v{version}",
    "update.restart_now": "재시작 업데이트",
    "update.dismiss": "나중에",
    "update.checking": "업데이트 확인 중…",
    "update.uptodate": "최신 버전입니다",
    "update.error_short": "업데이트 확인 실패",

    // Account
    "account.sign_in": "Google로 로그인",
    "account.signing_in": "로그인 중…",
    "account.sign_out": "로그아웃",
    "account.signed_in": "계정",
    "account.required.title": "로그인이 필요합니다",
    "account.required.body": "마켓에서 에이전트를 가져오려면 먼저 Agentlas 계정으로 로그인하세요.",

    // Workspace panel
    "workspace.title": "워크스페이스",
    "workspace.refresh": "새로고침",
    "workspace.change_folder": "변경",
    "workspace.close_panel": "패널 닫기",
    "workspace.resize": "패널 크기 조정",
    "workspace.empty.body": "이 채팅에 작업할 로컬 폴더를 연결하면\n에이전트가 같은 컨텍스트로 작업합니다.",
    "workspace.empty.pick": "폴더 열기",
    "workspace.empty.folder": "폴더가 비어있습니다.",
    "workspace.preview.binary": "텍스트로 미리볼 수 없는 파일",
    "workspace.preview.too_large": "파일이 너무 큽니다",
    "workspace.preview.truncated": "일부만 표시",
    "workspace.pick.title": "워킹 폴더 선택",

    // Chat header / page (chat.untitled는 위쪽에 이미 있음)
    "chat.rename_hint": "더블클릭으로 이름 변경",
    "chat.switch_agent": "에이전트 바꾸기",
    "chat.delete": "채팅 삭제",
    "chat.workspace_panel": "워크스페이스 패널",
    "chat.assistant_fallback": "어시스턴트",

    // Generic
    "generic.more": "더보기",
    "generic.installing": "설치 중…",
    "generic.installed": "설치됨",
    "generic.install": "설치",
    "generic.menu": "메뉴",
    "generic.chat_menu": "채팅 메뉴",

    // Market — bundle card
    "market.bundle.install": "팀 원클릭 설치",

    // Ask the user
    "ask.submit": "보내기",
  },
  en: {
    // App-wide
    "app.name": "Agentlas",
    "app.tagline": "Run a team of expert assistants for free, on your existing subscriptions",

    // Sidebar sections
    "sidebar.new_chat": "New chat",
    "sidebar.chats": "Chats",
    "sidebar.firms": "Firms",
    "sidebar.projects": "Projects",
    "sidebar.automations": "Automations",
    "sidebar.library": "Library",
    "sidebar.agents": "Agents",
    "sidebar.skills": "Skills",
    "sidebar.mcps": "MCP Servers",
    "sidebar.marketplace": "Marketplace",
    "sidebar.settings": "Settings",
    "sidebar.archive": "Archived",
    "sidebar.empty_chats": "Your chats will appear here",
    "sidebar.empty_firms_install": "Install a firm",
    "sidebar.empty_firms_hint": "A full-package company you command a CEO",
    "sidebar.empty_projects": "Create your first project",
    "sidebar.empty_automations": "Create an automation",
    "sidebar.collapse": "Collapse sidebar",
    "sidebar.expand": "Expand sidebar",
    "sidebar.backend_label": "Backend",
    "sidebar.backend_none": "No backend connected",
    "sidebar.byoc_free": "BYOC · Free",

    // Chat row actions
    "chat.untitled": "New chat",
    "chat.action.rename": "Rename",
    "chat.action.archive": "Archive",
    "chat.action.unarchive": "Unarchive",
    "chat.action.delete": "Delete",
    "chat.confirm_delete": "Delete this chat? All messages will be lost.",
    "chat.status.sending": "Sending...",
    "chat.err.unknown": "Unknown error",

    // Onboarding
    "onb.welcome.title": "Welcome to Agentlas",
    "onb.welcome.tagline": "Run a team of expert assistants on the\nClaude · ChatGPT · Gemini subscriptions you already pay for — free.",
    "onb.highlight.free.title": "App is free",
    "onb.highlight.free.desc": "We don't double-charge you",
    "onb.highlight.key.title": "Keys stay local",
    "onb.highlight.key.desc": "Stored only in OS keychain",
    "onb.highlight.team.title": "Your own team",
    "onb.highlight.team.desc": "Pick agents that fit you",

    // Positioning
    "pitch.threeInOne.title": "3 backends, 1 app",
    "pitch.threeInOne.desc": "Use your Claude · ChatGPT · Gemini subs as-is",
    "pitch.hermes.title": "Self-evolving memory by Hermes",
    "pitch.hermes.desc": "Context that learns as your agents work",
    "pitch.firm.title": "One-click agent firms",
    "pitch.firm.desc": "Command a CEO — they delegate to departments",
    "pitch.opensource": "Open-source desktop — works with no Agentlas account",
    "onb.step.prev": "Back",
    "onb.step.next": "Next",
    "onb.step.start": "Get started",
    "onb.step.skip": "Skip",
    "onb.backend.title": "Connect a backend",
    "onb.backend.desc": "Agentlas doesn't host any LLM. We call your subscription/keys directly from your machine.",
    "onb.backend.detected_cli": "Detected CLIs",
    "onb.backend.no_cli": "We didn't find Claude Code / Codex / Gemini CLI locally. You can still connect via API keys below.",
    "onb.backend.byok_title": "Or bring your own API keys (BYOK)",
    "onb.backend.byok_save": "Save",
    "onb.backend.ready": "Ready to connect. Continue to the next step.",
    "onb.backend.tip": "One CLI or one API key is enough to get started.",
    "onb.tour.title": "Around the app",
    "onb.tour.desc": "Here's what lives in the left sidebar. Toggle with ⌘[.",
    "onb.done.title": "All set",
    "onb.done.desc": "Pick your assistant team on the next screen.",

    // Marketplace
    "market.title.before": "Use",
    "market.title.after": " your way",
    "market.search.firms": "Search firms",
    "market.search.bundles": "Search bundles",
    "market.search.agents": "Search agents",
    "market.tab.firms": "Firms",
    "market.tab.bundles": "Bundles",
    "market.tab.agents": "Agents",
    "market.btn.manage": "Manage",
    "market.btn.create": "Create",
    "market.section.recommended_firms": "Recommended firms",
    "market.section.recommended_bundles": "Recommended bundles",
    "market.section.recommended_agents": "Individual agents",
    "market.empty_firms": "No firms for this persona yet.",
    "market.empty_bundles": "No bundles for this persona yet.",
    "market.empty_agents": "No results",
    "market.hero.install": "Install whole firm",
    "market.hero.chat": "Try it in chat",
    "market.installed": "Installed",
    "market.install": "Install",

    // Persona labels
    "persona.all": "All",
    "persona.shop": "Shop owner",
    "persona.marketer": "Solo marketer",
    "persona.realestate": "Real estate",
    "persona.creator": "Creator",

    // Home composer
    "home.title": "What can I help with today?",
    "home.subtitle.firm": "Tell the {name} CEO. They'll delegate to departments.",
    "home.subtitle.agent": "Talk to {name}. Press ⌘↵ to send.",
    "home.subtitle.empty": "Pick an agent or firm to start.",
    "home.mode.agent": "Individual agent",
    "home.mode.firm": "Firm",
    "home.placeholder": "Tell your agent what to do…",
    "home.send": "Send",
    "home.starting": "Starting…",
    "home.market_link": "Market",

    // ChatInput
    "chatinput.placeholder": "Tell your agent what to do — ⌘↵ · drag, drop, paste images",
    "chatinput.placeholder_rich": "Tell your agent what to do — / for commands · @ for mentions · ⌘↵ to send",
    "chatinput.placeholder_disabled": "No agents installed — go to Marketplace",
    "chatinput.attach": "Attach image — drag, drop, or paste",
    "chatinput.remove_image": "Remove image",
    "chatinput.image_too_large": "{name} is larger than 5 MB.",
    "chatinput.send": "Send",
    "chatinput.plus": "Add — file, plugin, mode",
    "chatinput.slash": "Slash commands",
    "chatinput.mention": "Mention an agent, project, or firm",
    "chatinput.slash_title": "Slash commands",
    "chatinput.mention_title": "Mentions",
    "chatinput.no_match": "No matches",
    "chatinput.no_plugins": "No plugins — install an agent first.",
    "chatinput.cmd.new": "Start a new chat",
    "chatinput.cmd.clear": "Clear this chat's history",
    "chatinput.cmd.help": "Keyboard shortcuts",
    "chatinput.plus.attach": "Add photo or file",
    "chatinput.plus.plugins": "Plugins (MCP servers)",
    "chatinput.plan_mode": "Plan mode",
    "chatinput.goal_mode": "Goal mode",
    "chatinput.perm.title": "Agent permissions",
    "chatinput.perm.read": "Read-only",
    "chatinput.perm.read.desc": "Read files & external data only — no writes or shell",
    "chatinput.perm.write": "Read + write",
    "chatinput.perm.write.desc": "File edits OK — shell & auto external calls blocked",
    "chatinput.perm.full": "Full access",
    "chatinput.perm.full.desc": "Shell commands & external APIs allowed (be careful)",
    "chatstream.empty_title": "Start chatting with {name}",
    "chatstream.firm_mode": "Firm mode · CEO · {name}",
    "chatstream.empty_hint": "Type in natural language below, then press ⌘↵",
    "chatstream.copy": "Copy",
    "chatstream.working_for": "Thinking · {sec}",
    "chatstream.took": "Done in {sec}",
    "chatstream.lines": "{count} lines",
    "chatstream.open_panel": "Open in the side panel",
    "chatstream.panel": "Panel ↗",
    "chatstream.close_panel": "Close panel",
    "chatstream.close": "Close (Esc)",

    // Settings
    "settings.title": "Settings — Backend",
    "settings.banner": "Agentlas doesn't host any LLM. Every call happens on your machine, with your subscription/keys. API keys are stored only in your OS keychain — they never touch Agentlas servers.",
    "settings.detected": "Detected backends",
    "settings.byok": "BYOK — Connect your own API keys",
    "settings.byok.note": "Keys are stored only in your macOS Keychain. They never touch Agentlas servers.",
    "settings.active": "Activate",
    "settings.activated": "Active",
    "settings.save": "Save",
    "settings.delete": "Delete",
    "settings.saved": "Saved",
    "settings.no_backends": "No connected backends. Add a BYOK key below or install a CLI runtime.",
    "settings.lang.title": "Language",
    "settings.lang.system": "System (auto)",
    "settings.lang.ko": "한국어",
    "settings.lang.en": "English",

    // Firm detail
    "firm.kind": "Firm",
    "firm.ceo.command": "Command CEO",
    "firm.section.orgchart": "Org chart",
    "firm.section.chats": "Chats with this firm",
    "firm.confirm_uninstall": "Remove {name}? Agents and chats stay.",
    "firm.empty_chats": "No firm chats yet. Start one with Command CEO.",

    // Project
    "project.kind": "Project",
    "project.new.title": "New project",
    "project.field.name": "Name",
    "project.field.name.hint": "e.g. June Campaign, Q3 Research",
    "project.field.context": "Context note",
    "project.field.context.hint": "A system memo automatically added to every chat in this project.",
    "project.field.default_agent": "Default agent",
    "project.field.default_agent.hint": "Auto-picked when starting a new chat in this project",
    "project.btn.create": "Create",
    "project.btn.creating": "Creating...",
    "project.section.note": "Context note",
    "project.add_note": "+ Add context note",
    "project.section.chats": "Chats",
    "project.empty_chats": "No chats yet. Use New chat at the top right to start.",
    "project.new_chat": "New chat",
    "project.confirm_delete": "Delete project '{name}'? Chats move to the root.",

    // Automation
    "auto.title": "Automations",
    "auto.new": "New automation",
    "auto.stub_note": "M0 stub — UI works but real scheduling activates in V1. Entries vanish on app restart.",
    "auto.empty": "No automations. Use New automation at the top right.",
    "auto.on": "On",
    "auto.off": "Off",
    "auto.confirm_delete": "Delete this automation?",
    "auto.field.name": "Name",
    "auto.field.name.placeholder": "e.g. 3 daily Instagram captions",
    "auto.field.schedule": "When should it run?",
    "auto.field.target": "Who should do it?",
    "auto.field.prompt": "Default prompt",
    "auto.field.prompt.hint": "Text that takes the place of user input on each run",
    "auto.target.firm": "Firm",
    "auto.target.agent": "Individual agent",
    "auto.empty_firms": "No firm installed. Install one from Marketplace → Firms.",
    "auto.empty_agents": "No agents installed.",
    "auto.detail.firm_label": "Firm (delegates to CEO)",
    "auto.detail.agent_label": "Agent",
    "auto.preset.daily9": "Every day at 9 AM",
    "auto.preset.weekday9": "Weekdays at 9 AM",
    "auto.preset.weekly_mon10": "Every Monday at 10 AM",
    "auto.preset.monthly1": "1st of every month at 9 AM",
    "auto.placeholder.firm": "e.g. Summarize what the firm should do today",
    "auto.placeholder.agent": "e.g. Draft 3 Instagram captions for today",
    "auto.row.schedule_with": "{schedule} · {target}",
    "auto.detail.schedule": "Schedule",
    "auto.detail.last_run": "Last run",
    "auto.detail.never": "Never run",
    "auto.detail.prompt": "Prompt",
    "auto.detail.stub": "M0 stub — real scheduling lands in V1. Memory store resets on restart.",

    // Library
    "library.agents.subtitle": "Assistants installed on your team",
    "library.agents.add": "+ Add from Market",
    "library.agents.empty": "No agents installed yet.",
    "library.agents.confirm_uninstall": "Remove {name}? Chat history is also deleted.",
    "library.skills.title": "Skill library",
    "library.skills.desc": "Skills are small task units agents call. Build them on Agentlas web — they sync here.",
    "library.skills.coming": "Coming soon — skill marketplace + one-click install lands in V1.",
    "library.mcps.desc": "MCP servers your installed agents depend on.",
    "library.mcps.empty": "Install an agent to see its MCP dependencies here.",
    "library.mcps.used_by": "Used by {n} agent(s)",

    // Archive
    "archive.empty": "No archived chats",

    // Env vault
    "env.title": "Environment variables",
    "env.subtitle": "External API keys shared across agents. Save once — every agent reads them automatically.",
    "env.security_note": "Values are stored only in your OS Keychain. They never reach Agentlas servers and are never shown in chats or to other agents.",
    "env.add_new": "+ Add variable",
    "env.field.key": "Variable name",
    "env.field.key.placeholder": "e.g. NOTION_API_KEY, SLACK_TOKEN",
    "env.field.value": "Value",
    "env.field.value.placeholder": "Paste the value",
    "env.required_by": "Used by {n} agent(s)",
    "env.required_by_none": "Added manually",
    "env.saved": "Saved",
    "env.not_set": "Not set",
    "env.optional": "Optional",
    "env.required": "Required",
    "env.empty": "No environment variables yet. Use + Add variable above, or install an agent that requests one.",
    "env.confirm_delete": "Delete {key}?",

    // Common
    "common.cancel": "Cancel",
    "common.save": "Save",
    "common.back": "Back",
    "common.delete": "Delete",
    "common.edit": "Edit",
    "common.skip_select": "None",
    "common.created_at": "{when}",

    // Auto-update (electron-updater)
    "update.downloading": "Downloading update · {pct}%",
    "update.ready": "New version ready · v{version}",
    "update.restart_now": "Restart to update",
    "update.dismiss": "Later",
    "update.checking": "Checking for updates…",
    "update.uptodate": "You're up to date",
    "update.error_short": "Couldn't check for updates",

    // Account
    "account.sign_in": "Sign in with Google",
    "account.signing_in": "Signing in…",
    "account.sign_out": "Sign out",
    "account.signed_in": "Account",
    "account.required.title": "Sign-in required",
    "account.required.body": "Sign in with your Agentlas account to install agents from the marketplace.",

    // Workspace panel
    "workspace.title": "Workspace",
    "workspace.refresh": "Refresh",
    "workspace.change_folder": "Change",
    "workspace.close_panel": "Close panel",
    "workspace.resize": "Resize panel",
    "workspace.empty.body": "Connect a local folder to this chat so the\nagent works in the same context.",
    "workspace.empty.pick": "Open folder",
    "workspace.empty.folder": "This folder is empty.",
    "workspace.preview.binary": "This file can't be previewed as text",
    "workspace.preview.too_large": "File is too large",
    "workspace.preview.truncated": "preview truncated",
    "workspace.pick.title": "Choose a working folder",

    // Chat header / page (chat.untitled는 위쪽에 이미 있음)
    "chat.rename_hint": "Double-click to rename",
    "chat.switch_agent": "Switch agent",
    "chat.delete": "Delete chat",
    "chat.workspace_panel": "Workspace panel",
    "chat.assistant_fallback": "Assistant",

    // Generic
    "generic.more": "More",
    "generic.installing": "Installing…",
    "generic.installed": "Installed",
    "generic.install": "Install",
    "generic.menu": "Menu",
    "generic.chat_menu": "Chat menu",

    // Market — bundle card
    "market.bundle.install": "Install team in one click",

    // Ask the user
    "ask.submit": "Send",
  },
} as const;

type DictKey = keyof typeof dict.ko;

interface I18nValue {
  locale: Locale;
  /** undefined = system, "ko" / "en" = user override */
  pref: LocalePref;
  setPref: (p: LocalePref) => void;
  t: (key: DictKey, vars?: Record<string, string | number>) => string;
}

const I18nContext = createContext<I18nValue | null>(null);

function resolveSystem(localeStr: string): Locale {
  // macOS는 "ko-KR" / "ja-JP" / "en-US" 같은 BCP47 반환.
  return localeStr.toLowerCase().startsWith("ko") ? "ko" : "en";
}

function interpolate(text: string, vars?: Record<string, string | number>): string {
  if (!vars) return text;
  return text.replace(/\{(\w+)\}/g, (_, k) => String(vars[k] ?? `{${k}}`));
}

export function I18nProvider({ children }: { children: ReactNode }) {
  const [pref, setPrefState] = useState<LocalePref>("system");
  const [locale, setLocaleState] = useState<Locale>("ko"); // SSR 기본값 ko (paw 모티프 한국 우선)
  const [_ready, setReady] = useState(false);

  // 초기 부팅: 사용자 override 또는 OS locale
  useEffect(() => {
    void (async () => {
      let stored: LocalePref = "system";
      try {
        const raw = window.localStorage.getItem(STORAGE_KEY);
        if (raw === "ko" || raw === "en") stored = raw;
      } catch {
        // ignore
      }
      setPrefState(stored);

      if (stored === "ko" || stored === "en") {
        setLocaleState(stored);
        setReady(true);
        return;
      }
      // System — IPC로 OS 로케일 조회
      const api = ipc();
      if (api?.app?.getLocale) {
        try {
          const sys = await api.app.getLocale();
          setLocaleState(resolveSystem(sys));
        } catch {
          setLocaleState("en");
        }
      } else {
        // 브라우저 dev — navigator.language fallback
        const nav = (typeof navigator !== "undefined" ? navigator.language : "en") ?? "en";
        setLocaleState(resolveSystem(nav));
      }
      setReady(true);
    })();
  }, []);

  const setPref = useCallback((p: LocalePref) => {
    try {
      if (p === "system") window.localStorage.removeItem(STORAGE_KEY);
      else window.localStorage.setItem(STORAGE_KEY, p);
    } catch {
      // ignore
    }
    setPrefState(p);
    if (p === "ko" || p === "en") {
      setLocaleState(p);
    } else {
      const api = ipc();
      if (api?.app?.getLocale) {
        void api.app.getLocale().then((sys) => setLocaleState(resolveSystem(sys)));
      }
    }
  }, []);

  const t = useCallback(
    (key: DictKey, vars?: Record<string, string | number>) => {
      const raw = (dict[locale] as Record<string, string>)[key] ?? (dict.ko as Record<string, string>)[key] ?? key;
      return interpolate(raw, vars);
    },
    [locale],
  );

  return (
    <I18nContext.Provider value={{ locale, pref, setPref, t }}>
      {children}
    </I18nContext.Provider>
  );
}

export function useT(): I18nValue {
  const ctx = useContext(I18nContext);
  if (!ctx) {
    // Provider 외부에서 호출 (next/error 페이지 등) — fallback ko
    return {
      locale: "ko",
      pref: "system",
      setPref: () => {},
      t: (k, v) => interpolate((dict.ko as Record<string, string>)[k] ?? k, v),
    };
  }
  return ctx;
}

/** 다국어 시드 객체에서 현재 locale에 맞는 표시 이름·태그라인을 뽑는 헬퍼.
 *  영어 사용자에게 한국어가 새지 않게 하는 통일 진입점. */
export function pickLocalized<T extends { name: string; nameEn?: string; tagline?: string; taglineEn?: string }>(
  item: T,
  locale: Locale,
): { name: string; tagline: string } {
  if (locale === "en") {
    return {
      name: item.nameEn?.trim() || item.name,
      tagline: item.taglineEn?.trim() || item.tagline || "",
    };
  }
  return { name: item.name, tagline: item.tagline ?? "" };
}
