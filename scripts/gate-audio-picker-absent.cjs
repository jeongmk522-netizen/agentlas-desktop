#!/usr/bin/env node
// 오디오 생성 피커 부재 + 정직한 거절 경로 게이트.
//
// 배경(2026-08-25 감사, 8bdb0553로 데스크탑에서 이미 수리됨): One 설정 화면이 오디오
// 모달리티 피커(openai-audio·elevenlabs-audio)를 보여줬지만, 그것을 소비해 실제로 오디오를
// **생성하는 엔진이 어디에도 없었다** — electron/multimodal 은 image·video 엔진만 있고
// startAudio ipc/preload 도, generate_audio 도구도 없다. 피커를 보이면 사용자가 API 키까지
// 저장하는데 아무 것도 안 만드는 죽은 어포던스가 된다.
//
// 이 게이트가 값으로 증명하는 것 (순수 함수 판정 — 텍스트 매칭이 아니라 소스 구조 + 실제
// buildToolAccessNotice 호출 결과를 판정한다):
//  ① 데스크탑·웹 One 설정 화면 모두 피커 모달리티 목록에 "audio" 항목이 없다.
//  ② electron/ 안에 오디오 생성 엔진(startAudio ipc, generate_audio 도구)이 없다 —
//     피커를 다시 살려도 안전한지 판단할 근거.
//  ③ 사용자가 "오디오 만들어줘"라고 물었을 때 모델에게 가는 도구 접근 고지가 오디오 생성
//     도구를 있다고 말하지 않고, "없으면 없다고 말하라"는 정직 규칙을 반드시 포함한다
//     (shared/tool-access-notice.ts 의 기존 계약을 재사용 — 새 단어목록 아님).
//
// 빨간불 자가검증: 픽스처 문자열에 audio 모달리티를 주입해 ①의 파서가 실제로 잡아내는지
// 확인한다(실제 소스 파일은 건드리지 않는다).
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const DESKTOP_SETTINGS = path.join(root, "renderer/components/one/OneSettings.tsx");
const WEB_SETTINGS = "/Users/mason/Documents/Agentlas_F/agentlas/AgentsAtlas/app/src/one/components/one/OneSettings.tsx";

/** modalities 배열 리터럴에서 id: "..." 값들을 뽑는다. 파일이 없으면 던진다(감춤 금지). */
function extractModalityIds(source) {
  const match = source.match(/const modalities:[^=]*=\s*(\[[\s\S]*?\]);/);
  assert.ok(match, "modalities 배열 선언을 찾을 수 없다 — 화면 구조가 바뀌었으면 이 게이트도 갱신");
  const literal = match[1];
  const ids = [...literal.matchAll(/id:\s*"([a-z]+)"/g)].map((m) => m[1]);
  assert.ok(ids.length > 0, "modalities 배열이 비어 있다");
  return ids;
}

function checkNoAudioPicker(filePath, label) {
  const source = fs.readFileSync(filePath, "utf8");
  const ids = extractModalityIds(source);
  assert.ok(!ids.includes("audio"), `${label}: modalities 배열에 audio 가 남아 있다 (${ids.join(", ")})`);
  assert.ok(ids.includes("image") && ids.includes("video"), `${label}: image/video 피커까지 사라지면 안 된다`);
}

// ① 데스크탑 + 웹 모두 피커에 audio 없음
checkNoAudioPicker(DESKTOP_SETTINGS, "desktop OneSettings.tsx");
checkNoAudioPicker(WEB_SETTINGS, "web OneSettings.tsx");

// 빨간불 자가검증 — 파서가 실제로 audio 주입을 잡아내는가
{
  const fixtureWithAudio = 'const modalities: Array<{ id: MultimodalModality }> = [{ id: "image" }, { id: "video" }, { id: "audio" }];';
  let threw = false;
  try {
    checkNoAudioPickerFromSource(fixtureWithAudio);
  } catch {
    threw = true;
  }
  assert.ok(threw, "자가검증 실패 — 파서가 audio 주입을 잡아내지 못했다(게이트가 무의미, gate-audio-picker-absent.cjs)");
}
function checkNoAudioPickerFromSource(source) {
  const ids = extractModalityIds(source);
  assert.ok(!ids.includes("audio"), "fixture: audio 가 있는데도 통과했다");
}

// ② electron/ 안에 오디오 생성 엔진이 없다 (있으면 이 게이트가 낡은 것 — 실패시켜 알린다)
{
  const electronDir = path.join(root, "electron");
  const files = [];
  (function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.(ts|tsx|js|cjs|mjs)$/.test(entry.name)) files.push(full);
    }
  })(electronDir);
  const hits = [];
  for (const file of files) {
    const text = fs.readFileSync(file, "utf8");
    if (/\bstartAudio\b/.test(text) || /"generate_audio"/.test(text) || /'generate_audio'/.test(text)) {
      hits.push(file);
    }
  }
  assert.equal(
    hits.length,
    0,
    `electron/ 에 오디오 생성 엔진 흔적이 생겼다(${hits.join(", ")}) — 엔진이 생겼다면 피커를 되살리고 이 게이트를 갱신할 차례`,
  );
}

// ③ 도구 접근 고지가 오디오 생성 능력을 지어내지 않고, 정직 규칙을 담고 있다
{
  const { buildToolAccessNotice } = require(path.join(root, "dist/shared/tool-access-notice.js"));
  const notice = buildToolAccessNotice({
    availableTools: ["generate_image", "read_file"],
    hubCatalogAvailable: true,
  });
  assert.doesNotMatch(notice, /generate_audio/, "고지가 존재하지도 않는 generate_audio 를 언급했다");
  assert.doesNotMatch(notice, /audio/i, "고지가 오디오 능력을 암시했다");
  assert.match(notice, /say so plainly/, "정직 규칙(없으면 없다고 말하라)이 빠졌다 — 오디오 요청에 지어낼 위험");
  assert.match(notice, /Do not claim a capability that is not connected|Do not describe a tool call you did not make/, "지어내기 금지 문구가 빠졌다");
}

console.log("PASS gate-audio-picker-absent: 피커 부재 + 정직 거절 경로 확인 (desktop+web)");
