import { getDb } from "../store/db";
import { tryRecordRunEvent } from "../store/run-events";
import { admitJudgedAutomaticGoal } from "../long-run/auto-goal-controller";
import { resolveAutomaticGoalIntent } from "../long-run/judged-auto-goal-intent";
import type { GoalSourceMessage } from "../../shared/auto-goal";
import type { LongRunRecord } from "../store/long-runs";

/** Bounded default, not a promise to finish within three passes. Unfinished
 * goals retain their criteria and pause. Money metering is unavailable here:
 * null explicitly means no monetary enforcement, never an invented $0 cost.
 */
export const AUTOMATIC_GOAL_CYCLE_LIMIT = 3;
export const AUTOMATIC_GOAL_TIME_LIMIT_MS = 10 * 60_000;

export async function prepareInvocationAutomaticGoal(input: {
  runId: string;
  chatId: string;
  sourceMessageId: string;
  userPrompt: string;
  permission: string;
  signal: AbortSignal;
  resolveIntent?: typeof resolveAutomaticGoalIntent;
}): Promise<LongRunRecord | null> {
  try {
    if (input.signal.aborted) return null;
    const row = getDb().prepare("SELECT chat_id, role, text FROM chat_messages WHERE id = ?")
      .get(input.sourceMessageId) as { chat_id: string; role: string; text: string } | undefined;
    if (!row || row.role !== "user" || row.chat_id !== input.chatId || row.text !== input.userPrompt) {
      throw new Error("auto_goal_source_mismatch");
    }
    const source: GoalSourceMessage = { chatId: input.chatId, messageId: input.sourceMessageId, role: "user", text: row.text };
    const decision = await (input.resolveIntent ?? resolveAutomaticGoalIntent)(source, { signal: input.signal, timeoutMs: 4_000 });
    if (input.signal.aborted) return null;
    tryRecordRunEvent({ runId: input.runId, chatId: input.chatId, kind: "automatic_goal_intake", payload: {
      sourceMessageId: source.messageId, intent: decision.intent, commitment: decision.commitment,
      classified: decision.intent !== "unknown",
    } });
    if (decision.intent !== "execute" || decision.commitment !== "now") return null;
    return admitJudgedAutomaticGoal({
      goalId: `goal:auto-message:${source.messageId}`, chatId: source.chatId, sourceMessageId: source.messageId, decision,
      acceptanceCriteria: [
        { id: "requested-outcome", text: `Every deliverable requested in user message ${source.messageId} is complete.` },
        { id: "scope", text: "The original request's constraints, exclusions and permission boundaries are preserved." },
        { id: "evidence", text: "Completion is supported by current evidence on the requested output surface; unverified work remains open." },
      ],
      authorityRefs: [`invocation:${input.runId}:permission:${input.permission}`],
      budget: { maxCycles: AUTOMATIC_GOAL_CYCLE_LIMIT, maxCostUsd: null, maxWorkers: 2,
        wallclockDeadline: new Date(Date.now() + AUTOMATIC_GOAL_TIME_LIMIT_MS).toISOString() },
    });
  } catch (error) {
    tryRecordRunEvent({ runId: input.runId, chatId: input.chatId, kind: "automatic_goal_intake_unavailable", payload: {
      sourceMessageId: input.sourceMessageId,
      reason: error instanceof Error && /^auto_goal_[a-z_]+$/.test(error.message) ? error.message : "classification_or_admission_failed",
    } });
    return null;
  }
}
