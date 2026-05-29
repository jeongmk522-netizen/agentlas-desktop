// Renderer는 sandbox에 갇혀 있고, 노출하는 IPC만 사용 가능.
// shared/types.ts AgentlasIpc 모양과 1:1 일치해야 한다.
import { contextBridge, ipcRenderer, webUtils } from "electron";
import type {
  AgentlasIpc,
  Automation,
  McpInvocationEvent,
  McpInvocationRequest,
  MigrationOptions,
  Project,
  RuntimeBackend,
  RuntimeSelection,
  UpdaterState,
} from "../shared/types";

const api: AgentlasIpc = {
  app: {
    getLocale: () => ipcRenderer.invoke("app:getLocale"),
    getVersion: () => ipcRenderer.invoke("app:getVersion"),
  },
  fs: {
    pickDirectory: () => ipcRenderer.invoke("fs:pickDirectory"),
    listDirectory: (absPath: string, showHidden?: boolean) =>
      ipcRenderer.invoke("fs:listDirectory", absPath, showHidden ?? false),
    readTextFile: (absPath: string) => ipcRenderer.invoke("fs:readTextFile", absPath),
  },
  workspace: {
    get: (chatId: string) => ipcRenderer.invoke("workspace:get", chatId),
    set: (chatId: string, absPath: string | null) =>
      ipcRenderer.invoke("workspace:set", chatId, absPath),
  },
  auth: {
    getSession: () => ipcRenderer.invoke("auth:getSession"),
    signInWithGoogle: () => ipcRenderer.invoke("auth:signInWithGoogle"),
    signInWithBrowser: () => ipcRenderer.invoke("auth:signInWithBrowser"),
    signOut: () => ipcRenderer.invoke("auth:signOut"),
  },
  updater: {
    getState: () => ipcRenderer.invoke("updater:getState"),
    check: () => ipcRenderer.invoke("updater:check"),
    install: () => ipcRenderer.invoke("updater:install"),
  },
  runtime: {
    detect: () => ipcRenderer.invoke("runtime:detect"),
    setActive: (selection: RuntimeSelection) =>
      ipcRenderer.invoke("runtime:setActive", selection),
    installCli: (kind: "claude-code" | "codex" | "gemini") =>
      ipcRenderer.invoke("runtime:installCli", kind),
    openCliLogin: (kind: "claude-code" | "codex" | "gemini") =>
      ipcRenderer.invoke("runtime:openCliLogin", kind),
    listCommands: () => ipcRenderer.invoke("runtime:listCommands"),
    listModels: (sel) => ipcRenderer.invoke("runtime:listModels", sel),
    installAgentlasCli: () => ipcRenderer.invoke("runtime:installAgentlasCli"),
  },
  secrets: {
    saveApiKey: (backend: RuntimeBackend, key: string) =>
      ipcRenderer.invoke("secrets:saveApiKey", backend, key),
    hasApiKey: (backend: RuntimeBackend) =>
      ipcRenderer.invoke("secrets:hasApiKey", backend),
    deleteApiKey: (backend: RuntimeBackend) =>
      ipcRenderer.invoke("secrets:deleteApiKey", backend),
  },
  env: {
    list: () => ipcRenderer.invoke("env:list"),
    set: (key: string, value: string) => ipcRenderer.invoke("env:set", key, value),
    has: (key: string) => ipcRenderer.invoke("env:has", key),
    remove: (key: string) => ipcRenderer.invoke("env:remove", key),
  },
  team: {
    list: () => ipcRenderer.invoke("team:list"),
    install: (slug: string) => ipcRenderer.invoke("team:install", slug),
    installMine: (id: string) => ipcRenderer.invoke("team:installMine", id),
    uninstall: (id: string) => ipcRenderer.invoke("team:uninstall", id),
    importLocalFolder: (absPath: string) =>
      ipcRenderer.invoke("team:importLocalFolder", absPath),
  },
  agentFiles: {
    list: (agentId: string) => ipcRenderer.invoke("agentFiles:list", agentId),
    read: (agentId: string, absPath: string) =>
      ipcRenderer.invoke("agentFiles:read", agentId, absPath),
    write: (agentId: string, absPath: string, content: string) =>
      ipcRenderer.invoke("agentFiles:write", agentId, absPath, content),
  },
  mcpTools: {
    listCatalog: () => ipcRenderer.invoke("mcpTools:listCatalog"),
    listInstalled: () => ipcRenderer.invoke("mcpTools:listInstalled"),
    install: (catalogId: string) => ipcRenderer.invoke("mcpTools:install", catalogId),
    installCustom: (def) => ipcRenderer.invoke("mcpTools:installCustom", def),
    remove: (id: string) => ipcRenderer.invoke("mcpTools:remove", id),
    setEnabled: (id: string, enabled: boolean) =>
      ipcRenderer.invoke("mcpTools:setEnabled", id, enabled),
    test: (id: string) => ipcRenderer.invoke("mcpTools:test", id),
    status: () => ipcRenderer.invoke("mcpTools:status"),
  },
  marketplace: {
    listBundles: () => ipcRenderer.invoke("marketplace:listBundles"),
    search: (q: string) => ipcRenderer.invoke("marketplace:search", q),
    listFirms: () => ipcRenderer.invoke("marketplace:listFirms"),
    status: () => ipcRenderer.invoke("marketplace:status"),
    listMine: () => ipcRenderer.invoke("marketplace:listMine"),
  },
  firms: {
    list: () => ipcRenderer.invoke("firms:list"),
    get: (id: string) => ipcRenderer.invoke("firms:get", id),
    install: (slug: string) => ipcRenderer.invoke("firms:install", slug),
    uninstall: (id: string) => ipcRenderer.invoke("firms:uninstall", id),
  },
  projects: {
    list: () => ipcRenderer.invoke("projects:list"),
    get: (id: string) => ipcRenderer.invoke("projects:get", id),
    create: (input) => ipcRenderer.invoke("projects:create", input),
    update: (id: string, patch: Partial<Pick<Project, "name" | "contextNote" | "defaultAgentId">>) =>
      ipcRenderer.invoke("projects:update", id, patch),
    remove: (id: string) => ipcRenderer.invoke("projects:remove", id),
  },
  chats: {
    listRecent: (limit?: number) => ipcRenderer.invoke("chats:listRecent", limit),
    listArchived: () => ipcRenderer.invoke("chats:listArchived"),
    listByProject: (projectId: string) =>
      ipcRenderer.invoke("chats:listByProject", projectId),
    listByFirm: (firmId: string) => ipcRenderer.invoke("chats:listByFirm", firmId),
    get: (id: string) => ipcRenderer.invoke("chats:get", id),
    create: (input) => ipcRenderer.invoke("chats:create", input),
    rename: (id: string, title: string) => ipcRenderer.invoke("chats:rename", id, title),
    switchAgent: (id: string, agentId: string) =>
      ipcRenderer.invoke("chats:switchAgent", id, agentId),
    archive: (id: string) => ipcRenderer.invoke("chats:archive", id),
    unarchive: (id: string) => ipcRenderer.invoke("chats:unarchive", id),
    remove: (id: string) => ipcRenderer.invoke("chats:remove", id),
  },
  automations: {
    list: () => ipcRenderer.invoke("automations:list"),
    create: (input: Omit<Automation, "id" | "createdAt" | "lastRunAt" | "enabled">) =>
      ipcRenderer.invoke("automations:create", input),
    toggle: (id: string, enabled: boolean) =>
      ipcRenderer.invoke("automations:toggle", id, enabled),
    remove: (id: string) => ipcRenderer.invoke("automations:remove", id),
  },
  migration: {
    scan: () => ipcRenderer.invoke("migration:scan"),
    import: (opts: MigrationOptions) => ipcRenderer.invoke("migration:import", opts),
  },
  invoke: {
    run: (req: McpInvocationRequest) => ipcRenderer.invoke("invoke:run", req),
    eventChannel: (runId: string) => `invoke:event:${runId}`,
    cancel: (runId: string) => ipcRenderer.invoke("invoke:cancel", runId),
    history: (chatId: string) => ipcRenderer.invoke("invoke:history", chatId),
    clearHistory: (chatId: string) =>
      ipcRenderer.invoke("invoke:clearHistory", chatId),
  },
};

