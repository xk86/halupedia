import type { Hono } from "hono";
import { slugify } from "../slug";
import { parseMarkdownLinks } from "../text/markdownLinkParser";
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

/** Read-only RAG workbench endpoint. It retrieves and assembles evidence only. */
export function registerRagAdminRoutes(
  app: Hono,
  getRag: () => RagRuntime,
  getMinScore: () => number,
): void {
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
}
