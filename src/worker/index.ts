import { Hono } from "hono";
import { slugify, slugToTitle } from "./slug";
import { sanitizeHTML, extractSummary, extractTitle, looksLikeArticle } from "./sanitize";
import { streamGeneration, generateOnce, type GenerateOptions } from "./llm";
import { HOMEPAGE_ARTICLE } from "./seed";

export interface Env {
  ARTICLES: KVNamespace;
  ASSETS: Fetcher;
  OPENROUTER_API_KEY: string;
  OPENROUTER_MODEL: string;
  MAX_ARTICLES_PER_DAY: string;
}

interface StoredArticle {
  html: string;
  title: string;
  summary: string;
  generatedAt: number;
  sourceContext?: { fromSlug: string; fromTitle: string } | null;
}

const app = new Hono<{ Bindings: Env }>();

/* -------------------------------------------------------------------------- */
/*  GET /api/page/:slug  — streaming article endpoint                          */
/* -------------------------------------------------------------------------- */

app.get("/api/page/:slug", async (c) => {
  const rawSlug = c.req.param("slug");
  const slug = slugify(rawSlug);

  if (!slug) {
    return c.json({ error: "invalid slug" }, 400);
  }

  // Canonicalize: if the client hit a non-canonical form, tell them.
  if (slug !== rawSlug) {
    return c.json({ redirect: `/${slug}` }, 200);
  }

  const fromSlugRaw = c.req.query("from");
  const fromSlug = fromSlugRaw ? slugify(fromSlugRaw) : null;

  // 1. Cache lookup.
  const cached = await c.env.ARTICLES.get(slug, "json") as StoredArticle | null;
  if (cached) {
    return streamString(cached.html, /* cached */ true);
  }

  // Special-case the homepage seed so cold installs have somewhere to land.
  if (slug === "hallucinopedia") {
    const seed: StoredArticle = {
      html: HOMEPAGE_ARTICLE,
      title: "Hallucinopedia",
      summary:
        "Hallucinopedia is an encyclopedia of a universe that did not exist before you opened it. Every entry is dreamt on demand and preserved forever.",
      generatedAt: Date.now(),
      sourceContext: null,
    };
    await c.env.ARTICLES.put(slug, JSON.stringify(seed));
    return streamString(seed.html, true);
  }

  // 2. Daily soft cap (per-namespace counter).
  const today = new Date().toISOString().slice(0, 10);
  const counterKey = `__counter:${today}`;
  const countStr = await c.env.ARTICLES.get(counterKey);
  const count = countStr ? parseInt(countStr, 10) : 0;
  const cap = parseInt(c.env.MAX_ARTICLES_PER_DAY || "5000", 10);
  if (count >= cap) {
    return c.json({ error: "daily generation cap reached; try again tomorrow" }, 503);
  }

  if (!c.env.OPENROUTER_API_KEY) {
    return c.json({ error: "OPENROUTER_API_KEY is not configured" }, 500);
  }

  // 3. Fetch source context if `from` is present.
  let sourceContext: GenerateOptions["sourceContext"] = null;
  if (fromSlug) {
    const fromArticle = await c.env.ARTICLES.get(fromSlug, "json") as StoredArticle | null;
    if (fromArticle) {
      sourceContext = {
        fromTitle: fromArticle.title,
        fromSummary: fromArticle.summary,
      };
    }
  }

  const title = slugToTitle(slug);
  const genOpts: GenerateOptions = {
    apiKey: c.env.OPENROUTER_API_KEY,
    model: c.env.OPENROUTER_MODEL || "google/gemini-2.0-flash-001",
    title,
    slug,
    sourceContext,
  };

  // 4. Stream generation, tee one copy to client, collect the other for KV.
  let upstream: ReadableStream<Uint8Array>;
  try {
    upstream = await streamGeneration(genOpts);
  } catch (err) {
    console.error("generation failed", err);
    return c.json({ error: "generation failed" }, 502);
  }

  const [toClient, toStore] = upstream.tee();

  // Increment counter optimistically (fire-and-forget).
  c.executionCtx.waitUntil(
    (async () => {
      try {
        await c.env.ARTICLES.put(counterKey, String(count + 1), { expirationTtl: 60 * 60 * 48 });
      } catch {}
    })()
  );

  // Collect + persist after stream ends (waitUntil keeps worker alive).
  c.executionCtx.waitUntil(
    collectAndStore(toStore, slug, genOpts, fromSlug, c.env).catch((e) =>
      console.error("collectAndStore error", e)
    )
  );

  return new Response(toClient, {
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "cache-control": "no-store",
      "x-hallucinopedia-cached": "false",
    },
  });
});

function streamString(text: string, cached: boolean): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(text));
      controller.close();
    },
  });
  return new Response(stream, {
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "cache-control": "public, max-age=3600",
      "x-hallucinopedia-cached": cached ? "true" : "false",
    },
  });
}

async function collectAndStore(
  stream: ReadableStream<Uint8Array>,
  slug: string,
  genOpts: GenerateOptions,
  fromSlug: string | null,
  env: Env
): Promise<void> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let raw = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    raw += decoder.decode(value, { stream: true });
  }
  raw += decoder.decode();

  let sanitized = sanitizeHTML(raw);
  if (!looksLikeArticle(sanitized)) {
    // Retry once, non-streaming.
    try {
      const retry = await generateOnce(genOpts);
      const retrySan = sanitizeHTML(retry);
      if (looksLikeArticle(retrySan)) sanitized = retrySan;
      else return; // give up; don't cache a broken article
    } catch {
      return;
    }
  }

  const article: StoredArticle = {
    html: sanitized,
    title: extractTitle(sanitized, genOpts.title),
    summary: extractSummary(sanitized),
    generatedAt: Date.now(),
    sourceContext: fromSlug
      ? { fromSlug, fromTitle: genOpts.sourceContext?.fromTitle ?? fromSlug }
      : null,
  };

  await env.ARTICLES.put(slug, JSON.stringify(article));
}

/* -------------------------------------------------------------------------- */
/*  GET /api/random  — pick a random cached slug                               */
/* -------------------------------------------------------------------------- */

app.get("/api/random", async (c) => {
  const list = await c.env.ARTICLES.list({ limit: 1000 });
  const slugs = list.keys
    .map((k) => k.name)
    .filter((n) => !n.startsWith("__"));
  if (slugs.length === 0) {
    return c.json({ slug: "hallucinopedia" });
  }
  const slug = slugs[Math.floor(Math.random() * slugs.length)];
  return c.json({ slug });
});

/* -------------------------------------------------------------------------- */
/*  GET /api/meta/:slug  — lightweight title/summary probe (unused v1)         */
/* -------------------------------------------------------------------------- */

app.get("/api/meta/:slug", async (c) => {
  const slug = slugify(c.req.param("slug"));
  const a = await c.env.ARTICLES.get(slug, "json") as StoredArticle | null;
  if (!a) return c.json({ exists: false });
  return c.json({
    exists: true,
    title: a.title,
    summary: a.summary,
    generatedAt: a.generatedAt,
  });
});

/* -------------------------------------------------------------------------- */
/*  Catch-all: serve SPA assets                                                */
/* -------------------------------------------------------------------------- */

app.all("*", async (c) => {
  return c.env.ASSETS.fetch(c.req.raw);
});

export default app;
