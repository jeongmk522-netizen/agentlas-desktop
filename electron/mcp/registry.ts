// 설치된 에이전트 레지스트리 — SQLite-backed. 다국어 + envRequirements 지원.
import { randomUUID } from "node:crypto";
import { getDb } from "../store/db";
import { getSource as getMarketSource, getCargoSource } from "../marketplace";
import { materializeAgentFiles } from "../agents/files";
import type { SeedListingFull } from "../marketplace/source";
import type {
  AgentEnvRequirement,
  InstalledAgent,
  MarketplaceListing,
  RuntimeBackend,
} from "../../shared/types";

type FullListing = SeedListingFull & MarketplaceListing;

interface AgentRow {
  id: string;
  slug: string;
  name: string;
  name_en: string;
  tagline: string;
  tagline_en: string;
  system_prompt: string;
  mcp_servers_json: string;
  env_requirements_json: string;
  preferred_backend: RuntimeBackend | null;
  trust_grade: "A" | "B" | "C" | "unknown";
  installed_at: string;
  tone: string;
}

function toAgent(row: AgentRow): InstalledAgent {
  let envReqs: AgentEnvRequirement[] = [];
  try {
    envReqs = JSON.parse(row.env_requirements_json) as AgentEnvRequirement[];
  } catch {
    envReqs = [];
  }
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    nameEn: row.name_en || row.name,
    tagline: row.tagline,
    taglineEn: row.tagline_en || row.tagline,
    systemPrompt: row.system_prompt,
    mcpServers: JSON.parse(row.mcp_servers_json) as string[],
    envRequirements: envReqs,
    preferredBackend: row.preferred_backend,
    trustGrade: row.trust_grade,
    installedAt: row.installed_at,
    tone: row.tone as InstalledAgent["tone"],
  };
}

export function listInstalledAgents(): InstalledAgent[] {
  const rows = getDb()
    .prepare("SELECT * FROM installed_agents ORDER BY installed_at DESC")
    .all() as AgentRow[];
  return rows.map(toAgent);
}

export function getAgentById(id: string): InstalledAgent | null {
  const row = getDb()
    .prepare("SELECT * FROM installed_agents WHERE id = ?")
    .get(id) as AgentRow | undefined;
  return row ? toAgent(row) : null;
}

export async function installAgent(slug: string): Promise<InstalledAgent> {
  const listing = await getMarketSource().getListingBySlug(slug);
  if (!listing) throw new Error(`Unknown marketplace slug: ${slug}`);

  if (listing.trustGrade !== "A" && listing.trustGrade !== "B") {
    throw new Error(
      `Trust grade ${listing.trustGrade} blocked. Sideloading requires explicit approval (V1+).`,
    );
  }

  return persistListing(slug, listing);
}

/**
 * 내 에이전트(cargo) 설치 — 로그인 사용자가 agentlas.cloud에서 만든 draft.
 * 본인 소유라 trust 게이트는 건너뛴다(서버가 세션으로 소유권 확인).
 */
export async function installMyAgent(id: string): Promise<InstalledAgent> {
  const source = getCargoSource();
  if (!source) throw new Error("Agentlas marketplace is not connected (memory mode).");
  const listing = await source.getMyAgentManifest(id);
  if (!listing) throw new Error(`Your agent was not found: ${id}`);
  return persistListing(listing.slug, listing);
}

function persistListing(slug: string, listing: FullListing): InstalledAgent {
  const envReqsJson = JSON.stringify(listing.envRequirements ?? []);

  const db = getDb();
  const existing = db
    .prepare("SELECT * FROM installed_agents WHERE slug = ?")
    .get(slug) as AgentRow | undefined;
  if (existing) {
    db.prepare(
      `UPDATE installed_agents
       SET system_prompt = ?, name = ?, name_en = ?, tagline = ?, tagline_en = ?,
           env_requirements_json = ?
       WHERE slug = ?`,
    ).run(
      listing.systemPrompt,
      listing.name,
      listing.nameEn,
      listing.tagline,
      listing.taglineEn,
      envReqsJson,
      slug,
    );
    materializeAgentFiles(existing.id);
    return toAgent({
      ...existing,
      system_prompt: listing.systemPrompt,
      name: listing.name,
      name_en: listing.nameEn,
      tagline: listing.tagline,
      tagline_en: listing.taglineEn,
      env_requirements_json: envReqsJson,
    });
  }

  const id = randomUUID();
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO installed_agents
     (id, slug, name, name_en, tagline, tagline_en, system_prompt, mcp_servers_json,
      env_requirements_json, preferred_backend, trust_grade, installed_at, tone)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    slug,
    listing.name,
    listing.nameEn,
    listing.tagline,
    listing.taglineEn,
    listing.systemPrompt,
    JSON.stringify(listing.mcpServers),
    envReqsJson,
    null,
    listing.trustGrade,
    now,
    listing.tone,
  );

  materializeAgentFiles(id);

  return {
    id,
    slug,
    name: listing.name,
    nameEn: listing.nameEn,
    tagline: listing.tagline,
    taglineEn: listing.taglineEn,
    systemPrompt: listing.systemPrompt,
    mcpServers: listing.mcpServers,
    envRequirements: listing.envRequirements ?? [],
    preferredBackend: null,
    trustGrade: listing.trustGrade,
    installedAt: now,
    tone: listing.tone,
  };
}

export function uninstallAgent(id: string): void {
  getDb().prepare("DELETE FROM installed_agents WHERE id = ?").run(id);
}

// chat history는 electron/store/chats.ts로 이동했음 (chat_id FK 기반)
// 기존 import 경로 보호를 위해 deprecated re-export 남김 — V1에서 제거
export {
  appendChatMessage,
  listChatMessages as listChatHistory,
  clearChatMessages as clearChatHistory,
} from "../store/chats";
