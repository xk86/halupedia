/**
 * Builds the `ragPromptTrace` captured by render nodes — the exact RAG values
 * interpolated into the prompt, plus retrieval diagnostics. Every string here is
 * the literal value handed to `prompts.render`, so the admin trace shows exactly
 * what the model received: evidence and the link allowlist stay distinct.
 */
import type { RagPromptTrace, RetrievedContext } from "./state";

export interface BuildRagPromptTraceArgs {
  /** Prompt template key (e.g. "article", "article_rewrite", "article_refresh"). */
  promptKey: string;
  /** The exact `rag_context` value — the retrieved evidence text. */
  evidenceContext: string;
  /** The exact `references_prompt_text` value — the link allowlist. */
  linkAllowlist: string;
  /** The exact `related_titles` value. */
  relatedTitles: string;
  /** The exact `link_hints` value (incoming backlink hints). */
  linkHints?: string;
  /** The exact `article_vibe` value. */
  articleVibe?: string;
  retrievedContext?: RetrievedContext;
}

export function buildRagPromptTrace(args: BuildRagPromptTraceArgs): RagPromptTrace {
  const rc = args.retrievedContext;
  return {
    promptKey: args.promptKey,
    evidenceContext: args.evidenceContext,
    linkAllowlist: args.linkAllowlist,
    relatedTitles: args.relatedTitles,
    linkHints: args.linkHints ?? "",
    articleVibe: args.articleVibe ?? "",
    retrieval: {
      strategy: rc?.embedding?.strategy,
      model: rc?.embedding?.model,
      host: rc?.embedding?.host,
      dimensions: rc?.embedding?.dimensions,
      candidates: (rc?.sourceArticles ?? []).map((s) => ({
        slug: s.slug,
        title: s.title,
        score: s.score,
        contentChars: s.content.length,
      })),
    },
  };
}
