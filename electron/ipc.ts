// IPC 핸들러 일괄 등록. main.ts 앱 ready 직후 호출.
// 각 도메인 모듈(runtime, secrets, team, marketplace, projects, chats, automations, invoke)을 thin wrapping.
import { app, BrowserWindow, dialog, ipcMain } from "electron";
import { randomUUID } from "node:crypto";
import { detectRuntimes, setActiveRuntime } from "./runtime/detect";
import { listRuntimeModels } from "./runtime/providers";
import { installCli, openCliLogin, type InstallableCli } from "./runtime/install-cli";
import { listRuntimeCommands } from "./runtime/commands";
import { installAgentlasCli } from "./runtime/install-agentlas-cli";
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
  installMyAgent,
  listInstalledAgents,
  uninstallAgent,
} from "./mcp/registry";
import { MCP_TOOL_CATALOG, getCatalogEntry } from "./mcp-tools/catalog";
import {
  installCustomServer,
  installFromCatalog,
  listInstalledServers,
  removeServer,
  setServerEnabled,
} from "./mcp-tools/registry";
import { statusAllServers, testServerById } from "./mcp-tools/client";
import {
  getSource as getMarketSource,
  getSourceStatus as getMarketSourceStatus,
  getCargoSource,
} from "./marketplace";
import {
  getFirm,
  installFirm,
  listFirms,
  uninstallFirm,
} from "./store/firms";
import { listAgentFiles, readAgentFile, writeAgentFile } from "./agents/files";
import { importLocalFolder } from "./agents/import-local";
import { getResolvedOrg } from "./store/org-spec";
import { resolveTeamOrg } from "./agents/org-resolver";
import { runMcpInvocation } from "./mcp/client";
import { checkSafely as updaterCheck, getUpdaterState, quitAndInstall as updaterInstall } from "./updater";
import { listDirectory, pickDirectory, readTextFilePreview } from "./fs/workspace";
import { getAuthSession, signInWithBrowser, signInWithGoogle, signOut } from "./auth";
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
  McpInvocationEvent,
  McpInvocationRequest,
  McpTransport,
  MigrationOptions,
  Project,
  RuntimeBackend,
  RuntimeKind,
  RuntimeSelection,
} from "../shared/types";

// 진행 중인 실행 레지스트리 — runId → { 취소 컨트롤러, 대상 chatId, 방출 이벤트 버퍼 }.
// 병렬 세션을 각각 독립 추적/취소하고, 채팅을 떠났다 돌아와도 진행 중 실행에 재접속할 수 있게
// 이벤트를 버퍼링한다. 텍스트 partial은 누적 전체 텍스트라 마지막 것만 유지하지만
// tool/thinking/agentId 이벤트는 누적되므로 MAX_BUFFERED_EVENTS로 상한을 둔다(오래된 것부터 폐기).
interface RunRecord {
  controller: AbortController;
  chatId: string;
  events: McpInvocationEvent[];
}
const activeRuns = new Map<string, RunRecord>();
// tool 폭주하는 긴 실행/대형 firm 실행의 버퍼 무한증가 방지 상한 (재접속 리플레이는 최근 위주).
const MAX_BUFFERED_EVENTS = 4000;

/** 현재 실행 중인 chatId 목록(중복 제거). */
function activeChatIds(): string[] {
  return [...new Set([...activeRuns.values()].map((r) => r.chatId))];
}

