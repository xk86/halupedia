import type { ResearchBriefReference } from "./researchSubagent";

export interface ChatMessageInput {
  role: "user" | "assistant";
  content: string;
}

/** NDJSON events streamed to the client from `POST /api/chat`. */
export type ChatStreamEvent =
  | { type: "research"; query: string }
  | { type: "research_step"; tool: string; args: Record<string, unknown> }
  | { type: "token"; delta: string }
  | { type: "done"; references: ResearchBriefReference[] }
  | { type: "error"; message: string };
