import { Hono } from "hono";
import { slugify, slugToTitle } from "./slug";
import { sanitizeHTML, extractSummary, extractTitle, looksLikeArticle, extractLinkHints } from "./sanitize";
import { streamGeneration, generateOnce, type GenerateOptions } from "./llm";
import { HOMEPAGE_ARTICLE } from "./seed";
import { createCommentsApp } from "./comments";
import { rateLimit, clientIp } from "./ratelimit";
import { loadHints, saveHints } from "./hints";

export interface Env {
  ARTICLES: KVNamespace;
  DB: D1Database;
  ASSETS: Fetcher;
  OPENROUTER_API_KEY: string;
  OPENROUTER_MODEL: string;
  MAX_ARTICLES_PER_DAY: string;
  GEN_PER_IP_PER_HOUR?: string;
  IDENT_PER_IP_PER_HOUR?: string;
}

interface StoredArticle {
  html: string;
  title: string;
  summary: string;
  generatedAt: number;
  sourceContext?: { fromSlug: string; fromTitle: string } | null;
}

const app = new Hono<{ Bindings: Env }>();

// Comments / users / votes (D1-backed). Mounted at root so route paths like
// `/api/comments/:slug` and `/api/me` are stable.
app.route("/", createCommentsApp());

/* -------------------------------------------------------------------------- */
/*  Bot detection                                                              */
/*                                                                             */
/*  Crawlers love internal-link rabbit holes. Each Hallucinopedia article has  */
/*  20–40 outbound links, so an unrestricted bot would explode our token bill. */
/*  Policy: cached articles are served to anyone (cheap KV read), but bots     */
/*  cannot trigger fresh generation. They get a 404 and move on.               */
/* -------------------------------------------------------------------------- */

const BOT_UA_RE =
  /bot|crawler|spider|crawling|slurp|bingpreview|gptbot|claudebot|claude-web|ccbot|perplexity|anthropic|openai|google-?(?:bot|other|extended)|amazonbot|applebot|duckduck|yandex|baidu|sogou|exabot|mj12|ahrefs|semrush|dotbot|petalbot|bytespider|facebookexternalhit|meta-externalagent|linkedinbot|twitterbot|discordbot|telegrambot|whatsapp|slackbot|skypeuripreview|embedly|preview|curl|wget|python-(?:requests|urllib|httpx)|aiohttp|node-fetch|axios|got|httpie|java-http|okhttp|libwww|scrapy|headlesschrome|puppeteer|playwright/i;

function isBot(ua: string | null | undefined): boolean {
  if (!ua) return true; // missing UA → treat as bot
  return BOT_UA_RE.test(ua);
}

/** robots.txt — allow everything; the worker enforces no-generate for bots. */
app.get("/robots.txt", (c) => {
  const body = [
    "User-agent: *",
    "Allow: /",
    "Crawl-delay: 5",
    "",
  ].join("\n");
  return new Response(body, {
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "cache-control": "public, max-age=86400",
    },
  });
});

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

  // 2. Bot guard. Crawlers can read what's already in cache (handled above)
  //    but must not be allowed to spawn fresh generations.
  const ua = c.req.header("user-agent");
  if (isBot(ua)) {
    return c.json(
      { error: "entry has not yet been written" },
      404,
      { "x-robots-tag": "noindex" }
    );
  }

  // 3. Per-IP rate limit on generation (defense against UA-spoofing scrapers).
  const ip = clientIp(c);
  const perHour = parseInt(c.env.GEN_PER_IP_PER_HOUR || "30", 10);
  const rl = await rateLimit({
    kv: c.env.ARTICLES,
    bucket: "gen",
    ip,
    limit: perHour,
    windowSec: 3600,
  });
  if (!rl.ok) {
    return c.json(
      { error: `slow down — at most ${rl.limit} new entries per hour from one address` },
      429,
      { "retry-after": String(rl.retryAfter), "x-robots-tag": "noindex" }
    );
  }

  // 4. Daily soft cap (per-namespace counter).
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

  // Pull every prior link-context blurb other articles have written about
  // this slug. These become CANON the LLM must respect.
  let priorHints: string[] = [];
  try {
    priorHints = await loadHints(c.env.DB, slug, 15);
  } catch (e) {
    console.error("loadHints failed", e);
  }

  const genOpts: GenerateOptions = {
    apiKey: c.env.OPENROUTER_API_KEY,
    model: c.env.OPENROUTER_MODEL || "google/gemini-2.0-flash-001",
    title,
    slug,
    sourceContext,
    priorHints,
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
  let rawForHints = raw;
  if (!looksLikeArticle(sanitized)) {
    // Retry once, non-streaming.
    try {
      const retry = await generateOnce(genOpts);
      const retrySan = sanitizeHTML(retry);
      if (looksLikeArticle(retrySan)) {
        sanitized = retrySan;
        rawForHints = retry;
      } else {
        return; // give up; don't cache a broken article
      }
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

  // Harvest the LLM's `context="…"` attributes from the RAW (pre-sanitize) HTML
  // and persist them as hints for the targets this article links to. The
  // sanitized HTML served to the client no longer carries them.
  try {
    const hints = extractLinkHints(rawForHints);
    if (hints.length > 0) {
      await saveHints(env.DB, slug, hints);
    }
  } catch (e) {
    console.error("saveHints failed", e);
  }
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
