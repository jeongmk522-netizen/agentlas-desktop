// 에이전트 위치 라우팅 설정 — 로컬에서 임포트한 에이전트/팀이 "원본 폴더 어디에 있고,
// 어떤 CLI 런타임(claude-code / codex / gemini / cursor / generic) 전용인지"를 영구 저장한다.
// userData/agent-routes.json. 앱이 이 정보를 읽어 파일 패널·실행 라우팅에 사용한다.
import fs from "node:fs";
import path from "node:path";
import { app } from "electron";

export type RuntimeLabel = "claude-code" | "codex" | "gemini" | "cursor" | "generic";

export interface AgentRoute {
  /** installed_agents.id */
  agentId: string;
  /** 원본 로컬 폴더 절대경로 */
  path: string;
  /** 주 런타임 라벨 */
  runtime: RuntimeLabel;
  /** 감지된 모든 라벨 (팀은 여러 개일 수 있음) */
  labels: RuntimeLabel[];
  /** 단일 에이전트인지 팀인지 */
  kind: "agent" | "team";
  importedAt: string;
}

function routesFile(): string {
  return path.join(app.getPath("userData"), "agent-routes.json");
}

function readAll(): Record<string, AgentRoute> {
  try {
    const raw = fs.readFileSync(routesFile(), "utf8");
    const obj = JSON.parse(raw) as Record<string, AgentRoute>;
    return obj && typeof obj === "object" ? obj : {};
  } catch {
    return {};
  }
}

function writeAll(map: Record<string, AgentRoute>): void {
  fs.writeFileSync(routesFile(), JSON.stringify(map, null, 2) + "\n", "utf8");
}

export function getRoute(agentId: string): AgentRoute | null {
  return readAll()[agentId] ?? null;
}

export function listRoutes(): AgentRoute[] {
  return Object.values(readAll());
}

export function setRoute(route: AgentRoute): void {
  const map = readAll();
  map[route.agentId] = route;
  writeAll(map);
}

export function removeRoute(agentId: string): void {
  const map = readAll();
  if (map[agentId]) {
    delete map[agentId];
    writeAll(map);
  }
}
