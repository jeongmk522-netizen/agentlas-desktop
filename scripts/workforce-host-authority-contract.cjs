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
console.log("workforce-host-authority-contract: PASS");
