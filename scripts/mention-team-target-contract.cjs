#!/usr/bin/env node
// @ 지목이 팀 패키지를 태울 때의 계약 — 화면이 만든 대상을 Main 이 받아들여야 한다.
//
// 실측 결함(2026-09-05, Work 격리 실행): 라이브러리에서 "Travel Concierge Hq"(설치된
// 팀 패키지)를 @ 로 지목하면 화면이 { entityKind:"agent", agentId } 를 보냈고, Main 은
// 그 모양을 거절한다 —
//   electron/mcp/client.ts: "Installed team package must resolve to a Team/Firm target"
// 실행은 전송 16초 만에 실패로 끝났다: 워커 턴 0, 도구 사건 0, 답 없음.
//
// 이 게이트는 문장을 대조하지 않고 **판단 함수를 실제로 부른다**.
//   1) 팀 패키지는 그 팀(firm) 대상을 만든다 — 절대 entityKind "agent" 가 아니다
//   2) 보통 에이전트는 그대로 agent 대상을 만든다
//   3) 팀인데 설치된 firm 이 없으면 대상을 만들지 않는다(거절이 확정된 대상 금지)
//   4) 고장 주입: 옛 동작(항상 agent 대상)은 1번을 빨갛게 만든다
//
// 실행: node scripts/mention-team-target-contract.cjs

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const Module = require("node:module");
const ts = require("typescript");

const root = path.resolve(__dirname, "..");

const cache = new Map();
function loadTs(rel) {
  const file = path.join(root, rel);
  if (cache.has(file)) return cache.get(file);
  const source = fs.readFileSync(file, "utf8");
  const output = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
    fileName: file,
  }).outputText;
  const loaded = new Module(file, module);
  loaded.filename = file;
  loaded.paths = Module._nodeModulePaths(path.dirname(file));
  const originalRequire = loaded.require.bind(loaded);
  loaded.require = (request) => {
    if (request.startsWith("@shared/")) return loadTs(`shared/${request.slice("@shared/".length)}.ts`);
    if (request.startsWith("./") && !request.endsWith(".json")) {
      const target = path.relative(root, path.join(path.dirname(file), request));
      const candidate = fs.existsSync(path.join(root, `${target}.ts`)) ? `${target}.ts` : `${target}.tsx`;
      return loadTs(candidate);
    }
    return originalRequire(request);
  };
  cache.set(file, loaded.exports);
  loaded._compile(output, file);
  return loaded.exports;
}

const { installedAgentMentionTarget } = loadTs("renderer/lib/mention-orchestration-target.ts");

/* Main 이 로컬 대상에 요구하는 모양. client.ts 의 검사와 같은 조건을 여기서 판정한다:
   local+agent 는 agentId, local+team 은 firmId 를 들고 있어야 한다. */
function mainAcceptsLocalTarget(target, teamPackageAgentIds) {
  if (!target) return "no-target";
  if (target.source !== "local") return "not-local";
  if (target.entityKind === "agent") {
    if (typeof target.agentId !== "string" || !target.agentId.trim()) return "agent-target-invalid";
    // 이것이 실제로 죽던 자리다 — 팀 패키지를 단일 에이전트로 보내면 Main 이 던진다.
    if (teamPackageAgentIds.has(target.agentId)) return "installed-team-package-rejected";
    return "accepted";
  }
  if (target.entityKind === "team") {
    return typeof target.firmId === "string" && target.firmId.trim() ? "accepted" : "team-target-invalid";
  }
  return "unknown-entity-kind";
}

// 실측 행 모양 그대로(설치된 팀 = firm.ceoAgentId 가 그 에이전트 id).
const teamAgent = { id: "ae2d512c-travel", kind: "team" };
const plainAgent = { id: "b1be7f86-webmaster", kind: "agent" };
const orphanTeamAgent = { id: "9ba9b7ae-orphan", kind: "team" };
const firms = [
  { id: "firm-local-travel-concierge-hq", ceoAgentId: "ae2d512c-travel" },
  { id: "firm-local-template-ppt-studio-hq", ceoAgentId: "b96474b3-ppt" },
];
const teamPackageAgentIds = new Set([teamAgent.id, orphanTeamAgent.id]);

// 1) 팀 패키지 → 팀 대상
const teamTarget = installedAgentMentionTarget(teamAgent, firms);
assert.ok(teamTarget, "설치된 팀 패키지는 태울 대상이 있어야 한다");
assert.equal(teamTarget.entityKind, "team",
  `팀 패키지를 단일 에이전트로 보내면 Main 이 거절한다: ${JSON.stringify(teamTarget)}`);
assert.equal(teamTarget.firmId, "firm-local-travel-concierge-hq");
assert.equal(mainAcceptsLocalTarget(teamTarget, teamPackageAgentIds), "accepted");

// 2) 보통 에이전트는 그대로
const agentTarget = installedAgentMentionTarget(plainAgent, firms);
assert.deepEqual(agentTarget, { source: "local", entityKind: "agent", agentId: "b1be7f86-webmaster" });
assert.equal(mainAcceptsLocalTarget(agentTarget, teamPackageAgentIds), "accepted");

// 3) firm 이 없는 팀 패키지는 아예 대상을 만들지 않는다
assert.equal(installedAgentMentionTarget(orphanTeamAgent, firms), null,
  "거절이 확정된 대상을 화면이 만들어서는 안 된다");

// 4) 고장 주입 — 옛 동작(항상 agent 대상)이면 1번이 빨개진다
const legacy = (agent) => ({ source: "local", entityKind: "agent", agentId: agent.id });
assert.equal(mainAcceptsLocalTarget(legacy(teamAgent), teamPackageAgentIds), "installed-team-package-rejected",
  "고장 주입이 옛 결함을 재현하지 못하면 이 게이트는 장식이다");

console.log("mention-team-target-contract: PASS");
