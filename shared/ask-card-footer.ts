/**
 * 묻는 카드 아래 단추가 **하는 일**과, 그 일을 부르는 이름.
 *
 * 이 단추 하나가 두 가지 일을 한다: 입력란이 비었으면 질문을 건너뛰고, 글이 있으면 그 글을
 * 답으로 보낸다. 그런데 라벨은 늘 "건너뛰기"였다. 답을 적어 둔 사람이 라벨을 믿고 누르면
 * **적어 둔 답이 그대로 나간다** — 시킨 것과 정반대다.
 *
 * 판단을 여기 한 곳에 둬서, 화면과 검사가 같은 함수를 부르게 한다. 라벨과 동작이 갈라지면
 * 두 곳이 아니라 한 곳이 틀린 것이 된다.
 */

export type AskCardFooterAction = "submit" | "skip";

/** 지금 이 단추를 누르면 실제로 일어나는 일. */
export function askCardFooterAction(freeText: string): AskCardFooterAction {
  return freeText.trim().length > 0 ? "submit" : "skip";
}

/** 그 일을 사람 말로 부른 이름. 동작과 같은 함수에서 갈라져 나온다. */
export function askCardFooterLabel(
  freeText: string,
  labels: { skipLabel: string; submitLabel: string },
): string {
  return askCardFooterAction(freeText) === "submit" ? labels.submitLabel : labels.skipLabel;
}