/** 사이드바 "실행 중" 인디케이터용 — 실행 시작/종료/취소 때마다 모든 창에 방송. */
function broadcastActiveChats(): void {
  const chatIds = activeChatIds();
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w.isDestroyed()) w.webContents.send("invoke:activeChats", chatIds);
  }
}

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
  ipcMain.handle("workspace:selectFolder", async () => {
    const res = await dialog.showOpenDialog({ properties: ["openDirectory", "createDirectory"] });
    return res.canceled || !res.filePaths.length ? null : res.filePaths[0];
  });
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
  ipcMain.handle("auth:signInWithBrowser", () => signInWithBrowser());
  ipcMain.handle("auth:signOut", () => signOut());

  // ── runtime ─────────────────────────────────────────────
  ipcMain.handle("runtime:detect", () => detectRuntimes());
  ipcMain.handle("runtime:setActive", (_e, selection: RuntimeSelection) =>
    setActiveRuntime(selection),
  );
  ipcMain.handle("runtime:installCli", (_e, kind: InstallableCli) => installCli(kind));
  ipcMain.handle("runtime:openCliLogin", (_e, kind: InstallableCli) => openCliLogin(kind));
  ipcMain.handle("runtime:listCommands", () => listRuntimeCommands());
  ipcMain.handle(
    "runtime:listModels",
    (_e, sel: { kind: RuntimeKind; backend?: RuntimeBackend | null; availableModels?: string[] | null }) =>
      listRuntimeModels(sel.kind, sel.backend ?? null, sel.availableModels ?? null, Date.now()),
  );
  ipcMain.handle("runtime:installAgentlasCli", () => installAgentlasCli());

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
    // 설치된 외부 MCP 서버가 요구하는 env도 합친다 — "어느 도구가 이 키를 쓰는지" 표시.
    for (const server of listInstalledServers()) {
      const catalog = server.catalogId ? getCatalogEntry(server.catalogId) : null;
      for (const key of server.envKeys) {
        const req = catalog?.envRequirements.find((r) => r.key === key);
        const entry = map.get(key) ?? { hasValue: false, requiredBy: [] };
        entry.requiredBy.push({
          agentId: `mcp:${server.id}`,
          agentName: `${server.name} (MCP)`,
          agentNameEn: `${server.nameEn || server.name} (MCP)`,
          label: req?.label,
          labelEn: req?.labelEn,
          hint: req?.hint,
          hintEn: req?.hintEn,
        });
        map.set(key, entry);
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
  ipcMain.handle("team:installMine", (_e, id: string) => installMyAgent(id));
  ipcMain.handle("team:uninstall", (_e, id: string) => uninstallAgent(id));
  // 로컬 폴더 임포트 — 런타임 감지 + 라우팅 저장 후 설치된 에이전트로 반환
  ipcMain.handle("team:importLocalFolder", async (_e, absPath: string) => (await importLocalFolder(absPath)).agent);

  // ── agentFiles (에이전트 폴더 파일 — 우측 패널 에디터) ──
  ipcMain.handle("agentFiles:list", (_e, agentId: string) => listAgentFiles(agentId));
  ipcMain.handle("agentFiles:read", (_e, agentId: string, absPath: string) =>
    readAgentFile(agentId, absPath),
  );
  ipcMain.handle("agentFiles:write", (_e, agentId: string, absPath: string, content: string) =>
    writeAgentFile(agentId, absPath, content),
  );

  // ── mcpTools (외부 MCP 툴 플러그인 — Slack/Discord/GitHub 등) ─
  ipcMain.handle("mcpTools:listCatalog", () => MCP_TOOL_CATALOG);
  ipcMain.handle("mcpTools:listInstalled", () => listInstalledServers());
  ipcMain.handle("mcpTools:install", (_e, catalogId: string) => installFromCatalog(catalogId));
  ipcMain.handle(
    "mcpTools:installCustom",
    (
      _e,
      def: {
        name: string;
        transport: McpTransport;
        command?: string;
        args?: string[];
        url?: string;
        envKeys?: string[];
      },
    ) => installCustomServer(def),
  );
  ipcMain.handle("mcpTools:remove", (_e, id: string) => removeServer(id));
  ipcMain.handle("mcpTools:setEnabled", (_e, id: string, enabled: boolean) =>
    setServerEnabled(id, enabled),
  );
  ipcMain.handle("mcpTools:test", (_e, id: string) => testServerById(id));
  ipcMain.handle("mcpTools:status", () => statusAllServers());

  // ── marketplace (agentlas.cloud MCP 또는 in-memory fallback) ─
  ipcMain.handle("marketplace:listBundles", () => getMarketSource().listBundles());
  ipcMain.handle("marketplace:search", (_e, q: string) => getMarketSource().searchAgents(q));
  ipcMain.handle("marketplace:listFirms", () => getMarketSource().listFirms());
  ipcMain.handle("marketplace:status", () => getMarketSourceStatus());
  // 내 에이전트(cargo) — 미로그인/오프라인/실패면 빈 배열(팝업이 안내 처리).
  ipcMain.handle("marketplace:listMine", async () => {
    const source = getCargoSource();
    if (!source) return [];
    try {
      return await source.listMyAgents();
    } catch {
      return [];
    }
  });

  // ── firms (설치된 회사) ────────────────────────────────
  ipcMain.handle("firms:list", () => listFirms());
  ipcMain.handle("firms:get", (_e, id: string) => getFirm(id));
  ipcMain.handle("firms:install", (_e, slug: string) => installFirm(slug));
  ipcMain.handle("firms:uninstall", (_e, id: string) => uninstallFirm(id));
  // 정규화된 3-tier 조직 스펙 조회 (저장된 리졸버 결과 또는 orgChart 파생)
  ipcMain.handle("firms:getResolvedOrg", (_e, id: string) => {
    const firm = getFirm(id);
    return firm ? getResolvedOrg(firm) : null;
  });
  // LLM으로 팀 폴더를 분석해 3-tier 조직 스펙 생성 (임포트 팀용)
  ipcMain.handle("firms:resolveOrg", (_e, id: string) => resolveTeamOrg(id));

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

  // ── automations (SQLite + scheduler) ───────────────────
  ipcMain.handle("automations:list", () => listAutomations());
  ipcMain.handle(
    "automations:create",
    (_e, input: Omit<Automation, "id" | "createdAt" | "lastRunAt" | "enabled" | "nextRunAt" | "createdBy">) =>
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

    // 실행마다 AbortController를 등록 — 병렬 실행이 서로 독립적으로 취소 가능.
    const controller = new AbortController();
    const record: RunRecord = { controller, chatId: req.chatId, events: [] };
    activeRuns.set(runId, record);
    broadcastActiveChats();

    void runMcpInvocation(
      req,
      (ev) => {
        // 재접속용 버퍼링 — partial은 매번 누적 전체 텍스트라, 직전이 partial이면 교체해
        // 메모리를 바운드한다(tool/thinking/agentId 이벤트는 누적 단계라 보존하되 상한 적용).
        const last = record.events[record.events.length - 1];
        if (ev.kind === "partial" && !ev.agentId && last && last.kind === "partial" && !last.agentId) {
          record.events[record.events.length - 1] = ev;
        } else {
          record.events.push(ev);
        }
        if (record.events.length > MAX_BUFFERED_EVENTS) {
          record.events.splice(0, record.events.length - MAX_BUFFERED_EVENTS);
        }
        win?.webContents.send(channel, ev);
        // 종료 이벤트는 즉시 레지스트리에서 제거 — 답변은 final emit 직전에 이미 영속화되므로(client.ts),
        // 재접속(attach)이 '끝난 실행'을 반환해 히스토리 행과 답변이 중복 렌더되는 창을 닫는다.
        if (ev.kind === "final" || ev.kind === "error") {
          if (activeRuns.delete(runId)) broadcastActiveChats();
        }
      },
      controller.signal,
    ).finally(() => {
      // 위 sink에서 이미 지워졌으면(정상 종료) no-op — abort/throw로 종료 이벤트가 없던 경우만 정리.
      if (activeRuns.delete(runId)) broadcastActiveChats();
    });

    return { runId };
  });

  // 진행 중인 실행 취소 — CLI 자식 프로세스 kill / API fetch abort.
  ipcMain.handle("invoke:cancel", (_e, runId: string) => {
    activeRuns.get(runId)?.controller.abort();
    if (activeRuns.delete(runId)) broadcastActiveChats();
  });

  // 현재 실행 중인 chatId 목록 — 사이드바 인디케이터 초기 시드용.
  ipcMain.handle("invoke:activeChats", () => activeChatIds());

  // 채팅 진입 시 진행 중 실행에 재접속 — 그 chat의 최신 실행 runId + 버퍼된 이벤트를 돌려준다.
  // 렌더러는 events를 리플레이해 진행 중 버블을 복원하고, runId 채널을 구독해 이후 스트림을 받는다.
  ipcMain.handle("invoke:attach", (_e, chatId: string) => {
    let found: { runId: string; events: McpInvocationEvent[] } | null = null;
    for (const [runId, rec] of activeRuns) {
      if (rec.chatId === chatId) found = { runId, events: rec.events.slice() };
    }
    return found;
  });

  ipcMain.handle("invoke:history", (_e, chatId: string) => listChatMessages(chatId));
  ipcMain.handle("invoke:clearHistory", (_e, chatId: string) => {
    clearChatMessages(chatId);
  });
}
