// shared/types.ts를 렌더러에서 그대로 쓰도록 re-export.
export type {
  AgentEnvRequirement,
  AgentlasIpc,
  AgentlasUpdaterEvents,
  AuthSession,
  Automation,
  Chat,
  ChatHistoryEntry,
  DirListing,
  EnvVarMeta,
  FirmListing,
  FirmOrgNode,
  ImageAttachment,
  InstalledAgent,
  InstalledFirm,
  MarketplaceListing,
  MarketplaceSourceStatus,
  McpInvocationEvent,
  McpInvocationRequest,
  McpServerStatus,
  McpToolCatalogEntry,
  McpTransport,
  InstalledMcpServer,
  MigrationApiKeyPreview,
  MigrationOptions,
  MigrationResult,
  MigrationSourceKind,
  MigrationSourcePreview,
  Project,
  RuntimeBackend,
  RuntimeCommand,
  RuntimeKind,
  RuntimeSelection,
  RuntimeStatus,
  TeamBundle,
  TextFilePreview,
  UpdaterState,
  WorkspaceNode,
} from "@shared/types";

export type LocalizedItem = {
  name: string;
  nameEn?: string;
  tagline?: string;
  taglineEn?: string;
};
