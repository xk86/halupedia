import type { DatabaseSync } from "node:sqlite";
import type { RagRuntime } from "../../rag";

/** Shared read-only handles the retrieval/ranking tools wrap. Deliberately
 *  narrow — the chatbot flow never gets a write-capable tool. */
export interface AgentToolContext {
  db: DatabaseSync;
  rag: RagRuntime;
  /** Fired at the start of every tool call — lets the chat route surface
   *  "searching…" / "reading…" progress events without the tools knowing
   *  anything about streaming or NDJSON. */
  onToolCall?: (tool: string, args: Record<string, unknown>) => void;
}
