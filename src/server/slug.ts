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

// A string that is already a valid slug: lowercase letters/numbers in tokens
// joined by single hyphens. (The lowercase check is separate because \p{L}
// must still admit caseless scripts — "signal-units-lparen-信号体-rparen" is a
// valid slug.)
const SLUG_FORM_RE = /^[\p{L}\p{N}]+(?:-[\p{L}\p{N}]+)*$/u;

export function isSlugForm(input: string): boolean {
  return input === input.toLowerCase() && SLUG_FORM_RE.test(input);
}

/**
 * Normalize a string that is supposed to BE a slug already (halu:/ref: link
 * targets, model-emitted kebab identifiers). Valid slugs pass through
 * unchanged; malformed ones (caps, stray words, punctuation) get the legacy
 * collapse — every article save aliases its legacy slug, so the collapsed
 * form always resolves through the alias table. Crucially this never names
 * hyphens: "Example-Topic" here means the slug "example-topic", not the
 * hyphenated title "Example-Topic".
 */
export function normalizeSlug(input: string): string {
  const direct = input.normalize("NFC").trim().toLowerCase();
  if (isSlugForm(direct)) return direct.slice(0, 120);
  return legacySlugify(direct);
}

/**
 * Robust slug derivation: no character is silently dropped. Emoji expand to
 * their CLDR names (as before) and every other non-alphanumeric character
 * contributes a word token via charSlugName(), so "--Apples", "(Apples)" and
 * "Apples" all get distinct slugs instead of colliding on "apples".
 *
 * Invariants:
 *  - Already-valid slugs are returned unchanged (idempotency is structural:
 *    title-mode output is always lowercase tokens joined by single hyphens,
 *    i.e. slug-form, so every output is a fixed point). This also keeps
 *    model-emitted kebab targets like halu:foo-bar stable.
 *  - In title-mode, whitespace and "_" are separators (wiki segments use "_"
 *    for spaces, and Wiki_Case targets must keep normalizing to their slug).
 *  - In title-mode, EVERY hyphen is named "dash": the title "Foo-bar" slugs
 *    to "foo-dash-bar" and stays distinct from "Foo bar" → "foo-bar".
 *    Titles reach slugify in canonical (capitalized) form, so they never
 *    take the slug-form fast path.
 */
export function slugify(input: string): string {
  const direct = input.normalize("NFC").trim();
  if (isSlugForm(direct)) return direct.slice(0, 120);

  const expanded = emojiToSlugWords(direct).toLowerCase();
  const chars = [...expanded];
  const tokens: string[] = [];
  let word = "";
  const flush = () => {
    if (word) {
      tokens.push(word);
      word = "";
    }
  };
  for (const ch of chars) {
    if (isAlnum(ch)) {
      word += ch;
      continue;
    }
    flush();
    if (/\s/.test(ch) || ch === "_") continue;
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
  if (!decoded.includes("-")) return false;
  // A lowercase slug-form segment is a slug reference (/wiki/foo-bar means
  // the slug "foo-bar"); hyphenated TITLES arrive capitalized ("Foo-bar")
  // via titleToWikiSegment and fall through to title handling, which is what
  // keeps "Foo-bar" (→ foo-dash-bar) distinct from "Foo bar" (→ foo-bar).
  if (isSlugForm(decoded)) return true;
  return slugify(wikiSegmentToTitle(decoded)) === decoded.toLowerCase();
}

export function wikiSegmentToRequestedTitle(segment: string): string {
  const decoded = decodeURIComponent(segment).replace(/^\/+|\/+$/g, "");
  if (isSlugStyleWikiSegment(decoded)) {
    return slugToTitle(slugify(decoded));
  }
  return wikiSegmentToTitle(decoded);
}
