// 채팅에서 에이전트가 자동화를 거는 emitter — memory(## Memory Events) / delegate(## Delegate)와 동일 패턴.
// 사용자가 반복/스케줄 작업을 요청하면, 에이전트가 reply 끝에 "## Automation" 블록을 넣는다.
// client.ts가 이 블록을 파싱해 현재 chat의 타깃(firm/agent)으로 자동화를 등록하고 블록은 사용자에게서 가린다.
export const AUTOMATION_HEADING = "## Automation";

export interface ParsedAutomation {
  name: string;
  /** daily-HH:MM | weekday-HH:MM | weekly-<mon..sun>-HH:MM | monthly-<day>-HH:MM */
  schedule: string;
  prompt: string;
}

// 시스템 프롬프트에 동봉 — 에이전트가 언제/어떻게 자동화를 만들지 알려준다.
export const AUTOMATION_PROTOCOL = [
  "## Setting up automations",
  "",
  "If the user wants something RECURRING or SCHEDULED (every day, each morning, weekly, monthly…),",
  "register it as an automation that re-runs YOU on that schedule. End your reply with exactly this",
  "block (omit it entirely otherwise):",
  "",
  AUTOMATION_HEADING,
  "```json",
  '[ { "name": "<short name>", "schedule": "<daily-HH:MM | weekday-HH:MM | weekly-<mon|tue|wed|thu|fri|sat|sun>-HH:MM | monthly-<day>-HH:MM>", "prompt": "<exactly what to do on each run>" } ]',
  "```",
  "",
  "Times are 24-hour local. Only emit this when the user actually asked for a recurring task — never for one-off work.",
].join("\n");

export function parseAutomations(text: string): { automations: ParsedAutomation[]; cleanedText: string } {
  const idx = text.lastIndexOf(AUTOMATION_HEADING);
  if (idx < 0) return { automations: [], cleanedText: text.trim() };

  const after = text.slice(idx + AUTOMATION_HEADING.length);
  const fence = after.match(/```(?:json)?\s*([\s\S]*?)```/);
  let automations: ParsedAutomation[] = [];
  if (fence) {
    try {
      const data = JSON.parse(fence[1].trim());
      if (Array.isArray(data)) {
        automations = data
          .map((d): ParsedAutomation | null => {
            if (!d || typeof d !== "object") return null;
            const o = d as Record<string, unknown>;
            const name = typeof o.name === "string" ? o.name.trim() : "";
            const schedule = typeof o.schedule === "string" ? o.schedule.trim() : "";
            const prompt = typeof o.prompt === "string" ? o.prompt.trim() : "";
            return name && schedule && prompt ? { name, schedule, prompt } : null;
          })
          .filter((a): a is ParsedAutomation => a !== null);
      }
    } catch {
      automations = [];
    }
  }

  let cut = text.length;
  if (fence && fence.index != null) {
    cut = idx + AUTOMATION_HEADING.length + fence.index + fence[0].length;
  } else {
    cut = idx;
  }
  const cleanedText = (text.slice(0, idx) + text.slice(cut)).trim();
  return { automations, cleanedText };
}
