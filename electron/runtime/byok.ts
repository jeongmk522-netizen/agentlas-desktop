// BYOK 직접 API 러너 — Anthropic Messages / OpenAI Chat Completions / Google Generative API.
// Node 20+ 글로벌 fetch + ReadableStream으로 SSE 파싱. 외부 SDK 의존성 없음.
//
// 보안 (PRD §6.2): API 키는 메인 프로세스만 접근. renderer로 노출 안 됨.
// Agentlas 서버 미경유 — 사용자 머신에서 vendor에 직접 호출.
import { readApiKey } from "../secrets/vault";
import type {
  Runner,
  RunnerEvents,
  RunnerRequest,
  RunnerResult,
} from "./runner";
import { wrapSystemPrompt } from "./runner";
import { tStatus } from "./status-i18n";

const DEFAULT_MODEL = {
  anthropic: "claude-sonnet-4-5",
  openai: "gpt-4o-mini",
  google: "gemini-1.5-flash",
} as const;

// ── SSE 라인 파서 (3개 API 공통) ──────────────────────────
async function* iterSseLines(
  resp: Response,
): AsyncGenerator<string, void, unknown> {
  if (!resp.body) return;
  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let nl: number;
    while ((nl = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (line) yield line;
    }
  }
  if (buffer.trim()) yield buffer.trim();
}

// ── Anthropic Messages ────────────────────────────────────
type AnthropicContent =
  | { type: "text"; text: string }
  | {
      type: "image";
      source: { type: "base64"; media_type: string; data: string };
    };

export const runAnthropicByok: Runner = async (
  req: RunnerRequest,
  events: RunnerEvents,
): Promise<RunnerResult> => {
  const key = await readApiKey("anthropic");
  if (!key) throw new Error(tStatus(req.locale, "errKeyMissingAnthropic"));

  events.onStatus(tStatus(req.locale, "callingBackend", { backend: req.backendLabel }));

  const messages: Array<{ role: "user" | "assistant"; content: string | AnthropicContent[] }> = [];
  for (const m of req.history) {
    if (m.role === "user" || m.role === "assistant") {
      messages.push({ role: m.role, content: m.text });
    }
  }

  // 마지막 user 메시지는 image가 있으면 content array
  if (req.images && req.images.length > 0) {
    const content: AnthropicContent[] = req.images.map((img) => ({
      type: "image" as const,
      source: { type: "base64" as const, media_type: img.mediaType, data: img.data },
    }));
    content.push({ type: "text", text: req.userPrompt });
    messages.push({ role: "user", content });
  } else {
    messages.push({ role: "user", content: req.userPrompt });
  }

  const resp = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": key,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: DEFAULT_MODEL.anthropic,
      max_tokens: 4096,
      stream: true,
      system: wrapSystemPrompt(req.systemPrompt, req.locale),
      messages,
    }),
  });

  if (!resp.ok) {
    const errText = await resp.text().catch(() => "");
    throw new Error(`Anthropic API ${resp.status}: ${errText.slice(0, 300)}`);
  }

  let acc = "";
  let lastEmit = 0;
  for await (const line of iterSseLines(resp)) {
    if (!line.startsWith("data:")) continue;
    const payload = line.slice(5).trim();
    if (payload === "[DONE]") break;
    try {
      const event = JSON.parse(payload) as {
        type: string;
        delta?: { type?: string; text?: string };
      };
      if (event.type === "content_block_delta" && event.delta?.text) {
        acc += event.delta.text;
        const now = Date.now();
        if (now - lastEmit > 80) {
          events.onPartial(acc);
          lastEmit = now;
        }
      }
    } catch {
      // 빈 줄 또는 ping — 무시
    }
  }
  return { text: acc.trim() };
};

// ── OpenAI Chat Completions ──────────────────────────────
type OpenAIContent =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } };

