export interface ChatReference {
  slug: string;
  title: string;
  relevance?: string;
}

export type ChatStreamEvent =
  | { type: "research"; query: string }
  | { type: "research_step"; tool: string; args: Record<string, unknown> }
  | { type: "token"; delta: string }
  | { type: "done"; references: ChatReference[] }
  | { type: "error"; message: string };

export interface ChatUiMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  /** Progress steps shown while an assistant reply is still streaming. */
  steps?: string[];
  references?: ChatReference[];
  pending?: boolean;
  errored?: boolean;
}
