#!/usr/bin/env node
/*
 * seat-departure-value-contract — 나간 사람은 대답하지 않는다 (UX-D-4), 값으로 증명.
 *
 * 2026-08-25 감사 #12: 이 계약을 지키던 게이트(test-seat-session-contract.cjs)는
 * org.ts / ipc.ts 의 소스 문자열을 정규식으로 봤다. 문자열을 바꾸면 통과하고 동작이
 * 바뀌면 못 잡는다. 이 파일은 격리 store 에서 실제 함수를 부른다:
 *   좌석 점유 → 보관(archiveOneOrgMember) → 점유가 닫혔는가 → 권위 가드가 쓰는 판정
 *   (solo 좌석·열린 점유 0·이력 >0 = 떠남) 이 참인가 → 복원해도 자리는 자동으로 안 채우나
 *   → 이력이 0인 새 좌석은 "떠남"으로 읽지 않는가(없는 데이터를 사실로 승격 금지).
 *
 * Run: npx electron scripts/seat-departure-value-contract.cjs
 */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
process.env.AGENTLAS_E2E = "1";
const { app } = require("electron");
app.disableHardwareAcceleration();
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "agentlas-seat-departure-"));
process.env.AGENTLAS_STORE_PATH = path.join(tmp, "agentlas.sqlite");
app.setPath("userData", path.join(tmp, "user-data"));

// ipc.ts 의 권위 가드와 같은 술어 — 떠났다는 것을 증명할 수 있을 때만 참.
function departedBySeatLedger(seats, seatId) {
  const seat = seats.getSeat(seatId);
  if (!seat || seat.kind !== "solo") return false;
  if (seats.currentSeatParticipants(seatId).length !== 0) return false;
  return seats.listSeatOccupantHistory(seatId).length > 0;
}

(async () => {
  let exitCode = 0;
  try {
    await app.whenReady();
    const store = require("../dist/electron/store/db.js");
    store.initStore();
    const db = store.getDb();
    require("../dist/electron/architecture/seed.js").seedBuiltinAgents();
    const seats = require("../dist/electron/store/seats.js");
    const org = require("../dist/electron/one/org.js");

    const agent = db.prepare("SELECT id, slug FROM installed_agents ORDER BY installed_at LIMIT 1").get();
    assert.ok(agent, "seeded store has an installed agent to seat");

    // 1) 앉힌다
    const seatId = seats.ensureSoloSeatForAgent(agent.id);
    assert.equal(seats.currentSeatParticipants(seatId).length, 1, "solo seat has one open occupant");
    assert.equal(departedBySeatLedger(seats, seatId), false, "an occupied seat is not 'departed'");
    const before = org.addOneOrgMember({ installedAgentId: agent.id });
    const member = before.members.find((row) => row.installedAgentId === agent.id && !row.archivedAt);
    assert.ok(member, "member joined One Team");

    // 2) 보관 = 자리를 비운다
    const after = org.archiveOneOrgMember({ id: member.id });
    const archived = after.members.find((row) => row.id === member.id);
    assert.ok(archived?.archivedAt, "org ledger marks the member archived");
    const history = seats.listSeatOccupantHistory(seatId);
    assert.equal(history.length, 1, "occupancy history is preserved (append-only)");
    assert.ok(history[0].until, "the open occupancy was closed by archiving");
    assert.equal(seats.currentSeatParticipants(seatId).length, 0, "no open occupant remains");
    assert.equal(departedBySeatLedger(seats, seatId), true, "the authority guard's predicate now says departed");
    console.log("ok   archiving a member closes their seat occupancy; the guard can prove the departure");

    // 3) 복원은 조직만 되돌리고 자리는 자동으로 채우지 않는다
    org.restoreOneOrgMember({ id: member.id });
    assert.equal(seats.currentSeatParticipants(seatId).length, 0, "restore does not silently re-seat");
    console.log("ok   restore returns the member to the org without re-seating");

    // 4) 이력 0 = 증명 없음 = 떠나지 않음 (구세대 미시딩 대화 보호)
    const now = new Date().toISOString();
    db.prepare("INSERT INTO one_seats (id, kind, title, project_id, created_at, updated_at) VALUES (?, 'solo', '', NULL, ?, ?)").run("seat_unseeded_probe", now, now);
    assert.equal(departedBySeatLedger(seats, "seat_unseeded_probe"), false, "zero history must not be read as departure");
    console.log("ok   a seat with no history is not 'departed' — absent data is not promoted to fact");
    console.log("seat-departure-value-contract: PASS");
  } catch (error) {
    exitCode = 1;
    console.error("seat-departure-value-contract: FAIL");
    console.error(error && error.stack ? error.stack : error);
  } finally {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* scratch */ }
    app.exit(exitCode);
  }
})();
