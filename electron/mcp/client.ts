// 활성 백엔드 → 실제 러너로 라우팅하는 invocation runner.
// PRD §3.1 6단계 BYOC: 사용자 머신에서 사용자의 구독/키로 직접 호출.
// chatId 기반 — chat에서 agent + project 컨텍스트 lookup.
import { detectRuntimes } from "../runtime/detect";
import { getAgentById } from "./registry";
import {
  appendChatMessage,
  autoTitleFromFirstMessage,
  getChat,
  getChatWorkingFolder,
  listChatMessages,
} from "../store/chats";
import { getProject } from "../store/projects";
import { getFirm } from "../store/firms";
import { recordFolderVisit } from "../architecture/activation";
import { buildMemoryContext } from "../memory/context";
import { curateReply } from "../memory/curator";
import { MEMORY_EMITTER_BLOCK } from "../architecture/manifest";
import { runClaudeCode } from "../runtime/claude-code";
import { runCodex } from "../runtime/codex";
import { runGemini } from "../runtime/gemini";
import {
  runAnthropicByok,
  runGoogleByok,
  runOpenAIByok,
} from "../runtime/byok";
import { runOllama } from "../runtime/ollama";
import type { Runner } from "../runtime/runner";
import { pickLocale, tStatus } from "../runtime/status-i18n";
import type {
  McpInvocationEvent,
  McpInvocationRequest,
  RuntimeStatus,
} from "../../shared/types";

type EventSink = (ev: McpInvocationEvent) => void;

const RUNNER_LABEL: Record<string, string> = {
  "claude-code": "Claude Code CLI",
  codex: "Codex CLI",
  gemini: "Gemini CLI",
  "byok:anthropic": "Anthropic API",
  "byok:openai": "OpenAI API",
  "byok:google": "Google API",
};

function pickRunner(active: RuntimeStatus): { runner: Runner; label: string } | null {
  if (active.kind === "claude-code") return { runner: runClaudeCode, label: RUNNER_LABEL["claude-code"] };
  if (active.kind === "codex") return { runner: runCodex, label: RUNNER_LABEL.codex };
  if (active.kind === "gemini") return { runner: runGemini, label: RUNNER_LABEL.gemini };
  if (active.kind === "ollama")
    return { runner: runOllama, label: `Ollama${active.model ? ` · ${active.model}` : ""}` };
  if (active.kind === "byok") {
    if (active.backend === "anthropic")
      return { runner: runAnthropicByok, label: RUNNER_LABEL["byok:anthropic"] };
    if (active.backend === "openai")
      return { runner: runOpenAIByok, label: RUNNER_LABEL["byok:openai"] };
    if (active.backend === "google")
      return { runner: runGoogleByok, label: RUNNER_LABEL["byok:google"] };
  }
  return null;
}

function pickActive(list: RuntimeStatus[]): RuntimeStatus | null {
  return list.find((r) => r.active) ?? list[0] ?? null;
}

/**
 * Renderer → main IPC 진입점. chatId 기반.
 * 1) chat → agent + project lookup → system prompt 조립
 * 2) 사용자 메시지를 chat_messages에 영구화
 * 3) 활성 런타임 선택 → 러너에 위임
 */
