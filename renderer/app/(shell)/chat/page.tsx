// 단일 채팅 페이지 — chatId 기반.
// 헤더: 채팅 제목(인라인 편집), 에이전트 정보, 삭제 버튼.
// 본문: ChatStream + 입력창.
"use client";
import { Suspense, useCallback, useEffect, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { ipc, ipcEvents } from "@/lib/ipc";
import type {
  Chat,
  ImageAttachment,
  InstalledAgent,
  InstalledFirm,
  McpInvocationEvent,
  Project,
  RuntimeCommand,
} from "@/lib/types";
import { ChatStream, type StreamMessage } from "@/components/ChatStream";
import { extractQuestions } from "@/lib/ask-question";
import { ChatInput } from "@/components/ChatInput";
import { ArtifactPanel } from "@/components/ArtifactPanel";
import { WorkspacePanel } from "@/components/WorkspacePanel";
import { AgentAvatar } from "@/components/AgentAvatar";
import type { CodeArtifact } from "@/components/Markdown";
import { IconBuilding, IconChevronRight, IconFolder, IconSparkles, IconTrash } from "@/components/Icon";
import { pickLocalized, useT } from "@/lib/i18n";

function uid(): string {
  return Math.random().toString(36).slice(2);
}

export default function ChatPageWrapper() {
  // useSearchParams는 Suspense boundary를 요구함 (Next 15)
  return (
    <Suspense fallback={null}>
      <ChatPage />
    </Suspense>
  );
}

function ChatPage() {
  const searchParams = useSearchParams();
  const chatId = searchParams.get("id") ?? "";
  // 홈 composer가 ?prompt=...로 첫 메시지를 실어서 보내면 자동 전송 (한 번만)
  const seedPrompt = searchParams.get("prompt") ?? "";
  const router = useRouter();
  const { t, locale } = useT();
  const [chat, setChat] = useState<Chat | null>(null);
  const [agent, setAgent] = useState<InstalledAgent | null>(null);
  const [allAgents, setAllAgents] = useState<InstalledAgent[]>([]);
  const [allFirms, setAllFirms] = useState<InstalledFirm[]>([]);
  const [allProjects, setAllProjects] = useState<Project[]>([]);
  const [allEnvKeys, setAllEnvKeys] = useState<string[]>([]);
  const [cliCommands, setCliCommands] = useState<RuntimeCommand[]>([]);
  const [firm, setFirm] = useState<InstalledFirm | null>(null);
  const [project, setProject] = useState<Project | null>(null);
  const [messages, setMessages] = useState<StreamMessage[]>([]);
  const [busy, setBusy] = useState(false);
  const [editingTitle, setEditingTitle] = useState(false);
  const [titleDraft, setTitleDraft] = useState("");
  const subRef = useRef<(() => void) | null>(null);
  const seededRef = useRef<string>("");
  const [artifact, setArtifact] = useState<CodeArtifact | null>(null);
  // 우측 워크스페이스 패널 — 채팅 진입 시 working_folder가 저장돼 있으면 자동 노출
  const [workspaceOpen, setWorkspaceOpen] = useState(false);

  // Esc로 artifact 패널 닫기
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape" && artifact) setArtifact(null);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [artifact]);

  // 메타데이터 로드
  useEffect(() => {
    const api = ipc();
    if (!api || !chatId) return;
    let cancelled = false;
    void (async () => {
      const c = await api.chats.get(chatId);
      if (cancelled || !c) {
        if (!c) router.replace("/");
        return;
      }
      setChat(c);
      setTitleDraft(c.title);
      const [agents, history, projectsAll, firmsAll, envVars] = await Promise.all([
        api.team.list(),
        api.invoke.history(chatId),
        api.projects.list(),
        api.firms.list(),
        api.env.list(),
      ]);
      if (cancelled) return;
      setAllAgents(agents);
      setAllProjects(projectsAll);
      setAllFirms(firmsAll);
      // @ 멘션 popover에는 실제로 값이 저장된 키만 노출 — 비어있는 키를 멘션하면 invocation에서 빈 값이 주입돼 혼란.
      setAllEnvKeys(envVars.filter((e) => e.hasValue).map((e) => e.key));
      // CLI 슬래시 명령 스캔 (매 진입 시 최신) — 느려도 채팅 표시를 막지 않게 후속 로드.
      void api.runtime.listCommands().then((cmds) => {
        if (!cancelled) setCliCommands(cmds);
      });
      setAgent(agents.find((a) => a.id === c.agentId) ?? null);
      // working_folder가 이미 저장돼 있으면 자동으로 패널 노출 (다음 진입 시 복원)
      const savedFolder = await api.workspace.get(chatId);
      if (!cancelled && savedFolder) setWorkspaceOpen(true);
      if (c.projectId) {
        const p = await api.projects.get(c.projectId);
        if (!cancelled) setProject(p);
      }
      if (c.firmId) {
        const f = await api.firms.get(c.firmId);
        if (!cancelled) setFirm(f);
      } else {
        setFirm(null);
      }
      setMessages(
        history.map((e) => ({
          id: e.id,
          role: e.role === "assistant" ? "agent" : e.role === "user" ? "user" : "system",
          text: e.text,
        })),
      );
    })();
    return () => {
      cancelled = true;
      subRef.current?.();
      subRef.current = null;
    };
  }, [chatId, router]);

  const send = useCallback(
    async (userPrompt: string, images?: ImageAttachment[]) => {
      const api = ipc();
      const events = ipcEvents();
      if (!api || !events || !chat || busy) return;
      const placeholderId = uid();
      const imageDataUrls = images?.map(
        (img) => `data:${img.mediaType};base64,${img.data}`,
      );
      const startedAt = Date.now();
      setMessages((m) => [
        ...m,
        { id: uid(), role: "user", text: userPrompt, imageDataUrls },
        {
          id: placeholderId,
          role: "agent",
          text: "",
          busy: true,
          startedAt,
          steps: [
            { id: uid(), kind: "thinking", text: t("chat.status.sending") },
          ],
        },
      ]);
      setBusy(true);

      // locale을 동봉 — main이 emit하는 상태/오류 메시지가 사용자 언어로 나오도록.
      const { runId } = await api.invoke.run({
        chatId: chat.id,
        userPrompt,
        images,
        locale,
      });
      const channel = api.invoke.eventChannel(runId);
      subRef.current?.();
      // 같은 status가 연달아 오면 중복 push 방지 — runner는 onStatus를 throttle 안 해서 partial과 섞이기도.
      const lastStatusRef = { text: "" };
      subRef.current = events.on(channel, (ev: McpInvocationEvent) => {
        if (ev.kind === "thinking" || ev.kind === "tool-use") {
          const status = ev.status?.trim();
          if (!status || status === lastStatusRef.text) return;
          lastStatusRef.text = status;
          setMessages((m) =>
            m.map((msg) =>
              msg.id === placeholderId
                ? {
                    ...msg,
                    steps: [
                      ...(msg.steps ?? []),
                      { id: uid(), kind: ev.kind === "thinking" ? "thinking" : "tool", text: status },
                    ],
                  }
                : msg,
            ),
          );
        } else if (ev.kind === "partial") {
          setMessages((m) =>
            m.map((msg) => {
              if (msg.id !== placeholderId) return msg;
              const raw = ev.text ?? "";
              const { text, questions } = extractQuestions(raw, msg.id);
              return {
                ...msg,
                text,
                streaming: true,
                questions: questions.length > 0 ? questions : msg.questions,
              };
            }),
          );
        } else if (ev.kind === "final") {
          setMessages((m) =>
            m.map((msg) => {
              if (msg.id !== placeholderId) return msg;
              const raw = ev.text ?? "";
              const { text, questions } = extractQuestions(raw, msg.id);
              return {
                ...msg,
                text,
                busy: false,
                streaming: false,
                questions: questions.length > 0 ? questions : msg.questions,
              };
            }),
          );
          setBusy(false);
          subRef.current?.();
          subRef.current = null;
          // 첫 메시지였으면 main 프로세스가 자동 제목 생성 → 갱신해서 사이드바도 반영
          void api.chats.get(chat.id).then((c) => c && setChat(c));
        } else if (ev.kind === "error") {
          setMessages((m) => [
            ...m.filter((msg) => msg.id !== placeholderId),
            { id: uid(), role: "system", text: `⚠️ ${ev.error?.message ?? t("chat.err.unknown")}` },
          ]);
          setBusy(false);
          subRef.current?.();
          subRef.current = null;
        }
      });
    },
    [chat, busy, locale, t],
  );

  /**
   * 에이전트가 emit한 질문(<<agentlas-ask>>)에 사용자가 답함.
   * — 해당 메시지의 questions 배열에서 그 질문을 'answered'로 표시(잠금)
   * — 답변 라벨을 user 메시지로 즉시 전송하여 에이전트에 컨텍스트 전달
   */
  const answerQuestion = useCallback(
    (messageId: string, questionId: string, answers: string[]) => {
      setMessages((m) =>
        m.map((msg) =>
          msg.id === messageId
            ? {
                ...msg,
                questions: msg.questions?.map((q) =>
                  q.id === questionId ? { ...q, answer: answers } : q,
                ),
              }
            : msg,
        ),
      );
      // 사용자의 선택을 자연어로 묶어 user 메시지로 보냄
      const reply = answers.length === 1 ? answers[0] : answers.map((a) => `• ${a}`).join("\n");
      void send(reply);
    },
    // send는 동일 useCallback에 의존
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [send],
  );

  // 홈 composer에서 ?prompt=...로 넘어왔으면 chat + agent 로드 직후 자동 전송
  useEffect(() => {
    if (!seedPrompt || !chat || !agent) return;
    if (seededRef.current === chatId) return;
    if (messages.length > 0) return; // 이미 히스토리 있으면 무시
    seededRef.current = chatId;
    void send(seedPrompt);
    // URL에서 prompt 파라미터 제거 — 새로고침에서 중복 전송 안 되도록
    router.replace(`/chat?id=${chatId}`);
  }, [seedPrompt, chat, agent, chatId, messages.length, send, router]);

  // 슬래시 커맨드 실행 — /new(새 채팅) /clear(기록 지우기) /help(단축키)
  const handleCommand = useCallback(
    (cmd: string) => {
      const api = ipc();
      if (!api || !chat) return;
      if (cmd === "/clear") {
        void api.invoke.clearHistory(chat.id).then(() => setMessages([]));
      } else if (cmd === "/new") {
        void api.chats
          .create({ agentId: chat.agentId, projectId: chat.projectId, firmId: chat.firmId })
          .then((c) => router.push(`/chat?id=${c.id}`));
      } else if (cmd === "/help") {
        setMessages((m) => [...m, { id: uid(), role: "system", text: t("chatinput.cmd.help_text") }]);
      }
    },
    [chat, router, t],
  );

  async function switchAgent(agentId: string) {
    const api = ipc();
    if (!api || !chat || agentId === chat.agentId) return;
    const updated = await api.chats.switchAgent(chat.id, agentId);
    setChat(updated);
    setAgent(allAgents.find((a) => a.id === agentId) ?? null);
    setFirm(null); // switchAgent는 firm을 해제
  }

  async function saveTitle() {
    const api = ipc();
    if (!api || !chat) return;
    const next = await api.chats.rename(chat.id, titleDraft);
    setChat(next);
    setEditingTitle(false);
  }

  async function removeChat() {
    const api = ipc();
    if (!api || !chat) return;
    if (!confirm(t("chat.confirm_delete"))) return;
    await api.chats.remove(chat.id);
    router.replace("/");
  }

  if (!chat) return null;

  return (
    <div style={{ display: "flex", height: "100%", width: "100%", minWidth: 0, overflow: "hidden" }}>
      <div style={{ flex: 1, display: "flex", flexDirection: "column", minWidth: 0 }}>
      <header
        className="titlebar-drag"
        style={{
          display: "flex",
          alignItems: "center",
          gap: 10,
          padding: "10px 20px",
          borderBottom: "var(--hairline)",
          background: "var(--paper)",
          minHeight: 56,
        }}
      >
        {agent && (
          <div
            className="titlebar-nodrag"
            style={{ position: "relative", display: "inline-flex", alignItems: "center" }}
          >
            <span
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 8,
                padding: "4px 10px 4px 4px",
                borderRadius: 999,
                background: firm ? "var(--fill-1)" : "var(--paper-2)",
                border: firm ? "1px solid var(--accent-soft)" : "1px solid var(--paper-edge)",
                cursor: "pointer",
              }}
              title={t("chat.switch_agent")}
            >
              {firm ? (
                <span
                  style={{
                    width: 26,
                    height: 26,
                    borderRadius: 8,
                    background: "var(--accent)",
                    color: "white",
                    display: "inline-flex",
                    alignItems: "center",
                    justifyContent: "center",
                  }}
                >
                  <IconBuilding size={14} />
                </span>
              ) : (
                <AgentAvatar name={pickLocalized(agent, locale).name} tone={agent.tone} size={26} />
              )}
              <span style={{ fontSize: 12, fontWeight: 600, color: "var(--ink)" }}>
                {pickLocalized(agent, locale).name}
              </span>
              {firm && (
                <span
                  style={{
                    fontSize: 10,
                    padding: "2px 6px",
                    borderRadius: 999,
                    background: "var(--accent)",
                    color: "white",
                    fontWeight: 700,
                  }}
                >
                  CEO · {pickLocalized(firm, locale).name}
                </span>
              )}
              <IconChevronRight
                size={11}
                style={{ color: "var(--muted)", transform: "rotate(90deg)" }}
              />
            </span>
            <select
              value={agent.id}
              onChange={(e) => void switchAgent(e.target.value)}
              aria-label={t("chat.switch_agent")}
              style={{
                position: "absolute",
                inset: 0,
                opacity: 0,
                cursor: "pointer",
              }}
            >
              {allAgents.map((a) => {
                const loc = pickLocalized(a, locale);
                return (
                  <option key={a.id} value={a.id}>
                    {loc.name} — {loc.tagline}
                  </option>
                );
              })}
            </select>
          </div>
        )}
        <div style={{ flex: 1, minWidth: 0, marginLeft: 12 }}>
          {project && (
            <div
              style={{
                fontSize: 10,
                color: "var(--muted-deep)",
                fontFamily: "var(--font-mono)",
                textTransform: "uppercase",
                letterSpacing: 0.6,
              }}
            >
              <span
                onClick={() => router.push(`/project/detail?id=${project.id}`)}
                style={{ cursor: "pointer", color: "var(--accent)", fontWeight: 600 }}
                className="titlebar-nodrag"
              >
                {project.name}
              </span>
            </div>
          )}
          {editingTitle ? (
            <input
              autoFocus
              value={titleDraft}
              onChange={(e) => setTitleDraft(e.target.value)}
              onBlur={() => void saveTitle()}
              onKeyDown={(e) => {
                if (e.key === "Enter") void saveTitle();
                if (e.key === "Escape") {
                  setTitleDraft(chat.title);
                  setEditingTitle(false);
                }
              }}
              className="titlebar-nodrag"
              style={{
                width: "100%",
                fontSize: 15,
                fontWeight: 600,
                fontFamily: "var(--font-head)",
                border: "1px solid var(--paper-edge)",
                borderRadius: 6,
                padding: "2px 6px",
                background: "var(--paper-2)",
              }}
            />
          ) : (
            <div
              onDoubleClick={() => setEditingTitle(true)}
              className="titlebar-nodrag"
              style={{
                fontFamily: "var(--font-head)",
                fontSize: 15,
                fontWeight: 600,
                color: "var(--ink)",
                cursor: "text",
              }}
              title={t("chat.rename_hint")}
            >
              {chat.title.trim() || t("chat.untitled")}
            </div>
          )}
        </div>
        <button
          onClick={() => setWorkspaceOpen((v) => !v)}
          className="titlebar-nodrag"
          aria-label={t("chat.workspace_panel")}
          title={t("chat.workspace_panel")}
          style={{
            color: workspaceOpen ? "var(--accent)" : "var(--muted-deep)",
            background: workspaceOpen ? "var(--fill-1)" : "transparent",
            padding: 6,
            borderRadius: 6,
            border: "none",
            cursor: "pointer",
          }}
        >
          <IconFolder size={16} />
        </button>
        <button
          onClick={() => void removeChat()}
          className="titlebar-nodrag"
          aria-label={t("chat.delete")}
          title={t("chat.delete")}
          style={{
            color: "var(--muted-deep)",
            padding: 6,
            borderRadius: 6,
          }}
        >
          <IconTrash size={16} />
        </button>
      </header>

      <ChatStream
        messages={messages}
        agentName={agent ? pickLocalized(agent, locale).name : t("chat.assistant_fallback")}
        agentTone={agent?.tone ?? "blue"}
        agentTagline={agent ? pickLocalized(agent, locale).tagline : undefined}
        firmName={firm ? pickLocalized(firm, locale).name : undefined}
        onOpenArtifact={setArtifact}
        onAnswerQuestion={answerQuestion}
      />
      <ChatInput
        onSend={(text, opts) => {
          void send(text, opts?.images);
        }}
        onCommand={handleCommand}
        busy={busy}
        disabled={!agent}
        context={{
          agents: allAgents,
          projects: allProjects,
          firms: allFirms,
          envKeys: allEnvKeys,
          commands: cliCommands,
        }}
      />
      </div>
      <ArtifactPanel artifact={artifact} onClose={() => setArtifact(null)} />
      {workspaceOpen && (
        <WorkspacePanel chatId={chatId || null} onClose={() => setWorkspaceOpen(false)} />
      )}
    </div>
  );
}