contextBridge.exposeInMainWorld("agentlas", api);

// 드래그&드롭으로 들어온 File/폴더의 실제 디스크 경로를 얻는다 (Electron 32+ webUtils).
// 샌드박스 렌더러는 fs 접근이 없으므로 경로만 얻어 IPC로 넘긴다.
contextBridge.exposeInMainWorld("agentlasFiles", {
  pathForFile: (file: File): string => {
    try {
      return webUtils.getPathForFile(file);
    } catch {
      return "";
    }
  },
});
contextBridge.exposeInMainWorld("agentlasEvents", {
  on: (channel: string, handler: (event: McpInvocationEvent) => void) => {
    const wrapped = (_evt: Electron.IpcRendererEvent, payload: McpInvocationEvent) =>
      handler(payload);
    if (!channel.startsWith("invoke:event:")) return () => {};
    ipcRenderer.on(channel, wrapped);
    return () => ipcRenderer.removeListener(channel, wrapped);
  },
});

// 자동 업데이트 상태 broadcast — updater.ts의 broadcast()에서 webContents.send("updater:state", state)
contextBridge.exposeInMainWorld("agentlasUpdater", {
  onState: (handler: (state: UpdaterState) => void) => {
    const wrapped = (_e: Electron.IpcRendererEvent, state: UpdaterState) => handler(state);
    ipcRenderer.on("updater:state", wrapped);
    return () => ipcRenderer.removeListener("updater:state", wrapped);
  },
});

// 메뉴 → renderer 라우팅. 단순한 string payload만 화이트리스트.
contextBridge.exposeInMainWorld("agentlasMenu", {
  onNavigate: (handler: (route: string) => void) => {
    const wrapped = (_e: Electron.IpcRendererEvent, route: string) => handler(route);
    ipcRenderer.on("menu:navigate", wrapped);
    return () => ipcRenderer.removeListener("menu:navigate", wrapped);
  },
});
