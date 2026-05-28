// IPC 핸들러 일괄 등록. main.ts 앱 ready 직후 호출.
// 각 도메인 모듈(runtime, secrets, team, marketplace, projects, chats, automations, invoke)을 thin wrapping.
import { app, BrowserWindow, ipcMain } from "electron";
import { randomUUID } from "node:crypto";
import { detectRuntimes, setActiveRuntime } from "./runtime/detect";
import { runMigration, scanMigrationSources } from "./migrate";
import {
  deleteApiKey,
  deleteEnvVar,
  hasApiKey,
  hasEnvVar,
  listEnvKeys,
  saveApiKey,
  setEnvVar,
} from "./secrets/vault";
import {
  installAgent,
  listInstalledAgents,
  uninstallAgent,
} from "./mcp/registry";
import { getSource as getMarketSource, getSourceStatus as getMarketSourceStatus } from "./marketplace";
import {
  getFirm,
  installFirm,
  listFirms,
  uninstallFirm,
} from "./store/firms";
import { runMcpInvocation } from "./mcp/client";
import { checkSafely as updaterCheck, getUpdaterState, quitAndInstall as updaterInstall } from "./updater";
import { listDirectory, pickDirectory, readTextFilePreview } from "./fs/workspace";
import { getAuthSession, signInWithGoogle, signOut } from "./auth";
import {
  createProject,
  getProject,
  listProjects,
  removeProject,
  updateProject,
} from "./store/projects";
import {
  archiveChat,
  clearChatMessages,
  createChat,
  getChat,
  getChatWorkingFolder,
  listArchivedChats,
  listChatMessages,
  listChatsByFirm,
  listChatsByProject,
  listRecentChats,
  removeChat,
  renameChat,
  setChatWorkingFolder,
  switchChatAgent,
  unarchiveChat,
} from "./store/chats";
import {
  createAutomation,
  listAutomations,
  removeAutomation,
  toggleAutomation,
} from "./store/automations";
import type {
  Automation,
  McpInvocationRequest,
  MigrationOptions,
  Project,
  RuntimeBackend,
  RuntimeSelection,
} from "../shared/types";

