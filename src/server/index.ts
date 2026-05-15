import { readFile } from "node:fs/promises";
import { extname, resolve } from "node:path";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import { loadConfig } from "./config";
import { getAdminOverview, getArticleByLookup, getCanonicalSlugForTarget, listArticles, listBacklinks, listIncomingHints, openDatabase, saveArticle, searchCorpus } from "./db";
import { OpenAICompatClient } from "./llm";
import { logSection } from "./logger";
import { extractInternalLinks, extractTitle, markdownToPlainText, normalizeMarkdown, renderMarkdown } from "./markdown";
import { getPrompt, renderTemplate } from "./prompts";
import { indexArticleChunks, retrieveContext } from "./retrieval";
import { slugToTitle, slugify, titleToWikiSegment } from "./slug";

const RESERVED_PATHS = new Set(["", "search", "all-entries", "admin", "api", "assets"]);
const MIN_INTERNAL_LINKS = 5;

function routeSlug(pathname: string) {
  if (pathname.startsWith("/wiki/")) {
    return slugify(decodeURIComponent(pathname.slice("/wiki/".length)));
  }
  const trimmed = pathname.replace(/^\/+|\/+$/g, "");
  if (!trimmed || RESERVED_PATHS.has(trimmed) || trimmed.includes("/")) return null;
  if (trimmed.includes(".")) return null;
  return slugify(decodeURIComponent(trimmed));
}

function hasSufficientLinks(markdown: string): boolean {
  return extractInternalLinks(markdown).length >= MIN_INTERNAL_LINKS;
}

function titleMatchesRequested(title: string, requestedTitle: string, requestedSlug: string): boolean {
  return slugify(title) === requestedSlug && titleToWikiSegment(title) === titleToWikiSegment(requestedTitle);
}