export async function runMcpInvocation(
  req: McpInvocationRequest,
  sink: EventSink,
  signal?: AbortSignal,
): Promise<void> {
  const locale = pickLocale(req);
  const chat = getChat(req.chatId);
  if (!chat) {
    sink({ kind: "error", error: { code: "no-chat", message: tStatus(locale, "errChatNotFound") } });
    return;
  }
  const agent = getAgentById(chat.agentId);
  if (!agent) {
    sink({ kind: "error", error: { code: "no-agent", message: tStatus(locale, "errAgentNotFound") } });
    return;
  }

  const runtimes = await detectRuntimes();
  const active = pickActive(runtimes);
  if (!active) {
    sink({
      kind: "error",
      error: { code: "no-runtime", message: tStatus(locale, "errNoRuntime") },
    });
    return;
  }

  const picked = pickRunner(active);
  if (!picked) {
    sink({
      kind: "error",
      error: {
        code: "no-runner",
        message: tStatus(locale, "errNoRunner", {
          kind: active.kind,
          backend: active.backend,
        }),
      },
    });
    return;
  }

  // 프로젝트 컨텍스트 노트가 있으면 system prompt 뒤에 append
  let systemPrompt = agent.systemPrompt;
  if (chat.projectId) {
    const project = getProject(chat.projectId);
    if (project?.contextNote) {
      systemPrompt = `${systemPrompt}\n\n${tStatus(locale, "projectContext", {
        name: project.name,
      })}\n${project.contextNote}`;
    }
  }
  // 회사 채팅이면 firm 정보를 system prompt에 주입 — CEO가 자기 회사를 알 수 있게
  if (chat.firmId) {
    const firm = getFirm(chat.firmId);
    if (firm) {
      const roster = firm.orgChart
        .map(
          (n) =>
            `  - ${n.role}: ${n.agentSlug}${
              n.reportsTo ? ` ${tStatus(locale, "firmReportSuffix", { to: n.reportsTo })}` : ""
            }`,
        )
        .join("\n");
      systemPrompt =
        `${systemPrompt}\n\n` +
        `${tStatus(locale, "firmContext", { name: firm.name })}\n` +
        `${tStatus(locale, "firmCeoGuide")}\n` +
        `${tStatus(locale, "firmOrgChart")}\n${roster}\n` +
        tStatus(locale, "firmDelegateNote");
    }
  }

  // ── Agentlas 아키텍처: 메모리 주입 + 항상-켜진 큐레이터 ──────────────
  // 워킹 폴더에서 반복 작업하면 그 폴더가 활성화되고, 그때부터 프로젝트 메모리(.agentlas)를
  // 시스템 프롬프트에 주입한다. 폴더가 없거나 아직 활성 전이면 전역 메모리를 주입.
  const workingFolder = getChatWorkingFolder(chat.id);
  let activePath: string | null = null;
  if (workingFolder) {
    try {
      const visit = recordFolderVisit(workingFolder);
      if (visit.activated) activePath = workingFolder;
    } catch (err) {
      console.error("[architecture] recordFolderVisit failed:", err);
    }
  }
  try {
    const memoryContext = buildMemoryContext(activePath);
    if (memoryContext) systemPrompt = `${systemPrompt}\n\n${memoryContext}`;
  } catch (err) {
    console.error("[architecture] buildMemoryContext failed:", err);
  }
  // 모든 대화에 메모리 이벤트 emitter를 동봉 → 큐레이터가 전역적으로 기억을 관리.
  systemPrompt = `${systemPrompt}\n\n${MEMORY_EMITTER_BLOCK}`;

  const history = listChatMessages(chat.id, 80);

  // 사용자 메시지 영구화 + 첫 메시지면 제목 자동 생성
  appendChatMessage(chat.id, "user", req.userPrompt);
  if (history.length === 0) autoTitleFromFirstMessage(chat.id, req.userPrompt);

  sink({ kind: "thinking", status: tStatus(locale, "thinking", { agent: agent.name }) });

  try {
    const result = await picked.runner(
      {
        systemPrompt,
        history,
        userPrompt: req.userPrompt,
        images: req.images,
        backendLabel: picked.label,
        model: active.model ?? undefined,
        longContext: active.longContextEnabled ?? false,
        effort: active.effort ?? undefined,
        signal,
        permission: req.permissions,
        locale,
      },
      {
        onStatus: (status) => sink({ kind: "tool-use", status }),
        onPartial: (text) => sink({ kind: "partial", text }),
        // Claude Code식 tool-use 블록 — 이름 + 인자 JSON
        onTool: (name, args) => sink({ kind: "tool-use", tool: { name, args } }),
      },
    );

    // 항상-켜진 큐레이터: 답변 끝의 "## Memory Events" 블록을 파싱해 안전·스코프·중복 처리 후
    // 내구 메모리에 기록하고, 사용자에게 보이는 텍스트에서는 그 블록을 제거한다(추가 LLM 호출 없음).
    let displayText = result.text;
    try {
      const { cleanedText } = curateReply(result.text, {
        projectPath: activePath,
        projectId: chat.projectId ?? null,
        agentId: chat.agentId,
        chatId: chat.id,
      });
      displayText = cleanedText || result.text;
    } catch (err) {
      console.error("[architecture] curateReply failed:", err);
    }

    appendChatMessage(chat.id, "assistant", displayText);
    sink({ kind: "final", text: displayText, tokens: result.tokens });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    sink({ kind: "error", error: { code: "runner-failed", message: msg } });
  }
}
