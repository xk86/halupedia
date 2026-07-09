import { useCallback, useRef, useState } from "react";
import type { ChatStreamEvent, ChatUiMessage, ResearchTraceEntry } from "./types";

let nextId = 0;
function newId(): string {
  nextId += 1;
  return `chat-${Date.now()}-${nextId}`;
}

function stepLabel(event: ChatStreamEvent): string | null {
  if (event.type === "research") return `Researching: ${event.query}`;
  if (event.type === "research_step") {
    const arg = Object.values(event.args)[0];
    return `${event.tool}${arg ? `: ${arg}` : ""}`;
  }
  return null;
}

/** Drives `POST /api/chat` and keeps the message thread in sync as its NDJSON
 *  events arrive. Server is stateless — every send re-transmits the full
 *  history, matching every other route in this app. */
export function useChatStream(slug?: string) {
  const [messages, setMessages] = useState<ChatUiMessage[]>([]);
  const [busy, setBusy] = useState(false);
  const messagesRef = useRef<ChatUiMessage[]>(messages);
  messagesRef.current = messages;

  const send = useCallback(
    async (text: string) => {
      const trimmed = text.trim();
      if (!trimmed || busy) return;

      const history = messagesRef.current
        .filter((m) => !m.pending && !m.errored)
        .map((m) => ({ role: m.role, content: m.content }));
      const userMessage: ChatUiMessage = { id: newId(), role: "user", content: trimmed };
      const assistantId = newId();
      const assistantMessage: ChatUiMessage = {
        id: assistantId,
        role: "assistant",
        content: "",
        steps: [],
        pending: true,
      };
      setMessages((prev) => [...prev, userMessage, assistantMessage]);
      setBusy(true);

      const updateAssistant = (patch: Partial<ChatUiMessage>) => {
        setMessages((prev) =>
          prev.map((m) => (m.id === assistantId ? { ...m, ...patch } : m)),
        );
      };

      try {
        const res = await fetch("/api/chat", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            messages: [...history, { role: "user", content: trimmed }],
            slug,
          }),
        });
        if (!res.ok || !res.body) {
          const body = await res.json().catch(() => ({}));
          throw new Error(body?.error || `chat request failed (${res.status})`);
        }

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        let content = "";
        let settled = false;
        const steps: string[] = [];
        const trace: ResearchTraceEntry[] = [];

        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() ?? "";
          for (const line of lines) {
            if (!line.trim()) continue;
            const event = JSON.parse(line) as ChatStreamEvent;
            if (event.type === "token") {
              content += event.delta;
              updateAssistant({ content });
            } else if (event.type === "research_trace") {
              trace.push(...event.entries);
              updateAssistant({ trace: [...trace] });
            } else if (event.type === "done") {
              settled = true;
              updateAssistant({ references: event.references, html: event.html, pending: false });
            } else if (event.type === "error") {
              settled = true;
              updateAssistant({
                content: content || event.message,
                pending: false,
                errored: true,
              });
            } else {
              const label = stepLabel(event);
              if (label) {
                steps.push(label);
                updateAssistant({ steps: [...steps] });
              }
            }
          }
        }

        // The connection closed without a "done"/"error" event (a dropped
        // stream, a server crash mid-response, etc). Never leave the bubble
        // stuck on "Thinking…" forever — always land on something visible.
        if (!settled) {
          updateAssistant({
            content: content || "I didn't get a complete response — please try again.",
            pending: false,
            errored: !content,
          });
        }
      } catch (err) {
        updateAssistant({
          content: err instanceof Error ? err.message : "Something went wrong.",
          pending: false,
          errored: true,
        });
      } finally {
        setBusy(false);
      }
    },
    [busy, slug],
  );

  return { messages, send, busy };
}
