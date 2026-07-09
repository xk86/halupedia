export interface ChatReference {
  slug: string;
  title: string;
  relevance?: string;
}

/** One deterministic step of the research subagent's reasoning, mirrored from
 *  the server's `ResearchTraceEntry`. Powers the expandable "reasoning" panel. */
export interface ResearchTraceEntry {
  thought?: string;
  tool?: string;
  args?: Record<string, unknown>;
  result?: string;
}

export type ChatStreamEvent =
  | { type: "research"; query: string }
  | { type: "research_step"; tool: string; args: Record<string, unknown> }
  | { type: "research_trace"; query: string; entries: ResearchTraceEntry[] }
  | { type: "token"; delta: string }
  | { type: "done"; references: ChatReference[]; html: string }
  | { type: "error"; message: string };

export interface ChatUiMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  /** Final answer HTML with citations already resolved to real /wiki/ links —
   *  rendered server-side (see `runChatTurn`/`renderChatAnswer`) through the
   *  same link-resolution pipeline article bodies use. Set once the turn
   *  settles; the client never re-parses chat markdown itself. */
  html?: string;
  /** Lightweight live activity shown while the reply is still streaming. */
  steps?: string[];
  /** The full structured reasoning trace, delivered once research completes. */
  trace?: ResearchTraceEntry[];
  references?: ChatReference[];
  pending?: boolean;
  errored?: boolean;
}
