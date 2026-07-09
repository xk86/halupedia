import { markdownToHtml } from "../markdown/mdBridge";
import { toWikiSegment } from "../wikiPath";
import type { ChatReference } from "./types";

// The chat agent's answers cite articles as `[Title](ref:slug)` /
// `[Title](halu:slug "hint")` — the same canonical link syntax article prose
// uses. Article generation's full link-resolution pipeline is overkill here,
// but the URL must still be a real, correctly-formatted /wiki/ path.
//
// We resolve every citation against the turn's deterministic reference list
// (slug + real title, straight from the DB): the href is built from the real
// title via `toWikiSegment` (the same helper every in-app link uses), and the
// visible text is corrected to that title too — so a model that dropped a raw
// slug in as the link text (`[extreme-testing](ref:extreme-testing)`) still
// renders "Extreme testing" pointing at `/wiki/Extreme_testing`, not a
// malformed `/wiki/extreme-testing`. Citations with no matching reference fall
// back to `toWikiSegment` of whatever text the model wrote.
const CANON_LINK_RE = /\[([^\]]+)\]\((?:ref|halu):([a-z0-9-]+)(?:\s+"[^"]*")?\)/gi;

// A bare `[slug]` / `[Title]` bracket (not followed by `(`) that names a known
// reference is a citation the model forgot to make into a link — promote it to
// a real one rather than leaving a stray bracket in the prose.
const BARE_CITATION_RE = /\[([^\]]+)\](?!\()/g;

// A citation with no brackets at all — the model wrote the article's name as
// plain prose immediately followed by a bare "(ref:slug)"/"(halu:slug)"
// marker instead of wrapping the name in `[...]`. The capture only matches
// sentence-case title shapes (one capitalized word, then lowercase/numeric
// continuation words) — our titles are always sentence case ("Advanced
// testing procedures", "Test 10"), and requiring each continuation word to
// start lowercase stops the match from reaching backward through an
// unrelated capitalized word earlier in the sentence (e.g. "See Extreme
// testing (ref:extreme-testing)" matches only "Extreme testing", not "See
// Extreme testing" — "See" fails to continue into a capital-starting word).
const BARE_PAREN_CITATION_RE =
  /([A-Z][a-z0-9']*(?:[ '-][a-z0-9][a-zA-Z0-9']*){0,6})\s?\((?:ref|halu):([a-z0-9-]+)(?:\s+"[^"]*")?\)/g;

function normalizeKey(value: string): string {
  return value
    .toLowerCase()
    .replace(/[\s_-]+/g, "-")
    .replace(/[^a-z0-9-]/g, "");
}

function buildLookup(references: readonly ChatReference[]) {
  const byKey = new Map<string, ChatReference>();
  for (const ref of references) {
    byKey.set(normalizeKey(ref.slug), ref);
    byKey.set(normalizeKey(ref.title), ref);
  }
  return byKey;
}

function linkFor(ref: ChatReference): string {
  return `[${ref.title}](/wiki/${toWikiSegment(ref.title)})`;
}

export function renderChatMarkdown(
  markdown: string,
  references: readonly ChatReference[] = [],
): string {
  const lookup = buildLookup(references);

  const withResolvedLinks = markdown.replace(
    CANON_LINK_RE,
    (_match, text: string, slug: string) => {
      const ref = lookup.get(normalizeKey(slug)) ?? lookup.get(normalizeKey(text));
      if (ref) return linkFor(ref);
      // Unknown citation — still emit a well-formed URL from the visible text.
      return `[${text}](/wiki/${toWikiSegment(text)})`;
    },
  );

  const withPromotedCitations = withResolvedLinks.replace(
    BARE_CITATION_RE,
    (match, text: string) => {
      const ref = lookup.get(normalizeKey(text));
      return ref ? linkFor(ref) : match;
    },
  );

  const withPromotedParenCitations = withPromotedCitations.replace(
    BARE_PAREN_CITATION_RE,
    (match, text: string, slug: string) => {
      const ref = lookup.get(normalizeKey(slug)) ?? lookup.get(normalizeKey(text));
      if (ref) return linkFor(ref);
      // Unknown citation — still emit a well-formed URL from the visible text.
      return `[${text.trim()}](/wiki/${toWikiSegment(text.trim())})`;
    },
  );

  return markdownToHtml(withPromotedParenCitations);
}
