import { markdownToHtml } from "../markdown/mdBridge";

// The chat agent's answers use the same `ref:slug` / `halu:slug "hint"` link
// syntax article prose does, but article generation's full link-resolution
// pipeline (src/server/*, resolveLinks) is overkill for a short chat answer —
// this just rewrites them to real in-app paths so `App.tsx`'s existing
// `/wiki/...` click interception picks them up.
const CANON_LINK_RE = /\]\((ref|halu):([a-z0-9-]+)(?:\s+"[^"]*")?\)/gi;

export function renderChatMarkdown(markdown: string): string {
  const withResolvedLinks = markdown.replace(
    CANON_LINK_RE,
    (_match, _kind: string, slug: string) => `](/wiki/${slug})`,
  );
  return markdownToHtml(withResolvedLinks);
}