export function registerIpcHandlers(): void {
  // ── app ─────────────────────────────────────────────────
  // macOS "시스템 설정 > 언어 및 지역"의 1순위 언어. Electron이 BCP47 형태로 반환.
  // ex) "ko-KR", "en-US", "ja-JP". 첫 실행 시 i18n 자동 감지에 사용.
  ipcMain.handle("app:getLocale", () => app.getLocale());
  /** package.json의 version — 사이드바 푸터 표기/디버그 용 */
  ipcMain.handle("app:getVersion", () => app.getVersion());

  // ── updater (electron-updater) ──────────────────────────
  // renderer가 마운트되자마자 현재 상태를 동기 조회. broadcast 이전에 새 창이 열려도 onState로 캐치.
  ipcMain.handle("updater:getState", () => getUpdaterState());
  ipcMain.handle("updater:check", () => updaterCheck());
  ipcMain.handle("updater:install", () => updaterInstall());

  // ── fs (워킹 폴더 패널 read-only) ───────────────────────
  ipcMain.handle("fs:pickDirectory", (e) => {
    const win = BrowserWindow.fromWebContents(e.sender);
    return pickDirectory(win);
  });
  ipcMain.handle("fs:listDirectory", (_e, absPath: string, showHidden?: boolean) =>
    listDirectory(absPath, showHidden ?? false),
  );
  ipcMain.handle("fs:readTextFile", (_e, absPath: string) => readTextFilePreview(absPath));

  // ── workspace (채팅별 working_folder) ───────────────────
  ipcMain.handle("workspace:get", (_e, chatId: string) => getChatWorkingFolder(chatId));
  ipcMain.handle("workspace:set", (_e, chatId: string, absPath: string | null) =>
    setChatWorkingFolder(chatId, absPath),
  );

  // ── auth (agentlas.cloud 구글 로그인) ───────────────────
  ipcMain.handle("auth:getSession", () => getAuthSession());
  ipcMain.handle("auth:signInWithGoogle", (e) => {
    const win = BrowserWindow.fromWebContents(e.sender);
    return signInWithGoogle(win);
  });
  ipcMain.handle("auth:signOut", () => signOut());

  // ── runtime ─────────────────────────────────────────────
  ipcMain.handle("runtime:detect", () => detectRuntimes());
  ipcMain.handle("runtime:setActive", (_e, selection: RuntimeSelection) =>
    setActiveRuntime(selection),
  );

  // ── secrets (macOS Keychain) ────────────────────────────
  ipcMain.handle("secrets:saveApiKey", (_e, backend: RuntimeBackend, key: string) =>
    saveApiKey(backend, key),
  );
  ipcMain.handle("secrets:hasApiKey", (_e, backend: RuntimeBackend) => hasApiKey(backend));
  ipcMain.handle("secrets:deleteApiKey", (_e, backend: RuntimeBackend) =>
    deleteApiKey(backend),
  );

  // ── env vault (글로벌 외부 API 키) ──────────────────────
  ipcMain.handle("env:list", async () => {
    // 1) keychain에 저장된 env keys
    const stored = await listEnvKeys();
    // 2) 설치된 에이전트들의 envRequirements
    const agents = listInstalledAgents();
    type Aggregated = {
      hasValue: boolean;
      requiredBy: Array<{
        agentId: string;
        agentName: string;
        agentNameEn: string;
        label?: string;
        labelEn?: string;
        hint?: string;
        hintEn?: string;
      }>;
    };
    const map = new Map<string, Aggregated>();
    for (const a of agents) {
      for (const req of a.envRequirements) {
        const entry = map.get(req.key) ?? { hasValue: false, requiredBy: [] };
        entry.requiredBy.push({
          agentId: a.id,
          agentName: a.name,
          agentNameEn: a.nameEn,
          label: req.label,
          labelEn: req.labelEn,
          hint: req.hint,
          hintEn: req.hintEn,
        });
        map.set(req.key, entry);
      }
    }
    // 사용자가 직접 추가한 키도 포함 (요구하는 에이전트 없음)
    for (const k of stored) {
      if (!map.has(k)) map.set(k, { hasValue: true, requiredBy: [] });
    }
    // hasValue를 한 번에 체크 (병렬)
    const keys = [...map.keys()];
    const values = await Promise.all(keys.map((k) => hasEnvVar(k)));
    return keys.map((key, i) => ({
      key,
      hasValue: values[i],
      requiredBy: map.get(key)!.requiredBy,
    }));
  });
  ipcMain.handle("env:set", (_e, key: string, value: string) => setEnvVar(key, value));
  ipcMain.handle("env:has", (_e, key: string) => hasEnvVar(key));
  ipcMain.handle("env:remove", (_e, key: string) => deleteEnvVar(key));

  // ── team (설치된 에이전트) ─────────────────────────────
  ipcMain.handle("team:list", () => listInstalledAgents());
  ipcMain.handle("team:install", (_e, slug: string) => installAgent(slug));
  ipcMain.handle("team:uninstall", (_e, id: string) => uninstallAgent(id));

  // ── marketplace (agentlas.cloud MCP 또는 in-memory fallback) ─
  ipcMain.handle("marketplace:listBundles", () => getMarketSource().listBundles());
  ipcMain.handle("marketplace:search", (_e, q: string) => getMarketSource().searchAgents(q));
  ipcMain.handle("marketplace:listFirms", () => getMarketSource().listFirms());
  ipcMain.handle("marketplace:status", () => getMarketSourceStatus());

  // ── firms (설치된 회사) ────────────────────────────────
  ipcMain.handle("firms:list", () => listFirms());
  ipcMain.handle("firms:get", (_e, id: string) => getFirm(id));
  ipcMain.handle("firms:install", (_e, slug: string) => installFirm(slug));
  ipcMain.handle("firms:uninstall", (_e, id: string) => uninstallFirm(id));

  // ── projects ───────────────────────────────────────────
  ipcMain.handle("projects:list", () => listProjects());
  ipcMain.handle("projects:get", (_e, id: string) => getProject(id));
  ipcMain.handle(
    "projects:create",
    (_e, input: { name: string; defaultAgentId?: string | null; contextNote?: string | null }) =>
      createProject(input),
  );
  ipcMain.handle(
    "projects:update",
    (
      _e,
      id: string,
      patch: Partial<Pick<Project, "name" | "contextNote" | "defaultAgentId">>,
    ) => updateProject(id, patch),
  );
  ipcMain.handle("projects:remove", (_e, id: string) => removeProject(id));

  // ── chats ──────────────────────────────────────────────
  ipcMain.handle("chats:listRecent", (_e, limit?: number) => listRecentChats(limit));
  ipcMain.handle("chats:listArchived", () => listArchivedChats());
  ipcMain.handle("chats:archive", (_e, id: string) => archiveChat(id));
  ipcMain.handle("chats:unarchive", (_e, id: string) => unarchiveChat(id));
  ipcMain.handle("chats:listByProject", (_e, projectId: string) =>
    listChatsByProject(projectId),
  );
  ipcMain.handle("chats:listByFirm", (_e, firmId: string) => listChatsByFirm(firmId));
  ipcMain.handle("chats:get", (_e, id: string) => getChat(id));
  ipcMain.handle(
    "chats:create",
    (
      _e,
      input: {
        agentId?: string;
        firmId?: string | null;
        projectId?: string | null;
        title?: string;
      },
    ) => createChat(input),
  );
  ipcMain.handle("chats:rename", (_e, id: string, title: string) => renameChat(id, title));
  ipcMain.handle("chats:switchAgent", (_e, id: string, agentId: string) =>
    switchChatAgent(id, agentId),
  );
  ipcMain.handle("chats:remove", (_e, id: string) => removeChat(id));

  // ── automations (M0 stub) ──────────────────────────────
  ipcMain.handle("automations:list", () => listAutomations());
  ipcMain.handle(
    "automations:create",
    (_e, input: Omit<Automation, "id" | "createdAt" | "lastRunAt" | "enabled">) =>
      createAutomation(input),
  );
  ipcMain.handle("automations:toggle", (_e, id: string, enabled: boolean) =>
    toggleAutomation(id, enabled),
  );
  ipcMain.handle("automations:remove", (_e, id: string) => removeAutomation(id));

  // ── migration (OpenClaw / Hermes → Agentlas) ────────────
  ipcMain.handle("migration:scan", () => scanMigrationSources());
  ipcMain.handle("migration:import", (_e, opts: MigrationOptions) => runMigration(opts));

  // ── invoke (백엔드 라우터 — 스트리밍 실행) ─────────────
  ipcMain.handle("invoke:run", async (event, req: McpInvocationRequest) => {
    const runId = randomUUID();
    const channel = `invoke:event:${runId}`;
    const win = BrowserWindow.fromWebContents(event.sender);

    void runMcpInvocation(req, (ev) => {
      win?.webContents.send(channel, ev);
    });

    return { runId };
  });

  ipcMain.handle("invoke:history", (_e, chatId: string) => listChatMessages(chatId));
  ipcMain.handle("invoke:clearHistory", (_e, chatId: string) => {
    clearChatMessages(chatId);
  });
}