export const runOpenAIByok: Runner = async (
  req: RunnerRequest,
  events: RunnerEvents,
): Promise<RunnerResult> => {
  const key = await readApiKey("openai");
  if (!key) throw new Error(tStatus(req.locale, "errKeyMissingOpenAI"));

  events.onStatus(tStatus(req.locale, "callingBackend", { backend: req.backendLabel }));

  const messages: Array<{
    role: "system" | "user" | "assistant";
    content: string | OpenAIContent[];
  }> = [{ role: "system", content: wrapSystemPrompt(req.systemPrompt, req.locale) }];
  for (const m of req.history) {
    if (m.role === "user" || m.role === "assistant") {
      messages.push({ role: m.role, content: m.text });
    }
  }

  if (req.images && req.images.length > 0) {
    const content: OpenAIContent[] = req.images.map((img) => ({
      type: "image_url" as const,
      image_url: { url: `data:${img.mediaType};base64,${img.data}` },
    }));
    content.push({ type: "text", text: req.userPrompt });
    messages.push({ role: "user", content });
  } else {
    messages.push({ role: "user", content: req.userPrompt });
  }

  const resp = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${key}`,
    },
    body: JSON.stringify({
      model: DEFAULT_MODEL.openai,
      stream: true,
      messages,
    }),
  });

  if (!resp.ok) {
    const errText = await resp.text().catch(() => "");
    throw new Error(`OpenAI API ${resp.status}: ${errText.slice(0, 300)}`);
  }

  let acc = "";
  let lastEmit = 0;
  for await (const line of iterSseLines(resp)) {
    if (!line.startsWith("data:")) continue;
    const payload = line.slice(5).trim();
    if (payload === "[DONE]") break;
    try {
      const event = JSON.parse(payload) as {
        choices?: Array<{ delta?: { content?: string } }>;
      };
      const delta = event.choices?.[0]?.delta?.content;
      if (delta) {
        acc += delta;
        const now = Date.now();
        if (now - lastEmit > 80) {
          events.onPartial(acc);
          lastEmit = now;
        }
      }
    } catch {
      // 무시
    }
  }
  return { text: acc.trim() };
};

// ── Google Generative (Gemini) ───────────────────────────
// SSE는 :streamGenerateContent?alt=sse 엔드포인트.
export const runGoogleByok: Runner = async (
  req: RunnerRequest,
  events: RunnerEvents,
): Promise<RunnerResult> => {
  const key = await readApiKey("google");
  if (!key) throw new Error(tStatus(req.locale, "errKeyMissingGoogle"));

  events.onStatus(tStatus(req.locale, "callingBackend", { backend: req.backendLabel }));

  type GooglePart =
    | { text: string }
    | { inlineData: { mimeType: string; data: string } };
  const contents: Array<{ role: "user" | "model"; parts: GooglePart[] }> = [];
  for (const m of req.history) {
    if (m.role === "user") contents.push({ role: "user", parts: [{ text: m.text }] });
    else if (m.role === "assistant")
      contents.push({ role: "model", parts: [{ text: m.text }] });
  }
  const lastParts: GooglePart[] = [];
  if (req.images && req.images.length > 0) {
    for (const img of req.images) {
      lastParts.push({ inlineData: { mimeType: img.mediaType, data: img.data } });
    }
  }
  lastParts.push({ text: req.userPrompt });
  contents.push({ role: "user", parts: lastParts });

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${DEFAULT_MODEL.google}:streamGenerateContent?alt=sse&key=${encodeURIComponent(key)}`;

  const resp = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: wrapSystemPrompt(req.systemPrompt, req.locale) }] },
      contents,
    }),
  });

  if (!resp.ok) {
    const errText = await resp.text().catch(() => "");
    throw new Error(`Google API ${resp.status}: ${errText.slice(0, 300)}`);
  }

  let acc = "";
  let lastEmit = 0;
  for await (const line of iterSseLines(resp)) {
    if (!line.startsWith("data:")) continue;
    const payload = line.slice(5).trim();
    if (!payload) continue;
    try {
      const event = JSON.parse(payload) as {
        candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
      };
      const text = event.candidates?.[0]?.content?.parts?.[0]?.text;
      if (text) {
        acc += text;
        const now = Date.now();
        if (now - lastEmit > 80) {
          events.onPartial(acc);
          lastEmit = now;
        }
      }
    } catch {
      // 무시
    }
  }
  return { text: acc.trim() };
};
