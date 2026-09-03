"use client";
// 임시 QA 하네스 — ChatQuestionSheet 시각/동작 검증용. 검증 후 삭제.
import { useState } from "react";
import { ChatQuestionSheet } from "@/components/ChatQuestionSheet";
import type { ChatQuestion } from "@/components/ChatStream";

const QUESTIONS: ChatQuestion[] = [
  {
    id: "q1",
    header: "The offer",
    question: "What exactly are we advertising? (the customer's offer)",
    options: [
      { label: "I'll paste the brief now", description: "You give me: customer name, product, 1-line pitch." },
      { label: "Product/website link only", description: "Give me just the URL — I'll research it." },
      { label: "It's my own Agentlas product", description: "Advertise an Agentlas product/team from this folder." },
    ],
  },
  {
    id: "q2",
    header: "Targets",
    question: "Which posts should the 20 daily comments target?",
    multiSelect: true,
    options: [
      { label: "Hashtags / keyword search", description: "Fresh posts under hashtags/keywords." },
      { label: "A list of accounts", description: "New posts from specific accounts/competitors." },
    ],
  },
  {
    id: "q3",
    question: "Publish mode for both runs?",
    options: [
      { label: "Draft for my review (recommended)", description: "Each run drafts 20 comments and stops for approval." },
      { label: "Auto-publish live", description: "Post directly without review." },
    ],
  },
];

/**
 * `?n=<개수>` — 앞에서부터 그만큼만 묻는다.
 *
 * 게이트는 "한 질문짜리 시트에서 선택지를 고르면 그 자리에서 전송된다" 를 잰다.
 * 이 파라미터가 없으면 언제나 세 질문이 떠서 첫 선택이 '다음 질문으로' 가 되고, 그 검사는
 * 조용히 뜻을 잃는다(2026-09-04 실측: 게이트가 실패로 드러났다).
 */
function questionsFromQuery(): ChatQuestion[] {
  if (typeof window === "undefined") return QUESTIONS;
  const raw = new URLSearchParams(window.location.search).get("n");
  const n = raw == null ? NaN : Number(raw);
  if (!Number.isFinite(n) || n < 1) return QUESTIONS;
  return QUESTIONS.slice(0, Math.min(Math.trunc(n), QUESTIONS.length));
}

export default function QaQSheetPage() {
  const [sent, setSent] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [questions] = useState<ChatQuestion[]>(() => questionsFromQuery());
  return (
    <div style={{ height: "100vh", display: "flex", flexDirection: "column", background: "var(--paper, #faf9f7)" }}>
      <div style={{ flex: 1, padding: 20 }}>
        <button onClick={() => setBusy((v) => !v)}>busy: {String(busy)}</button>
        {sent && <pre style={{ fontSize: 11, whiteSpace: "pre-wrap" }}>{sent}</pre>}
      </div>
      <ChatQuestionSheet questions={questions} busy={busy} onConfirm={(reply) => setSent(reply)} onDismiss={() => setSent("(dismissed)")} />
      <div style={{ height: 80, margin: "8px 16px", border: "1px dashed #ccc", borderRadius: 14, display: "grid", placeItems: "center", color: "#999" }}>
        composer placeholder
      </div>
    </div>
  );
}
