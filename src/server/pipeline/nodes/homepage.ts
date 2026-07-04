/**
 * Nodes for homepage.refresh.
 */

import { defineNode } from "../runtime/nodeFactory";
import type { PipelineDeps } from "../deps";
import {
  getHomepageCache,
  getRandomArticles,
  saveHomepageCache,
} from "../../db";
import { firstParagraphMarkdownFromArticle } from "../../markdown";
import {
  ensureDykHasSourceLink,
  generateDidYouKnowFact,
} from "../../dyk";
import { ensureTodaysNewsArticle, isCurrentHomepageNews } from "../../todaysNews";

export const refreshHomepageCacheNode = defineNode({
  name: "write.refresh_homepage_cache",
  kind: "write",
  description:
    "Refresh the DB-backed homepage cache and generate DYK facts when stale.",
  reads: ["input"] as const,
  writes: ["homepagePayload", "persistedAt"] as const,
  async run(_inputs, deps: PipelineDeps) {
    const ttlMs = deps.runtime.app.homepage.rotation_hours * 60 * 60 * 1000;
    const now = Date.now();
    const cached = getHomepageCache(deps.db);
    if (
      cached
      && cached.generatedAt + ttlMs > now
      && isCurrentHomepageNews(cached.todaysNews, deps.runtime.app)
    ) {
      return {
        homepagePayload: {
          ...cached,
          expiresAt: cached.generatedAt + ttlMs,
        },
        persistedAt: cached.generatedAt,
      };
    }

    const sources = getRandomArticles(deps.db, 5);
    const generatedAt = Date.now();
    if (sources.length === 0) {
      const empty = {
        featured: null,
        todaysNews: null,
        didYouKnow: [],
        generatedAt,
        expiresAt: generatedAt + ttlMs,
      };
      saveHomepageCache(deps.db, empty);
      return { homepagePayload: empty, persistedAt: generatedAt };
    }

    let todaysNews = null;
    try {
      todaysNews = await ensureTodaysNewsArticle(deps.db, deps.llm, deps.rag, deps.runtime, deps.logger);
    } catch (error) {
      deps.logger.warn("homepage.todays_news_generation_failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    }

    const didYouKnow = [];
    for (const article of sources) {
      try {
        const fact = await generateDidYouKnowFact(
          deps.llm,
          deps.runtime.prompts,
          article,
        );
        if (fact) {
          const linkedFact = ensureDykHasSourceLink(
            fact,
            article.slug,
            article.title,
          );
          didYouKnow.push({
            slug: article.slug,
            title: article.title,
            fact: linkedFact,
          });
        }
      } catch (error) {
        deps.logger.warn("homepage.dyk_generation_failed", {
          slug: article.slug,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    const featured = sources[0]
      ? {
          slug: sources[0].slug,
          title: sources[0].title,
          summaryMarkdown: firstParagraphMarkdownFromArticle(sources[0].markdown),
        }
      : null;
    const payload = {
      featured,
      todaysNews,
      didYouKnow,
      generatedAt,
      expiresAt: generatedAt + ttlMs,
    };
    saveHomepageCache(deps.db, payload);
    deps.logger.info("homepage.cache_prepared", {
      facts: didYouKnow.length,
      featured: featured?.slug ?? "",
    });
    return { homepagePayload: payload, persistedAt: generatedAt };
  },
});
