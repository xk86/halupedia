/**
 * Prompt evidence assembly.
 *
 * Permanently separates two concepts the old pipeline conflated:
 *   - EVIDENCE CONTEXT — the actual retrieved text the model reads.
 *   - LINK ALLOWLIST   — the articles the model may `ref:`-link.
 *
 * A reference appearing in the allowlist does NOT imply its evidence text was
 * included. Selection (the retriever) decides evidence; budgeting decides what
 * fits; the allowlist is independent. Every inclusion/exclusion is recorded so
 * the admin trace can show exactly what reached the model.
 */
import { countTokens } from "./chunker";
import type { RetrievalResult, RetrievedTextDocument, TextDocumentKind } from "./types";

export interface LinkAllowlistEntry {
  slug: string;
  title: string;
}

export interface AssembledEvidence {
  /** Prose evidence: body, summary, link hints, image text. */
  articleContext: string;
  /** Infobox evidence: digest + individual facts. */
  infoboxContext: string;
  /** Compact symbolic ontology facts. */
  ontologyFacts: string;
  /** Newline bullet list of related titles (no evidence, just awareness). */
  relatedTitles: string;
  /** Articles the model may link — distinct from what evidence was included. */
  linkAllowlist: LinkAllowlistEntry[];
  /** Per-document inclusion decisions, for tracing. */
  decisions: Array<{ documentId: string; kind: TextDocumentKind; included: boolean; reason: string }>;
  tokensUsed: number;
  tokenBudget: number;
}

export interface AssembleOptions {
  maxTokens: number;
}

// Compact, high-value evidence first; prose body fills the remainder.
const KIND_PRIORITY: TextDocumentKind[] = [
  "ontology_fact",
  "article_summary",
  "infobox_digest",
  "infobox_fact",
  "link_hint",
  "image_caption",
  "image_description",
  "article_body",
];

function priority(kind: TextDocumentKind): number {
  const i = KIND_PRIORITY.indexOf(kind);
  return i < 0 ? KIND_PRIORITY.length : i;
}

function header(doc: RetrievedTextDocument): string {
  const path = doc.sectionPath?.length ? ` › ${doc.sectionPath.join(" › ")}` : "";
  return `[${doc.articleSlug}${path}]`;
}

export function assembleEvidence(
  result: RetrievalResult,
  opts: AssembleOptions,
): AssembledEvidence {
  const budget = opts.maxTokens > 0 ? opts.maxTokens : Number.MAX_SAFE_INTEGER;
  const ordered = [...result.textDocuments].sort(
    (a, b) => priority(a.sourceKind) - priority(b.sourceKind) || a.fusedRank - b.fusedRank,
  );

  const decisions: AssembledEvidence["decisions"] = [];
  const included: RetrievedTextDocument[] = [];
  let used = 0;
  for (const doc of ordered) {
    const cost = countTokens(doc.content) + 8; // + small header allowance
    if (used + cost > budget) {
      decisions.push({ documentId: doc.documentId, kind: doc.sourceKind, included: false, reason: "over_budget" });
      continue;
    }
    used += cost;
    included.push(doc);
    decisions.push({ documentId: doc.documentId, kind: doc.sourceKind, included: true, reason: doc.retrievalReason });
  }

  const render = (kinds: TextDocumentKind[]): string =>
    included
      .filter((d) => kinds.includes(d.sourceKind))
      .map((d) => `${header(d)}\n${d.content}`)
      .join("\n\n");

  const ontologyFacts = included
    .filter((d) => d.sourceKind === "ontology_fact")
    .map((d) => `- ${d.content}`)
    .join("\n");

  // Link allowlist is the full candidate set — independent of evidence inclusion.
  const linkAllowlist: LinkAllowlistEntry[] = result.sourceArticles.map((c) => ({
    slug: c.slug,
    title: c.title,
  }));

  return {
    articleContext: render(["article_body", "article_summary", "link_hint", "image_caption", "image_description"]),
    infoboxContext: render(["infobox_digest", "infobox_fact"]),
    ontologyFacts,
    relatedTitles: result.relatedTitles.map((t) => `- ${t}`).join("\n"),
    linkAllowlist,
    decisions,
    tokensUsed: used,
    tokenBudget: opts.maxTokens,
  };
}

/** Render the link allowlist as the `references_prompt_text` block (links only). */
export function renderLinkAllowlist(entries: LinkAllowlistEntry[]): string {
  return entries.map((e) => `- [${e.title}](ref:${e.slug})`).join("\n");
}
