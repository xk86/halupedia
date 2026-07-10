/**
 * Typed evidence context — the canonical shape for a retrieval result once
 * grouped per article.
 *
 * A `RetrievalResult` is a flat list of scored text documents. Prompts and
 * the reference list both need that grouped *by admitted article*, with
 * summary, ontology facts, and body/link excerpts kept as distinct typed
 * fields rather than concatenated into one undifferentiated blob — so a
 * consumer that only wants facts (or only wants the summary) doesn't have to
 * re-parse a joined string to get it.
 *
 * `renderArticleEvidenceText` / `toPromptSourceArticles` are serializers:
 * they turn the typed context into the flat `{slug,title,content,score}[]`
 * shape existing prompt assembly (`formatRagContextForPrompt`,
 * `buildReferenceList`) already consumes. The structured `EvidenceContext`
 * stays canonical; the rendered text is just one projection of it.
 */
import type {
  RetrievalResult,
  RetrievalDiagnostics,
  TextDocumentKind,
} from "./types";
import { evidenceSubject } from "./retriever";

export interface RetrievedExcerpt {
  kind: TextDocumentKind;
  content: string;
}

export interface RankedOntologyFact {
  content: string;
  score: number;
}

export interface RetrievedArticleEvidence {
  slug: string;
  title: string;
  /** Best score among the article's contributing documents. */
  score: number;
  provenance: "semantic" | "direct" | "symbolic";
  /** One-line summary excerpt, independent of whatever documents were
   *  selected as evidence — see `summaryFor` in `./retriever`. */
  summary?: string;
  /** Body/summary/infobox/image/link-hint text, kept separate per document. */
  excerpts: RetrievedExcerpt[];
  /** Ranked ontology facts, already capped per `ontology_facts_per_retrieved_article`. */
  ontologyFacts: RankedOntologyFact[];
  /** Link-hint text specifically (also folded into `excerpts` for rendering —
   *  kept distinct here so a typed consumer can single them out). */
  linkHints: RetrievedExcerpt[];
}

export interface EvidenceContext {
  articles: RetrievedArticleEvidence[];
  relatedTitles: string[];
  diagnostics: RetrievalDiagnostics;
}

/** Group a flat retrieval result into per-article typed evidence. */
export function buildEvidenceContext(result: RetrievalResult): EvidenceContext {
  const excerptsBySlug = new Map<string, RetrievedExcerpt[]>();
  const ontologyBySlug = new Map<string, RankedOntologyFact[]>();
  const linkHintsBySlug = new Map<string, RetrievedExcerpt[]>();
  const seenContentBySlug = new Map<string, Set<string>>();

  for (const doc of result.textDocuments) {
    const subject = evidenceSubject(doc);
    const seen = seenContentBySlug.get(subject.slug) ?? new Set<string>();
    if (seen.has(doc.content)) continue;
    seen.add(doc.content);
    seenContentBySlug.set(subject.slug, seen);

    if (doc.sourceKind === "ontology_fact") {
      const list = ontologyBySlug.get(subject.slug) ?? [];
      list.push({ content: doc.content, score: doc.rawScore });
      ontologyBySlug.set(subject.slug, list);
    } else if (doc.sourceKind === "link_hint") {
      const list = linkHintsBySlug.get(subject.slug) ?? [];
      list.push({ kind: doc.sourceKind, content: doc.content });
      linkHintsBySlug.set(subject.slug, list);
    } else {
      const list = excerptsBySlug.get(subject.slug) ?? [];
      list.push({ kind: doc.sourceKind, content: doc.content });
      excerptsBySlug.set(subject.slug, list);
    }
  }

  const articles: RetrievedArticleEvidence[] = result.sourceArticles.map((c) => ({
    slug: c.slug,
    title: c.title,
    score: c.score,
    provenance: c.provenance,
    summary: c.summary,
    excerpts: excerptsBySlug.get(c.slug) ?? [],
    ontologyFacts: ontologyBySlug.get(c.slug) ?? [],
    linkHints: linkHintsBySlug.get(c.slug) ?? [],
  }));

  return {
    articles,
    relatedTitles: result.relatedTitles,
    diagnostics: result.diagnostics,
  };
}

/**
 * Render one article's evidence as labeled sections (summary, then ranked
 * facts, then supporting excerpts) instead of an undifferentiated join.
 * Sections with no data are omitted entirely; an article with no summary, no
 * facts, and no excerpts renders as "" so stub-content filtering downstream
 * (`chunkHasUsefulContent`) still drops it.
 */
export function renderArticleEvidenceText(article: RetrievedArticleEvidence): string {
  const sections: string[] = [];
  if (article.summary?.trim()) {
    sections.push(`SUMMARY:\n${article.summary.trim()}`);
  }
  if (article.ontologyFacts.length > 0) {
    const facts = article.ontologyFacts.map((f) => `- ${f.content}`).join("\n");
    sections.push(`RELEVANT FACTS:\n${facts}`);
  }
  // Link-hint text is evidence about this article discovered via another
  // article's link, not a distinct prompt section — fold it in with the
  // other excerpts so it isn't silently dropped from the rendered text.
  const excerptText = [...article.excerpts, ...article.linkHints].map((e) => e.content).join("\n\n");
  if (excerptText) {
    sections.push(`SUPPORTING EXCERPTS:\n${excerptText}`);
  }
  return sections.join("\n\n");
}

/**
 * Flatten an `EvidenceContext` into the `{slug,title,content,score,summary}[]`
 * shape existing prompt assembly consumes (`formatRagContextForPrompt`,
 * `buildReferenceList`). `content` is the labeled rendering above, not a raw
 * document join.
 */
export function toPromptSourceArticles(evidence: EvidenceContext): Array<{
  slug: string;
  title: string;
  content: string;
  score?: number;
  summary?: string;
}> {
  return evidence.articles.map((a) => ({
    slug: a.slug,
    title: a.title,
    content: renderArticleEvidenceText(a),
    score: a.score,
    ...(a.summary ? { summary: a.summary } : {}),
  }));
}

/** Embedding/retrieval diagnostics in the shape prompt-trace/state consumers expect. */
export function evidenceEmbeddingDiagnostics(evidence: EvidenceContext): {
  strategy: string;
  model?: string;
  host?: string;
  dimensions?: number;
  corpusChunks?: number;
} {
  const diag = evidence.diagnostics;
  return {
    strategy: diag.degraded ? "lexical_fallback" : "embeddings",
    model: diag.textEmbeddingModel,
    host: diag.servingHost,
    dimensions: diag.vectorDimensions,
    corpusChunks: diag.candidateTextCount,
  };
}
