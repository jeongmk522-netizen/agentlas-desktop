// preload.ts가 contextBridge로 노출한 window.agentlas / window.agentlasEvents 타이핑.
import type { AgentlasIpc, AgentlasUpdaterEvents, McpInvocationEvent } from "./types";

interface AgentlasEvents {
  on: (
    channel: string,
    handler: (event: McpInvocationEvent) => void,
  ) => () => void;
}

declare global {
  interface Window {
    agentlas: AgentlasIpc;
    agentlasEvents: AgentlasEvents;
    agentlasUpdater: AgentlasUpdaterEvents;
  }
}

/**
 * Renderer 어디서나 호출. SSR 시점에는 window가 없으므로 client-only.
 * 안전하게 typeof check.
 */
export function ipc(): AgentlasIpc | null {
  if (typeof window === "undefined") return null;
  return window.agentlas ?? null;
}

export function ipcEvents(): AgentlasEvents | null {
  if (typeof window === "undefined") return null;
  return window.agentlasEvents ?? null;
}

export function updaterEvents(): AgentlasUpdaterEvents | null {
  if (typeof window === "undefined") return null;
  return window.agentlasUpdater ?? null;
}
