#!/usr/bin/env node
/*
 * workforce-host-authority-contract — a Workforce row carries no package ceiling.
 *
 * Owner decision 2026-08-20 (capability grants replace static permission), applied to
 * the Workforce path 2026-09-05: a prepared row whose policy is `host` executes under the
 * host run mode and capability grants — never forced read-only, never the no-authority
 * sandbox — and its receipt says so honestly. Legacy `deny` policies must still validate
 * so plans prepared before this date keep working.
 *
 * Calls the real decisions in dist (no source-string matching).
 */
const assert = require("node:assert/strict");
const path = require("node:path");
const root = path.resolve(__dirname, "..");
const orchestrator = require(path.join(root, "dist/electron/mcp/workforce-orchestrator.js"));
const runner = require(path.join(root, "dist/electron/runtime/runner.js"));

const hostPolicy = {
  schemaVersion: "agentlas.workforce-permission-policy.v1",
  network: "host",
  shell: "host",
  fileRead: { mode: "host", allowPatterns: [], denyPatterns: [] },
  mcp: { mode: "host", allowedTools: [] },
  unknownTools: "deny",
};
const legacyDeny = {
  schemaVersion: "agentlas.workforce-permission-policy.v1",
  network: "deny",
  shell: "deny",
  fileRead: { mode: "deny", allowPatterns: [], denyPatterns: [] },
  mcp: { mode: "deny", allowedTools: [] },
  unknownTools: "deny",
};

// 1) the contract accepts `host` and still accepts legacy rows
assert.deepEqual(orchestrator.validateWorkforcePermissionPolicy(hostPolicy), hostPolicy);
assert.deepEqual(orchestrator.validateWorkforcePermissionPolicy(legacyDeny), legacyDeny);
assert.equal(orchestrator.isHostAuthorityPolicy(hostPolicy), true);
assert.equal(orchestrator.isHostAuthorityPolicy(legacyDeny), false);
assert.throws(
  () => orchestrator.validateWorkforcePermissionPolicy({ ...hostPolicy, mcp: { mode: "host", allowedTools: ["mcp__x__y"] } }),
  /empty allowlist/,
  "a host MCP policy must not smuggle an allowlist",
);
assert.throws(
  () => orchestrator.validateWorkforcePermissionPolicy({ ...hostPolicy, fileRead: { mode: "host", allowPatterns: ["README.md"], denyPatterns: [] } }),
  /empty patterns/,
  "a host fileRead policy must not smuggle patterns",
);
console.log("ok   policy contract: host accepted, legacy deny still valid, smuggled lists rejected");

// 2) the receipt for a host-authority run is honest: host-native, nothing ignored
const grant = {
  schemaVersion: "agentlas.desktop-workforce-runtime-tool-grant.v1",
  permissionPolicyDigest: "sha256:" + "1".repeat(64),
  toolInventoryDigest: "sha256:" + "2".repeat(64),
  grantedToolIds: [],
  expectedServerConfigKeys: [],
  canonicalConfigSha256: null,
  runtimeVersion: "test",
};
const receipt = runner.workforceHostAuthorityEnforcement({ workforceRuntimeToolGrant: grant }, "claude-code");
assert.equal(receipt.enforcementMode, "native-sandbox");
assert.equal(receipt.status, "enforced");
assert.equal(receipt.enforcementEvidence.sandboxMode, "host-native");
assert.equal(receipt.enforcementEvidence.toolInventory, "policy-filtered");
assert.equal(receipt.enforcementEvidence.ephemeral, false, "a host run is not pretended to be ephemeral");
assert.equal(receipt.enforcementEvidence.ignoredUserConfig, false);
assert.equal(receipt.enforcementEvidence.ignoredRules, false);
assert.equal(receipt.enforcementEvidence.toolInventoryDigest, grant.toolInventoryDigest);
assert.equal(runner.workforceHostAuthorityEnforcement({}, "claude-code"), undefined, "no grant, no receipt");
console.log("ok   receipt: host-authority run records native-sandbox/host-native honestly");

// 3) the prepared row itself: what the policy turns into before a runtime ever sees it.
//    This is the decision the owner's complaint landed on — a staffed row reported
//    "shell: deny, mcp: deny" because every v5 policy returned the no-authority sandbox.
const taskForce = require(path.join(root, "dist/electron/mcp/borrowed-task-force.js"));
const planRow = (permissionPolicy) => ({
  slug: "installed:host-authority-probe",
  name: "Host Authority Probe",
  directive: "You verify that the host's shell authority reaches a staffed Workforce row.",
  entityKind: "agent",
  source: "installed",
  routeLabel: "workforce:slot-host-authority",
  agentDefinitionId: "def-host-authority-probe",
  agentReleaseId: "rel-host-authority-probe",
  permissionPolicy,
});
const pairGrant = {
  slotId: "slot-host-authority",
  agentReleaseId: "rel-host-authority-probe",
  runtimeId: "claude-code",
  capabilityBindings: [],
  runner: {
    permission: "write",
    // A prepared row is minted with the sandbox markers; the host-authority branch is
    // what must strip them.
    untrustedNoTools: true,
    untrustedAllowedMcpTools: [],
    workforceRuntimeToolGrant: grant,
  },
  cleanup: () => {},
};

const hostRow = planRow(hostPolicy);
const hostBoundary = taskForce.packageToolBoundary(hostRow, pairGrant);
assert.equal(hostBoundary.untrustedNoTools, false, "a host-authority row is never forced into the no-authority sandbox");
assert.equal(hostBoundary.untrustedAllowedMcpTools, undefined, "the sandbox MCP allowlist must not survive a host run");
assert.equal(hostBoundary.permission, "write", "the host's own permission mode reaches the row (this was always 'read')");
assert.ok(hostBoundary.workforceRuntimeToolGrant, "the digest-bound grant still travels for the receipt");

const legacyRow = planRow(legacyDeny);
const legacyBoundary = taskForce.packageToolBoundary(legacyRow, pairGrant);
assert.equal(legacyBoundary.untrustedNoTools, true, "a legacy deny_all row keeps the no-authority sandbox");
assert.throws(
  () => taskForce.packageToolBoundary(hostRow),
  /workforce_runtime_grant_missing/,
  "a policy row without its minted grant must fail closed, host policy included",
);

// The prompt half: a host row must not be told a ceiling that makes it refuse.
const denyLine = taskForce.packagePermissionLine(legacyRow);
const hostLine = taskForce.packagePermissionLine(hostRow);
assert.match(denyLine, /package permission ceiling/i);
assert.match(denyLine, /"shell":\s*"deny"/, "the legacy ceiling is exactly the deny the owner saw");
assert.match(hostLine, /follow the host run mode/i);
const hostPrompt = taskForce.buildBorrowedAgentSystemPrompt(hostRow, hostBoundary.permission);
assert.equal(hostPrompt.includes(denyLine), false, "the host-authority prompt must not carry the legacy deny ceiling");
assert.equal(hostPrompt.includes(hostLine), true);
assert.doesNotMatch(hostPrompt, /"shell":\s*"deny"/, "no deny ceiling may reach the model on a host-authority row");
assert.ok(taskForce.buildBorrowedAgentSystemPrompt(legacyRow, "read").includes(denyLine));
console.log("ok   plan row: host policy keeps the host mode and states no ceiling; legacy stays sandboxed");

// Live counterpart (real `claude` process, real shell call, real receipt), local-only:
//   electron scripts/test-workforce-host-authority-e2e.cjs
console.log("workforce-host-authority-contract: PASS");
