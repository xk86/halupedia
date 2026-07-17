/**
 * Deterministic reference collection for a chat turn. References are the
 * articles the research/orchestrator tools actually touched — collected
 * straight from their DB results via `onArticleSeen`, never re-derived by an
 * LLM. This guarantees every "Source" chip has a real slug + title (so it
 * links correctly) and reflects exactly what informed the answer.
 */
import type { SeenArticle } from "./tools/context";
import type { ResearchBriefReference } from "./researchSubagent";

/** Strip stray markdown emphasis/heading markers a title can pick up when it's
 *  sourced from rendered article output — keeps "Sources" chips (and the inline
 *  citation text built from these titles) clean plain text. */
function cleanTitle(title: string): string {
  return title
    .replace(/^#+\s*/, "")
    .replace(/[*_`]+/g, "")
    .trim();
}

/** Higher = stronger signal that the article informed the answer. A `read`
 *  article's body was pulled into context; the rest were merely surfaced. */
const VIA_RANK: Record<SeenArticle["via"], number> = {
  read: 4,
  facts: 3,
  title: 2,
  link: 1,
  search: 0,
};

/** Accumulates seen articles across every tool call in a chat turn (both the
 *  research subagent and the orchestrator's own `read_article`), deduping by
 *  slug and keeping the strongest signal per article. */
export class ReferenceCollector {
  private readonly seen = new Map<string, SeenArticle>();

  add(raw: SeenArticle): void {
    const article: SeenArticle = { ...raw, title: cleanTitle(raw.title) };
    const existing = this.seen.get(article.slug);
    if (!existing) {
      this.seen.set(article.slug, article);
      return;
    }
    // Keep the strongest `via`; fill in any score/relevance we didn't have.
    this.seen.set(article.slug, {
      slug: article.slug,
      title: existing.title || article.title,
      via: VIA_RANK[article.via] > VIA_RANK[existing.via] ? article.via : existing.via,
      score: existing.score ?? article.score,
      relevance: existing.relevance ?? article.relevance,
    });
  }

  /** Ranked references: strongest signal first, then by search score, capped.
   *  Empty when the agent touched nothing (a genuinely unsourced answer). */
  references(limit = 8): ResearchBriefReference[] {
    return [...this.seen.values()]
      .sort(
        (a, b) =>
          VIA_RANK[b.via] - VIA_RANK[a.via] ||
          (b.score ?? 0) - (a.score ?? 0) ||
          a.title.localeCompare(b.title),
      )
      .slice(0, limit)
      .map(({ slug, title, relevance }) => ({ slug, title, relevance }));
  }
}
