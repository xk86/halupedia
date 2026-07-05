/**
 * Document builders — turn canonical SQLite content into `RagTextDocument`s.
 *
 * Each builder is deterministic and pure: identical input yields identical
 * documents (stable `documentId`, content-hashed). **Vibes are never built into
 * a document** — there is intentionally no vibe builder here.
 */
import { createHash } from "node:crypto";
import type { InfoboxData } from "../db";
import { slugify } from "../slug";
import { chunkMarkdown, type ChunkerOptions, DEFAULT_CHUNKER_OPTIONS } from "./chunker";
import type { RagTextDocument, TextDocumentKind } from "./types";

export function contentHash(content: string): string {
  return createHash("sha256").update(content).digest("hex").slice(0, 16);
}

function makeDoc(
  kind: TextDocumentKind,
  articleSlug: string,
  sourceId: string,
  content: string,
  sourceUpdatedAt: number,
  extra: Partial<RagTextDocument> = {},
): RagTextDocument {
  return {
    documentId: `${kind}:${sourceId}`,
    articleSlug,
    sourceKind: kind,
    sourceId,
    content,
    contentHash: contentHash(content),
    sourceUpdatedAt,
    ...extra,
  };
}

/** Strip markdown link syntax so only visible text is embedded/matched. */
function stripLinks(text: string): string {
  return text.replace(/\[([^\]]+)\]\([^)]+\)/g, "$1");
}

export interface BuildBodyArgs {
  slug: string;
  markdown: string;
  updatedAt: number;
  chunker?: ChunkerOptions;
}

export function buildBodyDocuments(args: BuildBodyArgs): RagTextDocument[] {
  const segments = chunkMarkdown(args.markdown, args.chunker ?? DEFAULT_CHUNKER_OPTIONS);
  return segments.map((seg) =>
    makeDoc("article_body", args.slug, `${args.slug}#${seg.index}`, seg.content, args.updatedAt, {
      sectionPath: seg.sectionPath,
      metadata: { tokenCount: seg.tokenCount },
    }),
  );
}

export function buildSummaryDocument(
  slug: string,
  summaryMarkdown: string,
  updatedAt: number,
): RagTextDocument | null {
  const content = (summaryMarkdown ?? "").trim();
  if (!content) return null;
  return makeDoc("article_summary", slug, slug, content, updatedAt);
}

/** Deterministic dense infobox representation (one document). */
export function buildInfoboxDigest(
  slug: string,
  title: string,
  infobox: InfoboxData,
  updatedAt: number,
): RagTextDocument | null {
  const facts: string[] = [];
  for (const group of infobox.groups ?? []) {
    for (const row of group.rows) {
      if (row.label || row.value) facts.push(`${row.label} = ${stripLinks(row.value)}`);
    }
  }
  if (facts.length === 0 && !infobox.subtitle) return null;
  const lines = [`Article: ${title}`];
  if (infobox.subtitle) lines.push(`Category: ${stripLinks(infobox.subtitle)}`);
  if (facts.length) lines.push(`Key facts: ${facts.join(". ")}.`);
  return makeDoc("infobox_digest", slug, slug, lines.join("\n"), updatedAt);
}

/** One `infobox_fact` document per row, for precise fact retrieval/citation. */
export function buildInfoboxFacts(
  slug: string,
  title: string,
  infobox: InfoboxData,
  updatedAt: number,
): RagTextDocument[] {
  const docs: RagTextDocument[] = [];
  infobox.groups?.forEach((group, gi) => {
    group.rows.forEach((row, ri) => {
      if (!row.label && !row.value) return;
      const value = stripLinks(row.value);
      const groupLabel = group.label?.trim();
      const lines = [`Article: ${title}`];
      if (groupLabel) lines.push(`Infobox group: ${groupLabel}`);
      lines.push(`Fact: ${row.label} = ${value}`);
      docs.push(
        makeDoc("infobox_fact", slug, `${slug}#${gi}.${ri}`, lines.join("\n"), updatedAt, {
          metadata: { label: row.label, value, group: groupLabel ?? "" },
        }),
      );
    });
  });
  return docs;
}

export interface LinkHintInput {
  targetSlug: string;
  targetTitle?: string;
  hint: string;
}

const STOPWORDS = new Set(["the", "a", "an", "of", "and", "or"]);

function significantWords(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .filter((w) => w && !STOPWORDS.has(w)),
  );
}

/**
 * A hint that's just the target's own name restated — "Test G: Test G",
 * "Global Test: Global Test Exchange" — explains nothing about *why* the link
 * is relevant. Detect this generically: strip the title's own words out of the
 * hint and see what's left. A real explanation draws its words from the
 * relationship, not the target's name, so it leaves several; a tautology
 * leaves at most one.
 */
function isTautologicalHint(title: string, hint: string): boolean {
  const titleWords = significantWords(title);
  const hintWords = significantWords(hint);
  if (hintWords.size === 0) return true;
  let remaining = 0;
  for (const word of hintWords) {
    if (!titleWords.has(word)) remaining += 1;
  }
  return remaining <= 1;
}

/** A `link_hint` carries a target article's summary/hint as retrievable context. */
export function buildLinkHintDocuments(
  slug: string,
  links: LinkHintInput[],
  updatedAt: number,
): RagTextDocument[] {
  const seen = new Set<string>();
  const docs: RagTextDocument[] = [];
  for (const link of links) {
    const target = slugify(link.targetSlug);
    const hint = (link.hint ?? "").trim();
    if (!target || !hint || seen.has(target)) continue;
    const title = link.targetTitle?.trim() || target;
    // A tautological hint ("basically just the title") adds no explanatory
    // value, so it's excluded entirely — it isn't retrievable, doesn't count
    // toward any quota, and can't surface as evidence.
    if (isTautologicalHint(title, hint)) continue;
    seen.add(target);
    docs.push(
      makeDoc("link_hint", slug, `${slug}->${target}`, `${title}: ${stripLinks(hint)}`, updatedAt, {
        metadata: { targetSlug: target, targetTitle: title },
      }),
    );
  }
  return docs;
}

export interface ImageTextInput {
  mediaId: string;
  caption?: string;
  description?: string;
  role?: string;
  ordinal?: number;
}

/** Index image caption (article-specific) and description (media-level) as text. */
export function buildImageTextDocuments(
  slug: string,
  images: ImageTextInput[],
  updatedAt: number,
): RagTextDocument[] {
  const docs: RagTextDocument[] = [];
  for (const img of images) {
    const meta = { mediaId: img.mediaId, role: img.role ?? "", ordinal: img.ordinal ?? 0 };
    const caption = (img.caption ?? "").trim();
    if (caption) {
      docs.push(
        makeDoc("image_caption", slug, `${slug}:${img.mediaId}`, stripLinks(caption), updatedAt, {
          metadata: meta,
        }),
      );
    }
    const description = (img.description ?? "").trim();
    if (description) {
      docs.push(
        makeDoc("image_description", slug, `${slug}:${img.mediaId}`, stripLinks(description), updatedAt, {
          metadata: meta,
        }),
      );
    }
  }
  return docs;
}