async function createApp() {
  let runtime = loadConfig();
  const db = openDatabase(runtime.app.storage.database_path);
  let llm = new OpenAICompatClient(runtime.llm.chat, runtime.llm.embeddings);
  const app = new Hono();
  const distRoot = resolve(process.cwd(), "dist");

  async function reloadRuntime() {
    runtime = loadConfig();
    llm = new OpenAICompatClient(runtime.llm.chat, runtime.llm.embeddings);
    logSection("startup", [
      `server=http://${runtime.app.server.host}:${runtime.app.server.port}`,
      `database=${runtime.app.storage.database_path}`,
      `chat_base_url=${runtime.llm.chat.base_url}`,
      `chat_model=${runtime.llm.chat.model}`,
      `embeddings_enabled=${String(runtime.llm.embeddings.enabled)}`,
      `embeddings_base_url=${runtime.llm.embeddings.base_url}`,
      `embeddings_model=${runtime.llm.embeddings.model}`,
      `rag_enabled=${String(runtime.app.rag.enabled)}`,
    ]);
    await llm.probeConnections();
  }

  await reloadRuntime();

  function canonicalPathForArticle(article: { canonicalSlug: string; title: string }) {
    return `/wiki/${titleToWikiSegment(article.title || slugToTitle(article.canonicalSlug))}`;
  }

  function rewriteArticleHtml(articleHtml: string, links: Array<{ targetSlug: string }>) {
    let html = articleHtml;
    for (const link of links) {
      const targetCanonical = getCanonicalSlugForTarget(db, link.targetSlug);
      const currentPath = `/wiki/${titleToWikiSegment(slugToTitle(link.targetSlug))}`;
      const preferredPath = `/wiki/${titleToWikiSegment(slugToTitle(targetCanonical))}`;
      html = html.replaceAll(`href="${currentPath}"`, `href="${preferredPath}"`);
    }
    return html;
  }

  async function buildArticle(slug: string, onProgress?: (html: string) => void) {
    console.log(`[page] generation_start slug=${slug}`);
    const hints = listIncomingHints(db, slug);
    const ragContext = await retrieveContext(
      db,
      llm,
      slug,
      hints,
      runtime.app.rag.enabled,
      runtime.app.rag.max_results,
      runtime.llm.embeddings.enabled
    );

    const prompt = getPrompt(runtime.prompts, "article");
    const requestedTitle = slugToTitle(slug);
    const renderedUserPrompt = renderTemplate(prompt.user, {
      slug,
      requested_title: requestedTitle,
      link_hints: hints.length ? hints.map((hint) => `- ${hint}`).join("\n") : "(none yet)",
      rag_context: ragContext || "(none)",
      article_excerpt: "",
      parent_comment: "",
    });

    let markdown = "";
    let resolvedTitle = requestedTitle;
    for (let attempt = 1; attempt <= 3; attempt++) {
      const repairNote =
        attempt === 1
          ? ""
          : `\n\nOutput contract repair:\n- The previous draft violated the output contract.\n- Regenerate the full article.\n- The H1 must be exactly "# ${requestedTitle}".\n- The article must actually be about "${requestedTitle}", not a renamed replacement topic.\n- Include at least ${MIN_INTERNAL_LINKS} internal links using the exact format [visible text](halu:target-slug "hidden context hint").\n- Every internal link must include a non-empty hidden hint.\n- Do not explain the repair; just output the article.\n`;
      let rawMarkdown = "";
      if (onProgress) {
        await llm.streamChat(prompt.system, `${renderedUserPrompt}${repairNote}`, (_delta, accumulated) => {
          rawMarkdown = accumulated;
          onProgress(renderMarkdown(normalizeMarkdown(accumulated)));
        });
      } else {
        rawMarkdown = await llm.chat(prompt.system, `${renderedUserPrompt}${repairNote}`);
      }
      markdown = normalizeMarkdown(rawMarkdown);
      resolvedTitle = extractTitle(markdown, requestedTitle);
      const linkCount = extractInternalLinks(markdown).length;
      const titleOk = titleMatchesRequested(resolvedTitle, requestedTitle, slug);
      console.log(
        `[page] generation_attempt slug=${slug} attempt=${attempt} title=${JSON.stringify(resolvedTitle)} title_ok=${titleOk} links=${linkCount}`
      );
      if (linkCount >= MIN_INTERNAL_LINKS && titleOk) break;
      if (attempt === 3) {
        if (!titleOk) {
          throw new Error(`generated article title did not match requested slug: requested=${JSON.stringify(requestedTitle)} got=${JSON.stringify(resolvedTitle)}`);
        }
        throw new Error(`generated article did not include the required internal links (got ${linkCount}, need ${MIN_INTERNAL_LINKS})`);
      }
    }

    const normalizedSlug = slugify(slug);
    const article = {
      slug: normalizedSlug,
      canonicalSlug: normalizedSlug,
      title: requestedTitle,
      markdown,
      html: "",
      plain_text: markdownToPlainText(markdown),
      generated_at: Date.now(),
    };
    const links = extractInternalLinks(markdown);
    article.html = rewriteArticleHtml(renderMarkdown(markdown), links);
    saveArticle(db, article, links, Array.from(new Set([normalizedSlug, article.canonicalSlug])));
    await indexArticleChunks(
      db,
      llm,
      normalizedSlug,
      markdown,
      runtime.app.rag.enabled && runtime.llm.embeddings.enabled,
      runtime.app.rag.chunk_size
    );
    console.log(`[page] generation_done slug=${slug} title=${JSON.stringify(article.title)} links=${links.length}`);
    return article;
  }

  app.get("/api/health", (c) =>
    c.json({
      ok: true,
      model: runtime.llm.chat.model,
      database_path: runtime.app.storage.database_path,
    })
  );

  app.get("/api/page/:slug", async (c) => {
    const lookupSlug = slugify(c.req.param("slug"));
    if (!lookupSlug) return c.json({ error: "invalid slug" }, 400);
    console.log(`[page] request slug=${lookupSlug} path=${new URL(c.req.url).pathname}`);

    let article = getArticleByLookup(db, lookupSlug);
    if (article) {
      const cachedLinks = extractInternalLinks(article.markdown).length;
      if (hasSufficientLinks(article.markdown)) {
        console.log(`[page] cache_hit slug=${article.slug} links=${cachedLinks}`);
        return c.json({
          cached: true,
          article,
          backlinks: listBacklinks(db, article.slug),
          canonicalPath: canonicalPathForArticle(article),
        });
      }
      console.warn(`[page] cache_repair slug=${article.slug} links=${cachedLinks}`);
      article = null;
    }
    if (!article) {
      console.log(`[page] cache_miss slug=${lookupSlug}`);
    }

    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        const send = (payload: unknown) => {
          controller.enqueue(encoder.encode(`${JSON.stringify(payload)}\n`));
        };
        try {
          send({ type: "start", slug: lookupSlug, cached: false });
          article = await buildArticle(lookupSlug, (html) => {
            send({ type: "progress", html });
          });
          send({
            type: "done",
            cached: false,
            article,
            backlinks: listBacklinks(db, article.slug),
            canonicalPath: canonicalPathForArticle(article),
          });
          controller.close();
        } catch (error) {
          console.error(`[page] generation_failed slug=${lookupSlug}`, error);
          send({
            type: "error",
            message: error instanceof Error ? error.message : String(error),
          });
          controller.close();
        }
      },
    });

    return new Response(stream, {
      headers: {
        "content-type": "application/x-ndjson; charset=utf-8",
        "cache-control": "no-store",
      },
    });
  });

  app.get("/api/index", (c) => {
    const offset = Math.max(parseInt(c.req.query("cursor") ?? "0", 10) || 0, 0);
    const limit = Math.min(Math.max(parseInt(c.req.query("limit") ?? "200", 10) || 200, 1), 500);
    const page = listArticles(db, offset, limit);
    return c.json({
      items: page.items,
      cursor: page.nextOffset === null ? null : String(page.nextOffset),
      complete: page.nextOffset === null,
      total: page.total,
    });
  });

  app.get("/api/admin/overview", (c) => {
    return c.json({
      ...getAdminOverview(db),
      model: runtime.llm.chat.model,
      databasePath: runtime.app.storage.database_path,
      promptConfigPath: "config/prompts.toml",
    });
  });

  app.post("/api/admin/reload", async (c) => {
    await reloadRuntime();
    return c.json({ ok: true });
  });

  app.get("/api/search", (c) => {
    const q = (c.req.query("q") ?? "").trim().slice(0, 100);
    if (!q) {
      return c.json({
        query: "",
        results: [],
        existing_count: 0,
        hallucinated_count: 0,
        rate_limited: false,
        retry_after: null,
      });
    }

    const results = searchCorpus(db, q, runtime.app.search.limit).map((item) => ({
      slug: item.canonicalSlug,
      title: item.title === item.slug ? slugToTitle(item.slug) : item.title,
      exists: Boolean(item.existsFlag),
    }));

    return c.json({
      query: q,
      results,
      existing_count: results.filter((item) => item.exists).length,
      hallucinated_count: results.filter((item) => !item.exists).length,
      rate_limited: false,
      retry_after: null,
    });
  });

  // Comments are intentionally disabled from the active application path for now.
  // Keep the implementation on disk, but do not mount the routes until the feature returns.
  app.use("/assets/*", serveStatic({ root: distRoot }));

  app.get("*", async (c) => {
    const path = new URL(c.req.url).pathname;
    if (path.startsWith("/api/")) return c.notFound();

    const bareSlug = routeSlug(path);
    if (bareSlug && !path.startsWith("/wiki/")) {
      console.log(`[page] redirect bare_slug=${bareSlug} from=${path}`);
      return c.redirect(`/wiki/${bareSlug}`, 302);
    }

    if (path === "/" || path === "/search" || path === "/all-entries" || path === "/admin" || routeSlug(path)) {
      return c.html(await readFile(resolve(distRoot, "index.html"), "utf8"));
    }

    const filePath = resolve(distRoot, path.slice(1));
    const ext = extname(filePath);
    if (!ext) return c.notFound();

    try {
      const file = await readFile(filePath);
      return new Response(file, {
        headers: {
          "content-type":
            ext === ".js"
              ? "application/javascript; charset=utf-8"
              : ext === ".css"
              ? "text/css; charset=utf-8"
              : "application/octet-stream",
        },
      });
    } catch {
      return c.notFound();
    }
  });

  return { app, runtime };
}

async function bootstrap() {
  const { app, runtime } = await createApp();
  serve(
    {
      fetch: app.fetch,
      hostname: runtime.app.server.host,
      port: runtime.app.server.port,
    },
    (info) => {
      console.log(`[halupedia] listening on http://${info.address}:${info.port}`);
    }
  );
}

bootstrap().catch((error) => {
  console.error("[halupedia] startup_failed", error);
  process.exit(1);
});
