import { randomUUID } from "node:crypto";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Renderer-provided channel IDs are UUID-only and may never replace an active controller. */
export function resolveInvocationRunId(
  requested: unknown,
  isActive: (runId: string) => boolean,
  generate: () => string = randomUUID,
): string {
  if (requested !== undefined && requested !== null) {
    if (typeof requested !== "string" || !UUID_RE.test(requested)) {
      throw new Error("Invalid invocation runId");
    }
    if (isActive(requested)) throw new Error("Invocation runId is already active");
    return requested;
  }
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const generated = generate();
    if (UUID_RE.test(generated) && !isActive(generated)) return generated;
  }
  throw new Error("Could not allocate a unique invocation runId");
}

/**
 * Chat renderer has one stream/stop surface; reject a second live run instead of
 * making one unattachable.
 *
 * ★내는 오류에는 푸는 길이 있어야 한다 (오너 기기 로그 실측 2026-09-07).
 *   옛 문구는 "This chat already has an active invocation" 한 줄이었다. 사용자가
 *   할 수 있는 일이 무엇인지 한 글자도 없었고, 로그에는 이 오류가 3초 안에 세 번
 *   연속 찍혔다 — 그 사이 사용자는 "왜안되냐고" 를 쳤다.
 *   (이미 중지 신호가 떨어진 죽은 자리는 registry.reclaimDeadChatSlot 이 먼저 치운다.
 *    여기까지 온 것은 **진짜로 살아 도는 실행**뿐이므로, 답은 "멈추고 다시" 다.)
 */
export const INVOCATION_CHAT_BUSY_CODE = "chat_invocation_active";

export function assertInvocationChatAvailable(
  chatId: unknown,
  activeRecords: Iterable<{ chatId: string }>,
): asserts chatId is string {
  if (typeof chatId !== "string" || !chatId.trim()) throw new Error("Invalid invocation chatId");
  for (const record of activeRecords) {
    if (record.chatId === chatId) {
      const error = new Error(
        "This chat is still running an earlier request. Stop it first, then send this one again.",
      ) as Error & { code?: string };
      error.code = INVOCATION_CHAT_BUSY_CODE;
      throw error;
    }
  }
}
