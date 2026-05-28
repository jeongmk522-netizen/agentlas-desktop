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
  Project,
  RuntimeBackend,
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
