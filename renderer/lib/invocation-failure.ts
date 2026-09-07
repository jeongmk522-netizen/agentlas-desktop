/**
 * 실행 시작 실패를 화면이 알아보는 방법.
 *
 * ★왜 문자열로 보는가 (2026-09-08).
 *   엔진은 이 실패에 `error.code = "chat_invocation_active"` 를 붙인다. 그런데 그 값은
 *   **렌더러까지 오지 못한다** — Electron 의 ipcRenderer.invoke 거절은 원본 Error 의
 *   message 만 실어 오고 커스텀 속성은 사라진다. 실제로 이 저장소의 렌더러 어디에도
 *   `error.code` 로 판정하는 자리가 **한 곳도 없다**(선례 0건). 코드로 판정하는 코드를
 *   쓰면 컴파일도 되고 타입도 맞지만 **한 번도 참이 되지 않는다.**
 *
 *   그래서 code 가 있으면 code 를, 없으면 엔진이 쓰는 **문장**을 본다.
 *   문장 대조는 조용히 어긋나므로, 게이트(test:chat-busy-error-has-a-way-out)가
 *   엔진이 실제로 만드는 두 문장을 꺼내 이 함수에 먹여 양쪽 끝을 붙들어 맨다.
 *
 *   메시지는 IPC 를 건너며 "Error invoking remote method '...': Error: <원문>" 으로
 *   감싸이므로 반드시 **부분 일치**로 본다.
 */

/** 엔진(electron/runtime/run-id.ts)이 이 실패에 쓰는 문장의 고정 조각. */
const CHAT_BUSY_FRAGMENTS = [
  "still running an earlier request",
  "was asked to stop, but the earlier request has not finished",
];

export const CHAT_BUSY_CODE = "chat_invocation_active";

export function failureMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : String((error as { message?: string })?.message ?? error ?? "");
  return raw
    // IPC 포장을 벗긴다 — 사용자에게 remote method 이름을 보여 줄 이유가 없다.
    .replace(/^Error invoking remote method '[^']*':\s*/, "")
    .replace(/^(Error:\s*)+/, "")
    .trim();
}

export function isChatBusyFailure(error: unknown): boolean {
  if ((error as { code?: string } | null)?.code === CHAT_BUSY_CODE) return true;
  const message = failureMessage(error);
  return CHAT_BUSY_FRAGMENTS.some((fragment) => message.includes(fragment));
}
