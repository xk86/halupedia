/**
 * Canonical, strongly-typed Article representation.
 *
 * An Article is the structured object that the server, client, and tests
 * should pass around once the legacy `ArticleRecord` shape has been retired.
 *
 * The two cardinal rules enforced by this type system:
 *
 *   1. **Metadata is a sidecar.** `references` and `seeAlso` are first-class
 *      fields on the Article — they are NOT smuggled inside `body`. Body
 *      markdown contains only the article prose (h1 title + paragraphs +
 *      inline sections); it never contains a "References" or "See also"
 *      heading. Those sections are rendered algorithmically at the moment
 *      of display by joining `body` with the sidecar.
 *
 *   2. **Identifier domains are distinct.** A `slug` is the lowercase
 *      kebab-case API id ("ford-focus"). A `WikiPath` is the URL-visible
 *      `Underscore_Title_Case` segment used by browser routing
 *      ("Ford_Focus"). A `title` is the human-facing display name with
 *      whatever unicode, italics, or punctuation the writer chose
 *      ("Ford Focus" or "the *real* Mona Lisa"). These are NEVER
 *      interchangeable; the branded `WikiPath` type catches accidental
 *      assignment between domains at compile time.
 *
 * Helpers in this file convert to/from the legacy `ArticleRecord` shape so
 * the new type can be adopted incrementally without breaking callers.
 */

import type { DatabaseSync } from "node:sqlite";
import type {
  ArticleRecord,
  ReferenceList,
  ReferenceListEntry,
} from "./types";
import { titleToWikiSegment, slugify } from "./slug";
import {
  getArticleByLookup,
  getLatestArticleReferences,
  getLatestArticleSeeAlso,
} from "./db";

/**
 * Brand a string as the URL-visible wiki segment ("Ford_Focus"). Use
 * `toWikiPath` to construct one from a title — direct assignment from a
 * raw string is rejected by the type checker.
 */
export type WikiPath = string & { readonly __brand: "WikiPath" };

/**
 * Construct a WikiPath from any display title. Idempotent for strings that
 * are already wiki segments.
 */
export function toWikiPath(title: string): WikiPath {
  return titleToWikiSegment(title) as WikiPath;
}

/**
 * A See-also entry. Structurally similar to a reference but semantically
 * distinct: see-also items frequently point at articles that DO NOT YET
 * EXIST — the article they reference is created the moment the user clicks
 * the link. References, by contrast, always point at articles already
 * present in the database.
 */
export interface SeeAlsoEntry {
  /** Kebab-case slug of the (possibly-not-yet-created) target article. */
  slug: string;
  /** Human-readable title used as the link label. */
  title: string;
  /** Short hint shown on hover; can be empty. */
  hint: string;
}

export type SeeAlsoList = SeeAlsoEntry[];

/**
 * The sidecar metadata that travels alongside an article's body markdown.
 *
 * This type exists to make "what is in the body vs what is metadata"
 * unambiguous at every API/storage boundary. Anything serialised as
 * sidecar JSON should match this shape.
 */
export interface ArticleMetadata {
  /** Algorithmic reference list — never LLM-produced. */
  references: ReferenceList;
  /** LLM-suggested related-article ideas; may or may not exist yet. */
  seeAlso: SeeAlsoList;
}

/**
 * The canonical Article.
 *
 * `body` is markdown WITHOUT any References or See also sections — those
 * live in the sidecar. Renderers append metadata sections at display time
 * via the algorithmic helpers in `referenceList.ts`.
 */
export interface Article {
  /** Lowercase kebab-case API id. */
  slug: string;
  /** Canonical slug (after disambiguation/aliasing). Usually equals slug. */
  canonicalSlug: string;
  /** Display title — unicode, formatting, punctuation all permitted. */
  title: string;
  /** Optional override title shown when title needs different presentation. */
  displayTitle?: string;
  /** URL-visible wiki segment derived from the title. */
  path: WikiPath;
  /** Body markdown ONLY — must not contain References or See also sections. */
  body: string;
  /** Article summary in markdown. */
  summary: string;
  /** Plain-text projection of `body` for search/snippets. */
  plainText: string;
  /** Last save timestamp (ms since epoch). */
  generatedAt: number;
  /** True if this slug routes to a disambiguation page. */
  isDisambiguation?: boolean;
  /** Sidecar metadata — references + see-also. */
  metadata: ArticleMetadata;
}

/**
 * Type guard: assert that an article body does NOT contain metadata
 * sections (References / See also). Throws a descriptive error if it does
 * so the bug is caught at the boundary instead of corrupting the article.
 *
 * Call this when accepting body markdown from any LLM-touching path.
 */
export function assertBodyHasNoMetadata(
  body: string,
  context: { slug?: string } = {},
): void {
  if (/^##\s+(references|see also)\s*$/im.test(body)) {
    const where = context.slug ? ` (slug=${context.slug})` : "";
    throw new Error(
      `Article body${where} contains a References or See also section. ` +
        `Metadata must live in the sidecar (Article.metadata), not the body. ` +
        `Strip these sections before passing body markdown through this path.`,
    );
  }
}

/**
 * Wrap a legacy `ArticleRecord` (which may have References/See also baked
 * into `markdown`) as a strongly-typed `Article` with metadata extracted.
 *
 * `references` and `seeAlso` are provided by the caller because they are
 * stored in separate tables — this function does no DB access.
 */
