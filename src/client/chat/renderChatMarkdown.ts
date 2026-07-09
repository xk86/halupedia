import { markdownToHtml } from "../markdown/mdBridge";
import { toWikiSegment } from "../wikiPath";

// The chat agent's answers cite articles as `[Title](ref:slug)` /
// `[Title](halu:slug "hint")` — the same canonical link syntax article prose
// uses. Article generation's full link-resolution pipeline is overkill here,
// but the URL must still be a real, correctly-formatted /wiki/ path: we build
// it from the link's visible title via `toWikiSegment` (the same helper every
// other in-app link goes through) rather than dropping the raw slug in, which
// produced malformed URLs like `/wiki/app-test` for "App test". App.tsx's
// existing /wiki/ click interception then re-normalizes and routes it.
const CANON_LINK_RE = /\[([^\]]+)\]\((?:ref|halu):[a-z0-9-]+(?:\s+"[^"]*")?\)/gi;

export function renderChatMarkdown(markdown: string): string {
  const withResolvedLinks = markdown.replace(
    CANON_LINK_RE,
    (_match, text: string) => `[${text}](/wiki/${toWikiSegment(text)})`,
  );
  return markdownToHtml(withResolvedLinks);
}
