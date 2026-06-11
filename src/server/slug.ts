import { emojiToSlugWords } from "./text/emojiNames";
import { charSlugName } from "./text/charNames";

/**
 * The original lossy slugifier: every non-alphanumeric run collapses into a
 * single "-". Kept because every article stored before the robust slugifier
 * landed is keyed by this form — it backs the startup alias backfill and the
 * automatic legacy alias written on every save, so old links and old-style
 * model-emitted slugs keep resolving.
 */
export function legacySlugify(input: string): string {
  return emojiToSlugWords(input)
    .normalize("NFC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-")
    .slice(0, 120);
}

const ALNUM_RE = /[\p{L}\p{N}]/u;

function isAlnum(ch: string | undefined): boolean {
  return !!ch && ALNUM_RE.test(ch);
}

/**
 * Robust slug derivation: no character is silently dropped. Emoji expand to
 * their CLDR names (as before) and every other non-alphanumeric character
 * contributes a word token via charSlugName(), so "--Apples", "(Apples)" and
 * "Apples" all get distinct slugs instead of colliding on "apples".
 *
 * Compatibility invariants:
 *  - Whitespace and "_" are separators (wiki segments use "_" for spaces, and
 *    model-emitted Wiki_Case targets must keep normalizing to their slug).
 *  - A single "-" between alphanumerics is a separator, which makes every
 *    previously-issued slug a fixed point: slugify("x-men") === "x-men".
 *    Hyphens anywhere else (leading, trailing, doubled, beside punctuation)
 *    are named "dash" — that's what distinguishes "--Apples".
 *  - Output is idempotent: slugify(slugify(x)) === slugify(x), since named
 *    tokens are plain words joined by single separators.
 */
export function slugify(input: string): string {
  const expanded = emojiToSlugWords(input).normalize("NFC").toLowerCase();
  const chars = [...expanded];
  const tokens: string[] = [];
  let word = "";
  const flush = () => {
    if (word) {
      tokens.push(word);
      word = "";
    }
  };
  for (let i = 0; i < chars.length; i += 1) {
    const ch = chars[i];
    if (isAlnum(ch)) {
      word += ch;
      continue;
    }
    flush();
    if (/\s/.test(ch) || ch === "_") continue;
    if (ch === "-" && isAlnum(chars[i - 1]) && isAlnum(chars[i + 1])) continue;
    const name = charSlugName(ch);
    if (name) tokens.push(name);
  }
  flush();
  return tokens.join("-").slice(0, 120);
}

export function normalizeCanonicalTitle(title: string): string {
  const normalized = title.replace(/\s+/g, " ").trim();
  if (!normalized) return normalized;

  const firstLetterIndex = normalized.search(/\p{L}/u);
  if (firstLetterIndex < 0) return normalized;

  const firstLetter = normalized[firstLetterIndex];
  const rest = normalized.slice(firstLetterIndex + 1);
  if (firstLetter === firstLetter.toUpperCase()) return normalized;
  if (/\p{Lu}/u.test(rest)) return normalized;

  return `${normalized.slice(0, firstLetterIndex)}${firstLetter.toUpperCase()}${rest}`;
}

export function slugToTitle(slug: string): string {
  if (!slug) return "Untitled";
  const title = slug
    .split("-")
    .filter(Boolean)
    .join(" ");
  return normalizeCanonicalTitle(title);
}

// Characters allowed verbatim in a /wiki/ URL segment: letters, numbers,
// pictographic emoji, and a small safe-punctuation set. Emoji are KEPT (not
// stripped) so a title like "Chiquita 🍌" round-trips through its URL —
// dropping it produced "/wiki/Chiquita_", which slugified back to a different
// article ("chiquita"). Must stay identical to the client's toWikiSegment so
// both sides build byte-identical URLs.
const WIKI_SEGMENT_DISALLOWED = /[^\p{L}\p{N}\p{Extended_Pictographic} _'(),.-]+/gu;

export function titleToWikiSegment(title: string): string {
  let segment = normalizeCanonicalTitle(title)
    .trim()
    .replace(/\s+/g, " ")
    .replace(WIKI_SEGMENT_DISALLOWED, "")
    .replace(/ /g, "_");
  const firstLetterIndex = segment.search(/\p{L}/u);
  if (firstLetterIndex >= 0) {
    segment = segment.slice(0, firstLetterIndex) + segment[firstLetterIndex].toUpperCase() + segment.slice(firstLetterIndex + 1);
  }
  return segment;
}

export function wikiSegmentToTitle(segment: string): string {
  return segment.trim().replace(/_/g, " ").replace(/\s+/g, " ");
}

export function isSlugStyleWikiSegment(segment: string): boolean {
  const decoded = decodeURIComponent(segment).replace(/^\/+|\/+$/g, "");
  if (decoded.includes("_")) return false;
  if ((decoded.match(/-/g) ?? []).length < 2) return false;
  return slugify(wikiSegmentToTitle(decoded)) === decoded.toLowerCase();
}

export function wikiSegmentToRequestedTitle(segment: string): string {
  const decoded = decodeURIComponent(segment).replace(/^\/+|\/+$/g, "");
  if (isSlugStyleWikiSegment(decoded)) {
    return slugToTitle(slugify(decoded));
  }
  return wikiSegmentToTitle(decoded);
}
