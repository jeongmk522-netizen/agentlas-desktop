// 모든 런타임(CLI 3종 + BYOK 3종)이 구현해야 하는 통합 인터페이스.
// mcp/client.ts가 활성 런타임 → 적절한 러너로 라우팅한다.
import type { ChatHistoryEntry, ImageAttachment } from "../../shared/types";
import { tStatus, type RuntimeLocale } from "./status-i18n";

export interface RunnerRequest {
  systemPrompt: string;
  history: ChatHistoryEntry[];
  userPrompt: string;
  /** 첨부 이미지 — BYOK 멀티모달에만 사용, CLI는 무시 */
  images?: ImageAttachment[];
  /** 사용자에게 보일 라벨 — "Claude Code CLI" / "Anthropic API" / "Ollama · llama3.1" */
  backendLabel: string;
  /** ollama 등 모델 선택이 필요한 LLM의 활성 모델 이름. 그 외엔 미설정 */
  model?: string;
  /** 상태/오류 메시지 i18n에 사용. renderer가 동봉, fallback "en" */
  locale: RuntimeLocale;
}

export interface RunnerEvents {
  /** 토큰 또는 줄 단위 partial 출력 */
  onPartial: (chunk: string) => void;
  /** 사용자에게 보일 상태 줄 — locale 적용된 완성 문자열 */
  onStatus: (status: string) => void;
}

export interface RunnerResult {
  text: string;
}

export type Runner = (
  req: RunnerRequest,
  events: RunnerEvents,
) => Promise<RunnerResult>;

/** 에이전트가 사용자에게 옵션 질문을 emit할 수 있는 프로토콜 — renderer/lib/ask-question.ts의 파서와 짝.
 *  로케일 무관, 영어로 — 모델은 항상 영어 docstring을 잘 따른다.
 *  토큰을 아끼기 위해 짧게. */
const ASK_PROTOCOL = `## Clarifying questions to the user

If — and only if — you need an explicit choice from the user to proceed, emit exactly one fenced block, then STOP and wait:

<<agentlas-ask>>
{ "question": "Question text ending with ?", "header": "Short label", "multiSelect": false, "options": [ { "label": "Option A", "description": "what happens" }, { "label": "Option B", "description": "what happens" } ] }
<</agentlas-ask>>

Rules:
- 2–4 options. First option is the recommended one when there's a clear default.
- Skip this when the user's answer wouldn't change what you do, or when a sensible default is obvious — pick it and proceed.
- After the fence, do NOT also answer. The user's selection arrives as their next message.`;

/** 표준 시스템 프롬프트 — 에이전트 프롬프트 앞에 붙는 안전 헤더.
 *  locale에 따라 LLM에게 답변 언어 가이드를 다르게 준다 (영어 사용자에게는 영어 가이드). */
export function wrapSystemPrompt(agentSystemPrompt: string, locale: RuntimeLocale): string {
  return [
    tStatus(locale, "sysHeader"),
    tStatus(locale, "sysGuide"),
    tStatus(locale, "sysToolsOff"),
    "",
    ASK_PROTOCOL,
    "",
    tStatus(locale, "sysAgentDef"),
    agentSystemPrompt,
  ].join("\n");
}
