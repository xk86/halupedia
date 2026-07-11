import type { Hono } from "hono";
import type { DatabaseSync } from "node:sqlite";
import type { LlmRouter } from "../llm";
import type { Logger } from "../logger";
import { renderOntologyValueHtml } from "../markdown";
import type { PromptConfig } from "../types";
import { slugify } from "../slug";
import { parseMarkdownLinks } from "../text/markdownLinkParser";
import { getVocabularyReviewStats, listPendingOntologySuggestionsByArticle, runOntologyVocabularyReview } from "../ontology";
import { makeVersionedCache } from "../responseCache";
import type { RagRuntime } from "./runtime";
import type { RetrievalProfile } from "./types";

const PROFILES = new Set<RetrievalProfile>([
  "article_generation",
  "article_rewrite",
  "article_refresh",
  "reference_search",
]);

interface RagQueryBody {
  query?: unknown;
  profile?: unknown;
  targetSlug?: unknown;
}

export interface OntologyReviewDeps {
  db: DatabaseSync;
  getLlm: () => LlmRouter;
  getPrompts: () => PromptConfig;
  logger?: Logger;
}

/** Read-only RAG workbench endpoint. It retrieves and assembles evidence only. */
export function registerRagAdminRoutes(
  app: Hono,
  getRag: () => RagRuntime,
  getMinScore: () => number,
  ontology?: OntologyReviewDeps,
): void {
  const ontologySuggestionsCache = ontology ? makeVersionedCache(ontology.db) : null;

  app.post("/api/admin/rag/query", async (c) => {
    let body: RagQueryBody;
    try {
      body = (await c.req.json()) as RagQueryBody;
    } catch {
      return c.json({ error: "invalid JSON body" }, 400);
    }

    const query = typeof body.query === "string" ? body.query.trim() : "";
    if (!query) return c.json({ error: "query is required" }, 400);
    if (query.length > 50_000) {
      return c.json({ error: "query exceeds 50000 characters" }, 400);
    }

    const profile = body.profile ?? "article_generation";
    if (typeof profile !== "string" || !PROFILES.has(profile as RetrievalProfile)) {
      return c.json({ error: "invalid retrieval profile" }, 400);
    }

    const requestedTarget =
      typeof body.targetSlug === "string" ? slugify(body.targetSlug) : "";
    const targetSlug = requestedTarget || "admin-rag-query";
    const directSlugs = [
      ...new Set(
        parseMarkdownLinks(query).links
          .filter((link) => link.kind === "ref" || link.kind === "halu")
          .map((link) => slugify(link.slug ?? ""))
          .filter((slug) => slug && slug !== targetSlug),
      ),
    ];
    const minScore = getMinScore();

    const rag = getRag();
    const retrieval = await rag.retrieve({
      targetSlug,
      queryText: query,
      directSlugs,
      minScore,
      profile: profile as RetrievalProfile,
    });
    const evidence = rag.assemble(retrieval, profile as RetrievalProfile);

    return c.json({
      request: {
        query,
        profile,
        targetSlug,
        directSlugs,
        minScore,
      },
      retrieval,
      evidence,
    });
  });

  // GET /api/admin/ontology/stats — corpus evidence for the vocabulary review
  // tool: per-predicate usage counts and infobox labels that never mapped to a
  // predicate. Cheap, deterministic, no model call — safe to fetch on pane load.
  app.get("/api/admin/ontology/stats", (c) => {
    if (!ontology) return c.json({ error: "ontology admin unavailable" }, 503);
    return c.json(getVocabularyReviewStats(ontology.db, getRag().vocab));
  });

  // GET /api/admin/ontology/suggestions — read-only corpus view of generated
  // ontology suggestions that are still waiting for per-article review.
  app.get("/api/admin/ontology/suggestions", (c) => {
    if (!ontology) return c.json({ error: "ontology admin unavailable" }, 503);
    const cached = ontologySuggestionsCache!.get("admin:ontology:suggestions", () => {
      const vocab = getRag().vocab;
      const articles = listPendingOntologySuggestionsByArticle(ontology.db).map((article) => ({
        slug: article.slug,
        title: article.title,
        suggestionCount: article.suggestions.length,
        suggestions: article.suggestions.map((suggestion) => ({
          ...suggestion,
          label: vocab.predicates.get(suggestion.predicate)?.label ?? suggestion.predicate.replace(/_/g, " "),
          objectHtml: renderOntologyValueHtml(suggestion.object),
        })),
      }));
      return JSON.stringify({
        articleCount: articles.length,
        suggestionCount: articles.reduce((total, article) => total + article.suggestionCount, 0),
        articles,
      });
    });
    if (c.req.header("if-none-match") === cached.etag) {
      return c.body(null, 304, { etag: cached.etag, "cache-control": "no-cache" });
    }
    return c.body(cached.body, 200, {
      "content-type": "application/json",
      etag: cached.etag,
      "cache-control": "no-cache",
    });
  });

  // POST /api/admin/ontology/review — LLM-assisted pass over the same evidence,
  // proposing predicates to add (closing gaps) or remove (dead weight). Returns
  // validated proposals only; nothing is written until /apply is called.
  app.post("/api/admin/ontology/review", async (c) => {
    if (!ontology) return c.json({ error: "ontology admin unavailable" }, 503);
    try {
      const { stats, proposals } = await runOntologyVocabularyReview(ontology.db, getRag().vocab, {
        llm: ontology.getLlm(),
        prompts: ontology.getPrompts(),
        logger: ontology.logger,
      });
      return c.json({ stats, proposals });
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : "vocabulary review failed" }, 502);
    }
  });
}
