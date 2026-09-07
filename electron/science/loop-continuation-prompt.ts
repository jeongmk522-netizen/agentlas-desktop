/**
 * 자율 연구가 스스로 이어 갈 때 매 턴 실려 나가는 규범.
 *
 * 예전에는 한 문장이었다: "정본 상태에서 승인된 루프를 재개하고, 하나의 후속 에피소드를
 * 계획·실행하고, 검증되면 완료하고, 아니면 멈춰라." 그 문장에는 **완료가 무엇으로 증명되는지**가
 * 없다. 그래서 모델은 몇 문단을 쓰고 "완료"를 선언할 수 있었고, 사람이 이미 승인해 둔 지점에서도
 * "사람이 필요하다"며 멈출 수 있었다.
 *
 * 상태를 더 만들지 않는다. 상태는 이미 원장·라이프사이클·OCC 영수증에 있다. 부족한 것은 매 턴
 * 다시 말해 주는 **규범**이다 -- 이 파일이 그것이고, 순수 함수라 게이트가 직접 부를 수 있다.
 */

export interface ScienceLoopContinuationInput {
  /** 남은 에피소드 예산. 모르면 null. */
  readonly episodesRemaining: number | null;
  /** 마감까지 남은 시간(시간 단위). 모르면 null. */
  readonly hoursRemaining: number | null;
  /** 직전 턴들이 연속으로 진전 없이 끝난 횟수. */
  readonly noProgressStreak: number;
  /** 이 프로젝트가 사람 확인 없이 스스로 기록해도 되는 승인 범위. */
  readonly standingApprovalScopes: readonly string[];
  /**
   * 이 연구의 산출물 언어. 화면 언어와 다른 축이다 -- 한국어로 대화하면서 영어 논문을 쓰는 것이
   * 정상이다. null 이면 프로젝트가 아직 고르지 않았다는 뜻이고, 그때는 화면 언어를 넘겨 준다.
   */
  readonly outputLanguage: string | null;
}

const bullet = (lines: readonly string[]): string => lines.map((line) => `- ${line}`).join("\n");

export function scienceLoopContinuationPrompt(input: ScienceLoopContinuationInput): string {
  const budget = [
    input.episodesRemaining === null ? "Episodes remaining: unknown" : `Episodes remaining: ${input.episodesRemaining}`,
    input.hoursRemaining === null ? "Time to deadline: unknown" : `Time to deadline: ${input.hoursRemaining.toFixed(1)}h`,
  ];
  const languageName = {
    ko: "Korean", en: "English", zh: "Simplified Chinese", "zh-Hant": "Traditional Chinese", ja: "Japanese",
    es: "Spanish", fr: "French", de: "German", pt: "Portuguese", ru: "Russian", it: "Italian", ar: "Arabic", hi: "Hindi",
  }[input.outputLanguage ?? ""] ?? input.outputLanguage;
  const standing = input.standingApprovalScopes.length
    ? `The researcher has already authorized these without being asked again: ${input.standingApprovalScopes.join(", ")}. Record those decisions yourself and name the standing grant as the authority. Stopping to ask for one of these strands the study at a checkpoint nobody is waiting at.`
    : "This project carries no standing approval. Every authorization needs the accountable human.";

  return [
    "Continue the authorized research loop toward the study's real end state.",
    "",
    "Read the canonical state first: the loop session, the lifecycle phase and its gate, the evidence graph, and the exact OCC receipts. Previous conversation text can help you find things, but the store is what is true.",
    "",
    "Budget:",
    bullet(budget),
    "",
    "Output language:",
    bullet([
      languageName
        ? `Write every research output in ${languageName}: hypothesis statements, evidence summaries, analysis commentary, figure captions, and the manuscript. This is the project's choice and is independent of the language the researcher chats in -- do not mirror the chat language instead.`
        : "This project has not chosen an output language. Keep writing in the language the previous turns used, and do not switch mid-study.",
      "Identifiers, units, statistical symbols, tool names, and quoted source text keep their original form; do not translate them.",
    ]),
    "",
    "Standing authority:",
    bullet([standing]),
    "",
    "No-progress check:",
    bullet([
      "Classify the previous turn as progress, a verified wait, or no progress. Progress changes canonical state -- a committed evidence span, a closed gate, a recorded episode result, a new immutable artifact version. Restating status, re-reading the same records, or proposing a plan you did not execute is no progress.",
      "A verified wait polls a specific run or episode you confirmed is live now. Intent, prior output, or an unchanged lifecycle row is not a wait.",
      input.noProgressStreak > 0
        ? `The last ${input.noProgressStreak} turn(s) made no progress. Take a materially different evidence-bound action this turn, or record the concrete blocker.`
        : "If the last turn made no progress, take a materially different evidence-bound action rather than repeating it.",
    ]),
    "",
    "Fidelity:",
    bullet([
      "Do not shrink the study to what fits this turn. If it cannot finish now, advance the real question and leave the loop active.",
      "Do not substitute a narrower, easier, or more-likely-to-pass analysis for the one the question needs. A result that passes a gate while answering a different question is not progress.",
    ]),
    "",
    "Completion audit -- completion is unproven until you prove it:",
    bullet([
      "Derive the concrete requirements from the research question, the contract, and the approved hypotheses.",
      "For each one, name the exact record that would prove it -- an episode result, a statistical artifact version, an evidence span, a figure, a manuscript section -- then read that record and check it says what you claim.",
      "Treat a passing gate, a written summary, or a plausible narrative as evidence only after confirming it covers the requirement. Indirect or missing evidence means not done.",
      "Only complete the loop when every requirement has a record behind it. Otherwise keep working.",
    ]),
    "",
    "Stopping:",
    bullet([
      "Pause only at a genuine boundary: an authorization outside the standing grant, a real fork with materially different directions, a missing required input, an exhausted budget, or a passed deadline.",
      "Do not pause because the work is hard, slow, or incomplete. Say the concrete blocker and what would unblock it.",
    ]),
  ].join("\n");
}
