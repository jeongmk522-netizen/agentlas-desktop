/**
 * "지금 에이전트가 화면을 몰고 있는가" 를 도구 이름 하나로 판정한다.
 *
 * ★왜 공용으로 꺼냈나 (2026-09-08).
 *   이 판정은 Work 안에만 있었고(TaskCockpit), 그래서 **One 에는 아예 없었다.**
 *   그 결과 두 화면 모두 컴퓨터 조작 중에 사람이 볼 것이 없었다 —
 *   Work 는 패널을 열지만 그릴 것이 없었고(릴리스 1.1.5 가 그리는 부품의 호출부를
 *   지웠다), One 은 판정 자체가 없었다. 오너 2026-09-07: "컴퓨터 유즈를 못하네".
 *
 *   판정이 한 곳에 있어야 두 화면이 같은 순간에 같은 것을 보여 준다.
 */

export type AgentScreenMode = "browser" | "computer";

export function agentScreenModeForTool(toolName: string | null | undefined): AgentScreenMode | null {
  const name = (toolName ?? "").toLowerCase();
  if (!name) return null;
  if (name.includes("browser_")) return "browser";
  if (
    name.includes("computer-use")
    || name.includes("cua-driver")
    || /(?:^|__)(?:get_app_state|list_apps|click|drag|scroll|type_text|press_key|set_value|select_text)$/u.test(name)
  ) return "computer";
  return null;
}
