import { markdownToHtml } from "../markdown/mdBridge";

/**
 * Live/fallback renderer for a chat message that hasn't settled yet (still
 * streaming, or ended in an error before a "done" event arrived). This is
 * intentionally NOT citation-aware — `ref:slug`/`halu:slug` markup may render
 * as a plain, non-navigating link for the brief window before the turn
 * settles. Citation resolution happens exactly once, server-side, through
 * the same deterministic link-resolution pipeline article bodies use
 * (`resolveRefLinks` / `resolveBareBracketsToRefs` / `stripSelfLinks` /
 * `renderMarkdown` — see `runChatTurn`/`renderChatAnswer` in
 * `src/server/agent/chatAgent.ts`), and the resulting HTML arrives in the
 * "done" event as `message.html` — see `ChatPanel.tsx`, which prefers that
 * over calling this function once a message has settled.
 */
export function renderChatMarkdown(markdown: string): string {
  return markdownToHtml(markdown);
}
