# M0 Spike Checklist (2주)

PRD [§9 마일스톤](../../AgentsAtlas/DESKTOP-APP-PRD.md) — M0 산출물 검증.

## 기능 게이트

빌드/타입체크 게이트는 이미 자동 검증 통과. 아래는 GUI 부팅이 필요한 항목.

- [ ] **윈도우 로드** — `npm run dev` → Electron이 Next.js 15 페이지를 띄움 (`npm install` 후)
- [ ] **CLI 자동 감지** — `claude` / `codex` / `gemini` 중 1개 이상 PATH 또는 표준 경로에서 발견 (설정 페이지에 표시)
- [ ] **Keychain 라운드트립** — 설정에서 BYOK 키 저장 → `hasApiKey` true → 삭제 → false
- [ ] **실제 LLM 호출** — Chat에 "안녕" 입력 → `thinking` → `tool-use` → `partial` → `final` 이벤트가 순차로 도착, 진짜 응답 반환
- [ ] **채팅 히스토리 영구화** — 메시지 보낸 후 다른 에이전트 → 다시 돌아오면 히스토리 유지
- [ ] **My Team 사이드바** — 큐레이션 번들 1개 설치 후 에이전트 카드 렌더
- [ ] **디자인 토큰 일치** — 웹 포털과 indigo primary, 폰트 같이 보임

## 비기능 게이트

- [ ] `npm run typecheck` 통과 (electron + renderer 모두)
- [ ] Renderer가 `contextIsolation:true, sandbox:true`에서 정상 동작
- [ ] preload 외 노출된 Node API 없음 (audit: `grep -r 'window.require' renderer/`)
- [ ] SQLite 파일이 `app.getPath("userData")`에 생성됨
- [ ] 외부 링크가 시스템 기본 브라우저로 열림 (앱 내부 BrowserWindow에 안 뜸)

## M0 동작 시나리오 (수동 검증)

1. 첫 실행 → `/onboarding` 자동 라우팅
2. "1인 마케터" 페르소나 클릭 → 마케터 스타터 번들 3개 카드 표시
3. "팀 원클릭 설치" → 3개 에이전트가 SQLite에 들어가고 `/`로 복귀
4. 좌측 사이드바에 콘텐츠 작가 미나, SEO 리서처, 일정 비서 표시
5. 콘텐츠 작가 미나 클릭 → ChatPanel 활성화 (히스토리 비어 있음)
6. "오늘 인스타 캡션 3개 만들어줘" 입력 → ⌘↵
7. status "미나가 생각 중..." 표시 → "Claude Code CLI 호출 중..." (활성 백엔드에 따라 라벨 바뀜) → 실제 LLM 응답이 partial 스트리밍으로 흘러나옴 → final로 정착
8. 하단 RuntimeStatusBar에 "🟢 Claude Code (Anthropic) 연결됨 · v<버전>" 또는 "🟢 API 키 (Anthropic) 연결됨"
9. 다른 에이전트로 전환 → 다시 미나로 복귀 → 히스토리 그대로 (SQLite 영구화 확인)
10. 설정 페이지 진입 → BYOK 키 저장 → 새 백엔드 후보가 감지된 백엔드 리스트에 추가됨 → 활성화 클릭 → 다음 invocation은 BYOK로 라우팅됨

### 백엔드 별 실제 호출 동작

| 백엔드 | 동작 |
|---|---|
| claude-code CLI | `claude -p "<prompt>" --append-system-prompt "<system>"` spawn, stdout 80ms throttle 스트리밍 |
| codex CLI | `codex exec "<combined prompt>"` spawn |
| gemini CLI | `gemini --prompt "<combined prompt>"` spawn |
| BYOK Anthropic | POST `api.anthropic.com/v1/messages` SSE, `claude-sonnet-4-5` 기본 |
| BYOK OpenAI | POST `api.openai.com/v1/chat/completions` SSE, `gpt-4o-mini` 기본 |
| BYOK Google | POST `generativelanguage.googleapis.com/.../streamGenerateContent?alt=sse`, `gemini-1.5-flash` 기본 |

API 키는 macOS Keychain(`com.agentlas.desktop` 서비스)에만 저장. 메인 프로세스에서만 read, renderer는 hasApiKey boolean만 조회.

## M0 → M1 게이트

이 체크리스트의 8개 항목이 모두 통과하면 **M1 (FRE/마켓 미러/실제 MCP transport)** 로 넘어간다. 통과 못 하면 막힌 곳을 메인 issue로 분리 후 stop.