export function articleRecordToArticle(
  record: ArticleRecord,
  metadata: ArticleMetadata,
): Article {
  const body = stripBodyMetadataSections(record.markdown);
  // The articles table COALESCEs empty display_title back to title at read
  // time. Treat "displayTitle === title" as "no override" so the API shape
  // matches what callers wrote (undefined when no custom display title).
  const displayTitle =
    record.displayTitle && record.displayTitle !== record.title
      ? record.displayTitle
      : undefined;
  return {
    slug: record.slug,
    canonicalSlug: record.canonicalSlug,
    title: record.title,
    displayTitle,
    path: toWikiPath(record.title),
    body,
    summary: record.summaryMarkdown ?? "",
    plainText: record.plain_text,
    generatedAt: record.generated_at,
    isDisambiguation: record.isDisambiguation,
    metadata,
  };
}

/**
 * Strip top-level References / See also sections from a markdown string.
 * Internal helper; exported so the conversion layer can be tested.
 */
export function stripBodyMetadataSections(markdown: string): string {
  const lines = markdown.split("\n");
  const kept: string[] = [];
  let skipping = false;
  for (const line of lines) {
    const heading = line.match(/^##\s+(.+?)\s*$/);
    if (heading) {
      const label = heading[1].replace(/\s+/g, " ").trim().toLowerCase();
      if (label === "references" || label === "see also") {
        skipping = true;
        continue;
      }
      skipping = false;
    }
    if (!skipping) kept.push(line);
  }
  return kept.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

/**
 * Project an Article back into a serialisable plain object suitable for
 * JSON responses. The shape is deliberately flat for clients but the
 * sidecar `metadata` field is preserved as an object so the boundary
 * between body and metadata is obvious in the wire format.
 */
// Wire shape. `body` is metadata-free markdown; `html` is the server-rendered
// combined view (body + algorithmic References + algorithmic See also) and is
// what the client displays directly. `metadata.*` is the structured sidecar
// the editor consumes (refs list with pin toggle, etc.). Clients MUST NOT
// parse references back out of `body` or `html`.
export interface ReferenceResponseEntry {
  slug: string;
  title: string;
  kind: ReferenceListEntry["kind"];
  pinned: boolean;
}

export interface ArticleResponse {
  slug: string;
  canonicalSlug: string;
  title: string;
  displayTitle?: string;
  path: string;
  body: string;
  html: string;
  summary: string;
  plainText: string;
  generatedAt: number;
  isDisambiguation?: boolean;
  metadata: {
    references: ReferenceResponseEntry[];
    seeAlso: SeeAlsoList;
  };
  // Legacy field aliases. Retained so existing clients/tests continue to
  // work during the migration to the typed Article shape. New code MUST
  // use `body`/`summary`/`plainText`/`generatedAt`/`metadata.*` — these
  // duplicates will be removed once all readers have migrated.
  /** @deprecated use `body` + `metadata.references` + `metadata.seeAlso` */
  markdown: string;
  /** @deprecated use `summary` */
  summaryMarkdown?: string;
  /** @deprecated use `plainText` */
  plain_text: string;
  /** @deprecated use `generatedAt` */
  generated_at: number;
}

// Caller supplies pre-rendered HTML and the legacy full-markdown form
// (body + metadata sections) so deprecated aliases can ship alongside the
// typed fields without leaking the renderer into this module.
export function articleToResponse(
  article: Article,
  html: string,
  legacyMarkdown: string,
): ArticleResponse {
  return {
    slug: article.slug,
    canonicalSlug: article.canonicalSlug,
    title: article.title,
    displayTitle: article.displayTitle,
    path: article.path as string,
    body: article.body,
    html,
    summary: article.summary,
    plainText: article.plainText,
    generatedAt: article.generatedAt,
    isDisambiguation: article.isDisambiguation,
    metadata: {
      references: article.metadata.references.map((r) => ({
        slug: r.slug,
        title: r.title,
        kind: r.kind,
        pinned: r.pinned,
      })),
      seeAlso: article.metadata.seeAlso,
    },
    markdown: legacyMarkdown,
    summaryMarkdown: article.summary,
    plain_text: article.plainText,
    generated_at: article.generatedAt,
  };
}

/**
 * Verify slug shape at a boundary — slugs MUST be kebab-case and survive
 * round-tripping through `slugify`. Throws on a malformed slug so problems
 * surface at the call site rather than as silent 404s later.
 */
export function assertValidSlug(slug: string): void {
  const normalized = slugify(slug);
  if (!normalized || normalized !== slug) {
    throw new Error(
      `Invalid slug ${JSON.stringify(slug)}: expected kebab-case ` +
        `(would normalise to ${JSON.stringify(normalized)}).`,
    );
  }
}

/**
 * Load an Article by slug from the database, hydrating the sidecar
 * metadata (references and see-also) from their dedicated tables.
 *
 * Returns `null` if the article does not exist. This is the canonical way
 * to read an article in new code; legacy paths that need `ArticleRecord`
 * can keep calling `getArticleByLookup` directly while migration proceeds.
 */
export function loadArticle(
  db: DatabaseSync,
  slug: string,
): Article | null {
  const record = getArticleByLookup(db, slug);
  if (!record) return null;
  const references: ReferenceList = getLatestArticleReferences(db, record.slug);
  const seeAlsoRows = getLatestArticleSeeAlso(db, record.slug);
  const seeAlso: SeeAlsoList = seeAlsoRows.map((row) => ({
    slug: row.slug,
    title: row.title,
    hint: row.hint,
  }));
  return articleRecordToArticle(record, { references, seeAlso });
}
