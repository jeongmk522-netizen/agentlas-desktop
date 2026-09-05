import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ChildProcess } from "node:child_process";
import { detachedSpawnOpts, firstExistingCli, killCliTree, probeCliVersion, spawnCli } from "../runtime/exec";

export const SCIENCE_MCP_SERVER_KEY = "agentlas-science";

/**
 * These are the only Science tools Codex may run without its own MCP popup.
 *
 * `inspect_evidence_graph` is intentionally not labelled as a pure read: its handler refreshes the
 * canonical, machine-derived projection before returning the bounded graph. The host grant still
 * constrains that refresh to the current project and turn. Human decisions and their receipts are
 * not part of this allowlist.
 */
export const SCIENCE_CODEX_EXACT_TOOL_APPROVALS = [
  { toolName: "inspect_research_workspace", effect: "bounded-read" },
  { toolName: "list_research_hypotheses", effect: "bounded-read" },
  { toolName: "inspect_evidence_graph", effect: "derived-projection-refresh" },
] as const;

export function scienceCodexExactToolApprovalConfigArgs(supported: boolean): string[] {
  if (!supported) return [];
  return SCIENCE_CODEX_EXACT_TOOL_APPROVALS.flatMap(({ toolName }) => [
    "-c",
    `mcp_servers.${SCIENCE_MCP_SERVER_KEY}.tools.${toolName}.approval_mode="approve"`,
  ]);
}

const capabilityByInstalledCli = new Map<string, Promise<boolean>>();

/**
 * Ask the installed CLI parser and app-server handshake, rather than guessing from a version.
 * Unknown CLI, strict-config rejection, startup failure, timeout, or malformed response all fail
 * closed: the caller receives no automatic-approval overrides and Codex keeps prompting normally.
 */
export async function installedCodexSupportsExactMcpToolApproval(): Promise<boolean> {
  const bin = await firstExistingCli(["codex"], { probeTimeoutMs: 3_000 });
  if (!bin) return false;
  const version = await probeCliVersion(bin, 3_000);
  if (!version) return false;
  const key = `${bin}\0${version}`;
  let probe = capabilityByInstalledCli.get(key);
  if (!probe) {
    probe = probeExactMcpToolApproval(bin);
    capabilityByInstalledCli.set(key, probe);
  }
  return probe;
}

function probeExactMcpToolApproval(bin: string): Promise<boolean> {
  const probeHome = fs.mkdtempSync(path.join(os.tmpdir(), "agentlas-codex-tool-approval-"));
  const args = [
    "app-server",
    "--strict-config",
    "-c", `mcp_servers.${SCIENCE_MCP_SERVER_KEY}.command=${JSON.stringify(process.execPath)}`,
    ...scienceCodexExactToolApprovalConfigArgs(true),
    "--listen", "stdio://",
  ];

  return new Promise<boolean>((resolve) => {
    let child: ChildProcess;
    let settled = false;
    let stdout = "";
    const cleanup = () => {
      try { fs.rmSync(probeHome, { recursive: true, force: true }); } catch { /* best effort */ }
    };
    const finish = (supported: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (child.exitCode === null && child.signalCode === null) killCliTree(child, 250);
      resolve(supported);
    };
    const timeout = setTimeout(() => finish(false), 5_000);
    timeout.unref?.();

    try {
      child = spawnCli(bin, args, {
        ...detachedSpawnOpts(),
        env: { ...process.env, CODEX_HOME: probeHome },
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch {
      clearTimeout(timeout);
      cleanup();
      resolve(false);
      return;
    }

    child.once("error", () => finish(false));
    child.once("close", () => {
      cleanup();
      finish(false);
    });
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      stdout = (stdout + chunk).slice(-32_768);
      let newline = stdout.indexOf("\n");
      while (newline >= 0) {
        const line = stdout.slice(0, newline).trim();
        stdout = stdout.slice(newline + 1);
        if (line) {
          try {
            const message = JSON.parse(line) as { id?: unknown; result?: unknown; error?: unknown };
            if (message.id === 1) {
              finish(Boolean(message.result) && !message.error);
              return;
            }
          } catch {
            // Ignore logs; only a valid JSON-RPC initialize response proves support.
          }
        }
        newline = stdout.indexOf("\n");
      }
    });
    child.stdin?.on("error", () => finish(false));
    try {
      child.stdin?.write(`${JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          clientInfo: { name: "agentlas-desktop-capability-probe", version: "1.0" },
          capabilities: { experimentalApi: true, requestAttestation: false },
        },
      })}\n`);
    } catch {
      finish(false);
    }
  });
}
