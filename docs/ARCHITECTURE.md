# AgentlasDesktop — Architecture

PRD [`AgentsAtlas/DESKTOP-APP-PRD.md`](../../AgentsAtlas/DESKTOP-APP-PRD.md) §6 기준 구현 메모. 코드 곳곳에 PRD 섹션 번호로 cross-reference.

## 프로세스 모델

| Process | 책임 | 보안 |
|---|---|---|
| **Main** (`electron/`) | Node API, 파일 시스템, MCP 자식 프로세스 spawn, OS Keychain, SQLite | Node 전권 |
| **Renderer** (`renderer/`) | UI만. `window.agentlas` IPC만 호출 | sandbox: true, contextIsolation: true, nodeIntegration: false |
| **Preload** (`electron/preload.ts`) | contextBridge로 화이트리스트 IPC만 expose | sandbox compatible |

renderer는 노드/파일/네트워크에 직접 접근할 수 없고, 모든 권한 있는 작업은 preload → main으로 raft한다.

## IPC 채널 (PRD §6 — shared/types.ts AgentlasIpc)

| 채널 | 방향 | 페이로드 | 비고 |
|---|---|---|---|
| `runtime:detect` | R→M | — | CLI + BYOK 동시 감지 |
| `runtime:setActive` | R→M | `RuntimeKind` | 활성 백엔드 선택 |
| `secrets:saveApiKey` | R→M | `(backend, key)` | Keychain write only. 키 값은 never sent back |
| `secrets:hasApiKey` | R→M | `backend` | boolean — 키 존재 여부만 |
| `secrets:deleteApiKey` | R→M | `backend` | |
| `team:list` / `install` / `uninstall` | R→M | | SQLite registry |
| `marketplace:listBundles` / `search` | R→M | | M0은 시드, M1은 agentlas.cloud fetch |
| `invoke:run` | R→M | `McpInvocationRequest` | 즉시 `{runId}` 반환 |
| `invoke:event:<runId>` | M→R | `McpInvocationEvent` | 스트리밍 푸시 채널 |

## BYOC 라우팅 (PRD §3.1, §6.4)

```
User prompt → invoke:run → mcp/client.ts.runMcpInvocation
                              ↓
              runtime/detect.ts — 활성 백엔드 결정
                              ↓
        ┌─────────────────────┼─────────────────────┐
   claude-code CLI        codex CLI           gemini CLI         BYOK API
   spawn(args)            spawn(args)         spawn(args)        fetch(...)
                              ↓
                       MCP stdio transport
                              ↓
                  ev → invoke:event:<runId>
```

M0는 mock invocation으로 IPC 채널/타입을 검증한다. M1에서 `@modelcontextprotocol/sdk`의 `StdioClientTransport`로 실제 MCP 서버 spawn.

## 데이터 영구성

- **SQLite** (`userData/agentlas.sqlite`) — 설치 에이전트, 활성 백엔드 선택, 채팅 런(로컬 only).
- **Keychain** — API 키 only. 키 값은 main 프로세스에서만 읽고, MCP 자식 env로 주입.
- **클라우드 동기화** (PRD §6.3) — M2부터. 팀 구성만 동기화. 채팅 로그는 default off.

## 보안 (PRD §6.2)

1. **MCP 설치 게이트**: Cargo Trust A/B만 통과. `electron/mcp/registry.ts.installAgent`가 enforce.
2. **권한 요청 모달**: M1 — MCP 서버가 파일/네트워크 액세스 요청 시 1-tap approval.
3. **Entitlement 최소화**: `build-resources/entitlements.mac.plist` — Hardened Runtime, sandbox 호환.
4. **외부 링크는 기본 브라우저로**: `main.ts.setWindowOpenHandler`.
5. **CSP**: M1에서 renderer에 명시적 CSP 메타 추가.

## 빌드 / 배포

```bash
npm run build           # tsc(electron) + next build + export(renderer)
npm run package:mac     # electron-builder → release/Agentlas-<v>-<arch>.dmg
npm run release:mac:verify
```

Public release is intentionally blocked unless `release:mac:verify` passes:

- `hdiutil verify` for both DMGs.
- `xcrun stapler validate` for both DMGs.
- `spctl -a -t open --context context:primary-signature` for both DMGs.
- No AppleDouble `._*` files in `release/`.

Notarization은 `APPLE_ID` / `APPLE_APP_SPECIFIC_PASSWORD` / `APPLE_TEAM_ID` env로 주입. Developer ID signing은 `CSC_LINK` / `CSC_KEY_PASSWORD` 또는 GitHub Actions의 `MAC_DEVELOPER_ID_CERTIFICATE` / `MAC_DEVELOPER_ID_CERTIFICATE_PASSWORD` secret으로 주입. CI release workflow는 repo root의 `.github/workflows/agentlas-desktop-release.yml`.

## 디자인 시스템 미러 (PRD §7)

`renderer/app/globals.css`가 `AgentsAtlas/app/src/components/paper/tokens.ts`의 색/폰트 토큰을 CSS variable로 1:1 미러한다. 변경 시 두 곳을 동시에 업데이트해야 한다. M2에서 토큰을 별도 npm 워크스페이스 패키지로 분리해서 단일 source of truth로 정리.

데스크톱 톤다운: 여백 ↑, 그림자/회전 ↓ — 매일 쓰는 도구이므로 시각적 노이즈 최소.

## Renderer ↔ Web Portal 분리

- 데스크톱은 **빌드 안 함**. "에이전트 만들기" → `https://agentlas.cloud/build` 외부 링크.
- 마켓플레이스 검색 결과는 같은 데이터 모델을 미러 — 웹과 데스크톱 모두 `MarketplaceListing` 타입 사용.
- 로그인은 매직 링크 (M1). 데스크톱은 OAuth deep link `agentlas://auth/callback?...` 처리.
