#!/usr/bin/env node
// ★ 값 게이트 — 문장 대조가 아니라 실제 함수를 부른다.
//
// 측정된 막다른 골목: One 조직도에서 만든 팀원(`createOneTeamAgent`)은
// `installed_agents` 행만 얻고 폴더 route는 등록되지 않아 `agent.localPath`가
// 영영 비었다. Cloud 업로드 후보 목록(`registeredUploadOptions`)의 경계는
// 정확히 "폴더를 가진 적이 있는가"(electron/cloud-agents/registered-upload.ts) —
// 그래서 사용자가 만든 팀원은 후보에 조용히 나타나지 않고, 이유도 액션도 없었다.
//
// 이 게이트는 실제 DB에 실제 팀원을 만들고(`createOneTeamAgent`), 실제 업로드
// 후보 계산(`registeredUploadOptions`)과 실제 경로 해석(`registeredUploadRoot`)을
// 불러 그 팀원이 도달 가능한지 값으로 확인한다. 소스 문자열은 보지 않는다.
//
// 안전: 전용 스크래치 userData(AGENTLAS_QA_USER_DATA_DIR)만 열고, 실 SQLite는
// 절대 열지 않는다. GUI 창을 띄우지 않는다(app.setPath만 하고 whenReady를 부르지
// 않음). 실행: electron scripts/gate-one-team-cloud-publish.cjs
"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { app } = require("electron");

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentlas-one-team-publish-"));
const userDataDir = path.join(tempDir, "user-data");
process.env.AGENTLAS_QA_USER_DATA_DIR = userDataDir;
process.env.AGENTLAS_ALLOW_MULTI_INSTANCE = "1";
process.env.AGENTLAS_STORE_PATH = path.join(tempDir, "agentlas.sqlite");
app.setPath("userData", userDataDir);

const { initStore } = require("../dist/electron/store/db.js");
const { createOneTeamAgent } = require("../dist/electron/one/org.js");
const { getRoute } = require("../dist/electron/agents/routes.js");
const {
  registeredUploadOptions,
  registeredUploadRoot,
} = require("../dist/electron/cloud-agents/registered-upload.js");

function findOption(options, installedAgentId) {
  return options.find(
    (option) => "agentId" in option.target && option.target.agentId === installedAgentId,
  );
}

(async () => {
  let exitCode = 0;
  try {
    initStore();

    const created = createOneTeamAgent({
      name: "Publish Gate Teammate",
      title: "QA",
      description: "Created only to prove the Cloud publish path is reachable.",
      avatar: { kind: "preset", characterId: "orange-dino" },
    });
    const agentId = created.installedAgentId;
    assert.ok(agentId, "createOneTeamAgent must return the new installed_agents id");

    // ① The established contract: a materialised teammate must be routed —
    // exactly like local-import / commerce-team — so agent.localPath resolves.
    const route = getRoute(agentId);
    assert.ok(route, "a One Team teammate must get a registered folder route at creation");
    assert.ok(fs.existsSync(route.path), "the routed folder must actually exist on disk");
    assert.ok(
      fs.existsSync(path.join(route.path, "system-prompt.md")),
      "the routed folder must contain the materialised agent files",
    );

    // ② The real dead end this gate exists to close: the teammate must be
    // reachable through the same functions Cloud upload calls.
    const options = registeredUploadOptions();
    const option = findOption(options, agentId);
    assert.ok(option, "a One Team teammate must appear in registeredUploadOptions()");
    assert.equal(option.sourceReady, true, "a freshly created teammate's source must be ready to publish");

    const root = registeredUploadRoot({ entityKind: "agent", agentId });
    assert.equal(root.rootPath, route.path, "registeredUploadRoot must resolve to the routed folder");
    assert.ok(fs.existsSync(root.rootPath), "the resolved upload root must exist");

    // ③ Red proof — revert the fix in memory (undo the route registration a
    // real creation would have made) and confirm the exact same assertions
    // the gate just passed now fail. This proves the gate is not vacuous.
    {
      const { removeRoute } = require("../dist/electron/agents/routes.js");
      removeRoute(agentId);
      const optionsWithoutRoute = registeredUploadOptions();
      const optionWithoutRoute = findOption(optionsWithoutRoute, agentId);
      assert.equal(
        optionWithoutRoute,
        undefined,
        "RED-PROOF FAILED: without a route the teammate must vanish from the upload list " +
          "(this is exactly the measured dead end) — the gate cannot tell the fix apart from its absence",
      );
      let threw = false;
      try {
        registeredUploadRoot({ entityKind: "agent", agentId });
      } catch (error) {
        threw = true;
        assert.equal(error.message, "registered-agent-source-unavailable");
      }
      assert.ok(threw, "RED-PROOF FAILED: registeredUploadRoot must refuse a routeless teammate");

      // Restore — put the route back exactly as creation would have, so a
      // second run of this same gate script (or any later assertion) still
      // sees the honest, fixed state and not a half-broken one.
      const { setRoute } = require("../dist/electron/agents/routes.js");
      setRoute(route);
      const optionsRestored = registeredUploadOptions();
      assert.ok(findOption(optionsRestored, agentId), "restoring the route must restore reachability");
    }

    console.log("One Team -> Cloud publish reachability gate: PASS (red proof confirmed, then restored)");
  } catch (error) {
    exitCode = 1;
    console.error(error);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
    if (app && typeof app.quit === "function") app.quit();
    process.exit(exitCode);
  }
})();
