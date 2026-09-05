import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { RunnerRequest, WorkforceHostObservation, WorkforceRuntimeToolGrant } from "./runner";
import { workforceHostObservationDigest } from "./runner";

const HASH = /^sha256:[0-9a-f]{64}$/;
const TOOL = /^[A-Za-z0-9][A-Za-z0-9_.$:/@+~-]{0,127}$/;
const SERVER = /^[a-z0-9][a-z0-9_-]{0,79}$/;
function fail(reason: string): never { throw new Error(`workforce_codex_observation_${reason}`); }
function record(value: unknown): value is Record<string, any> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function canonical(value: unknown): string {
  const sort = (item: any): any => Array.isArray(item) ? item.map(sort)
    : record(item) ? Object.fromEntries(Object.keys(item).sort().map((key) => [key, sort(item[key])])) : item;
  return JSON.stringify(sort(value));
}
function digest(value: unknown): string {
  return `sha256:${crypto.createHash("sha256").update(canonical(value)).digest("hex")}`;
}
function version(value: unknown): string | null {
  // app-server 0.153.4 reports its native version under initialize's client
  // name: agentlas-desktop/0.153.4 (...), not necessarily codex_cli_rs/....
  // Accept the exact client identity used by codex-session.ts as well as the
  // native CLI branding; never extract an arbitrary number from the response.
  return typeof value === "string"
    ? /(?:^|\s)(?:codex[-_]cli(?:[-_]rs)?|codex|agentlas-desktop)[/ ](\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?)(?=\s|$|\()/.exec(value)?.[1] ?? null
    : null;
}

/** Input provenance only. Codex does not echo an MCP endpoint/config digest. */
export function inspectCodexWorkforceGrant(req: RunnerRequest, args: string[]): string | null {
  const grant = req.workforceRuntimeToolGrant;
  if (!grant) return null;
  if (grant.schemaVersion !== "agentlas.desktop-workforce-runtime-tool-grant.v1"
    || !HASH.test(grant.permissionPolicyDigest) || !HASH.test(grant.toolInventoryDigest)
    || !Array.isArray(grant.grantedToolIds) || grant.grantedToolIds.length > 128
    || grant.grantedToolIds.some((id) => !TOOL.test(id))
    || new Set(grant.grantedToolIds).size !== grant.grantedToolIds.length
    || !Array.isArray(grant.expectedServerConfigKeys) || grant.expectedServerConfigKeys.length > 64
    || grant.expectedServerConfigKeys.some((key) => !SERVER.test(key))
    || new Set(grant.expectedServerConfigKeys).size !== grant.expectedServerConfigKeys.length) fail("grant_invalid");
  if (grant.canonicalConfigSha256 === null) {
    if (grant.grantedToolIds.length || grant.expectedServerConfigKeys.length || req.mcpConfigPath) fail("config_missing");
  } else {
    if (!HASH.test(grant.canonicalConfigSha256) || !req.mcpConfigPath) fail("config_missing");
    const before = fs.lstatSync(req.mcpConfigPath!);
    if (!before.isFile() || before.isSymbolicLink()) fail("config_not_regular");
    const bytes = fs.readFileSync(req.mcpConfigPath!);
    const after = fs.lstatSync(req.mcpConfigPath!);
    if (["dev", "ino", "size", "mtimeMs", "ctimeMs"].some((key) => before[key as keyof fs.Stats] !== after[key as keyof fs.Stats])) fail("config_changed");
    if (`sha256:${crypto.createHash("sha256").update(bytes).digest("hex")}` !== grant.canonicalConfigSha256) fail("config_digest_mismatch");
    const parsed = JSON.parse(bytes.toString("utf8"));
    if (!record(parsed?.mcpServers)
      || canonical(Object.keys(parsed.mcpServers).sort()) !== canonical([...grant.expectedServerConfigKeys].sort())) fail("config_servers_mismatch");
    const configured = new Set<string>();
    for (let index = 0; index < args.length; index += 2) {
      if (args[index] !== "-c" || typeof args[index + 1] !== "string") fail("config_args_invalid");
      const match = /^mcp_servers\.([a-z0-9][a-z0-9_-]{0,79})\./.exec(args[index + 1]);
      if (match) configured.add(match[1]);
    }
    if (grant.expectedServerConfigKeys.some((key) => !configured.has(key))) fail("config_args_server_missing");
  }
  // This binds the exact requested Codex overrides, not a fictional runtime
  // acknowledgement of Claude-format JSON or of the selected MCP endpoints.
  return digest({ canonicalConfigSha256: grant.canonicalConfigSha256, codexConfigArgs: args });
}

interface McpSnapshot {
  toolIds: string[];
  connectedServers: string[];
  digest: string;
}
type Request = (method: string, params: Record<string, unknown>, options: { timeoutMs: number; signal?: AbortSignal }) => Promise<any>;

/** Thread-scoped native inventory. No builtin/shell/collaboration enumeration is claimed. */
export async function readCodexWorkforceInventory(request: Request, threadId: string, signal?: AbortSignal): Promise<McpSnapshot> {
  const rows: Record<string, unknown>[] = [];
  const names = new Set<string>();
  const tools = new Set<string>();
  const servers = new Set<string>();
  const cursors = new Set<string>();
  let cursor: string | undefined;
  do {
    const response = await request("mcpServerStatus/list", {
      threadId, detail: "toolsAndAuthOnly", limit: 100, ...(cursor ? { cursor } : {}),
    }, { timeoutMs: 30_000, signal });
    if (!record(response) || !Array.isArray(response.data) || !(response.nextCursor === null || typeof response.nextCursor === "string")) fail("inventory_response_invalid");
    for (const row of response.data) {
      if (!record(row) || typeof row.name !== "string" || !row.name || names.has(row.name) || !record(row.tools)) fail("inventory_server_invalid");
      names.add(row.name);
      if (names.size > 256) fail("inventory_limit");
      if (row.toolsError != null || row.runtimeStatus == null) fail("inventory_unavailable");
      if (row.runtimeStatus === "connected") {
        servers.add(row.name);
        for (const tool of Object.values(row.tools)) {
          if (!record(tool) || typeof tool.name !== "string" || !tool.name || !record(tool.inputSchema)) fail("inventory_tool_invalid");
          const id = `mcp__${row.name}__${tool.name}`;
          if (tools.has(id)) fail("inventory_tool_duplicate");
          tools.add(id);
          if (tools.size > 4096) fail("inventory_limit");
        }
      } else if (Object.keys(row.tools).length) fail("inventory_disconnected_tools");
      // Include descriptors/serverInfo in stability verification but never
      // export their arbitrary content (or authentication material) as proof.
      rows.push({ name: row.name, runtimeStatus: row.runtimeStatus, serverInfo: row.serverInfo ?? null, tools: row.tools });
    }
    cursor = response.nextCursor ?? undefined;
    if (cursor !== undefined && (!cursor || cursors.has(cursor) || cursors.size >= 32)) fail("inventory_cursor_invalid");
    if (cursor) cursors.add(cursor);
  } while (cursor);
  return { toolIds: [...tools].sort(), connectedServers: [...servers].sort(), digest: digest(rows.sort((a, b) => String(a.name).localeCompare(String(b.name)))) };
}

/** One invocation, independent of whether its native process/thread was reused. */
export class CodexWorkforceObservation {
  private readonly runtimeVersion: string;
  private readonly grant: WorkforceRuntimeToolGrant;
  private policy: Record<string, unknown> | null = null;
  private threadId = "";
  private startedTurnId = "";
  private completedTurnId = "";
  private inventory: McpSnapshot | null = null;
  private problem: string | null = null;
  private approvals: Array<{ requestId: string; decision: string }> = [];

  constructor(private readonly req: RunnerRequest, init: unknown, private readonly configDigest: string | null) {
    this.grant = structuredClone(req.workforceRuntimeToolGrant!);
    const actual = record(init) ? version(init.userAgent) : null;
    if (!actual) fail("initialize_version_missing");
    this.runtimeVersion = actual!;
    const expected = this.grant.runtimeVersion;
    if (expected && expected !== actual && version(expected) !== actual) fail("runtime_version_mismatch");
  }

  acknowledgeThread(response: any, expected: { sandboxPolicy: Record<string, unknown>; approvalPolicy: string }, cwd: string, reviewer: string, threadId?: string): void {
    if (!record(response) || !record(response.sandbox) || typeof response.thread?.id !== "string" || !response.thread.id) fail("thread_policy_missing");
    if (threadId && response.thread.id !== threadId) fail("thread_id_mismatch");
    const actual = response.sandbox;
    const wanted = expected.sandboxPolicy;
    if (response.approvalPolicy !== expected.approvalPolicy || response.approvalsReviewer !== reviewer
      || response.cwd !== path.resolve(cwd) || actual.type !== wanted.type) fail("thread_policy_mismatch");
    // Protocol defaults have semantic meaning; do not mistake omitted false
    // booleans for authority. Unknown policy fields require adapter review.
    const known = actual.type === "workspaceWrite"
      ? ["type", "networkAccess", "writableRoots", "excludeTmpdirEnvVar", "excludeSlashTmp", "readOnlyAccess"]
      : actual.type === "readOnly" ? ["type", "networkAccess", "access"] : ["type"];
    if (Object.keys(actual).some((key) => !known.includes(key))) fail("thread_policy_unknown");
    // Newer app-server versions make the default host read access explicit.
    // Omitted and {type:fullAccess} are equivalent. Restricted read profiles
    // need a separately requested boundary and are never silently expanded.
    const accessKey = actual.type === "workspaceWrite" ? "readOnlyAccess" : "access";
    const access = actual[accessKey];
    if (access !== undefined && (!record(access) || access.type !== "fullAccess" || Object.keys(access).some((key) => key !== "type"))) fail("thread_read_access_mismatch");
    for (const key of known.filter((key) => !["type", "writableRoots", "readOnlyAccess", "access"].includes(key))) {
      if (actual[key] != null && typeof actual[key] !== "boolean") fail("thread_policy_invalid");
      if ((actual[key] ?? false) !== (wanted[key] ?? false)) fail("thread_policy_mismatch");
    }
    if (actual.type === "workspaceWrite") {
      if (!Array.isArray(actual.writableRoots) || actual.writableRoots.some((root: unknown) => typeof root !== "string" || !path.isAbsolute(root))) fail("thread_roots_missing");
      if (canonical([...actual.writableRoots].sort()) !== canonical([...(wanted.writableRoots as string[])].sort())) fail("thread_roots_mismatch");
    }
    this.threadId = response.thread.id;
    this.policy = JSON.parse(JSON.stringify({ sandbox: actual, approvalPolicy: response.approvalPolicy, approvalsReviewer: response.approvalsReviewer, cwd: response.cwd }));
  }

  observeInventory(snapshot: McpSnapshot): void {
    const grant = this.grant;
    if (grant.grantedToolIds.some((id) => !snapshot.toolIds.includes(id))
      || grant.expectedServerConfigKeys.some((key) => !snapshot.connectedServers.includes(key))) fail("grant_not_connected");
    if (this.inventory && this.inventory.digest !== snapshot.digest) fail("inventory_drift");
    this.inventory = snapshot;
  }

  startTurn(response: any): void {
    const id = response?.turn?.id;
    if (typeof id !== "string" || !id || !["inProgress", "completed"].includes(response.turn.status)) fail("turn_start_missing");
    this.startedTurnId = id;
  }

  completeTurn(params: any): void {
    if (params?.threadId !== this.threadId || typeof params?.turn?.id !== "string" || params.turn.status !== "completed" || params.turn.error != null) {
      this.problem = "completion_invalid";
      return;
    }
    if (this.completedTurnId) this.problem = "completion_duplicate";
    this.completedTurnId = params.turn.id;
  }

  assertRequestContext(params: any, activeTurnId: string): void {
    if (!activeTurnId || params?.threadId !== this.threadId || params?.turnId !== activeTurnId) {
      this.problem = "approval_turn_mismatch";
      fail(this.problem);
    }
  }

  approval(method: string, params: any, decision: string): void {
    const itemId = params?.approvalId ?? params?.itemId ?? params?.callId;
    if (params?.threadId !== this.threadId || typeof params?.turnId !== "string" || !params.turnId || typeof itemId !== "string" || !itemId) {
      this.problem = "approval_binding_missing";
      return;
    }
    const requestId = `${params.turnId}:${method}:${itemId}`;
    if (this.approvals.some((entry) => entry.requestId === requestId) || this.approvals.length >= 128) this.problem = "approval_duplicate";
    if (!["allow_once", "allow_session", "deny"].includes(decision)) this.problem = "approval_decision_invalid";
    this.approvals.push({ requestId, decision });
  }

  finish(): WorkforceHostObservation {
    if (this.problem) fail(this.problem);
    if (canonical(this.grant) !== canonical(this.req.workforceRuntimeToolGrant)) fail("grant_drift");
    if (!this.policy || !this.inventory || !this.startedTurnId || this.startedTurnId !== this.completedTurnId) fail("completion_missing");
    if (this.approvals.some((entry) => !entry.requestId.startsWith(`${this.startedTurnId}:`))) fail("approval_turn_mismatch");
    const grant = this.grant;
    const observation: Omit<WorkforceHostObservation, "observationDigest"> = {
      schemaVersion: "agentlas.workforce-host-observation.v1",
      permissionPolicyDigest: grant.permissionPolicyDigest,
      toolInventoryDigest: grant.toolInventoryDigest,
      runtimeKind: "codex", runtimeVersion: this.runtimeVersion,
      sessionId: this.threadId, turnId: this.startedTurnId,
      nativePolicy: this.policy!, toolIds: this.inventory!.toolIds,
      connectedServers: this.inventory!.connectedServers,
      inventoryScope: "connected-mcp-tools", nativeToolsEnumerated: false,
      requestedConfigDigest: this.configDigest,
      approvalEvents: this.approvals, completed: true,
    };
    return { ...observation, observationDigest: workforceHostObservationDigest(observation) };
  }
}
