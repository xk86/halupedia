/**
 * On-demand image generator + cache.
 *
 * GET /img/:uuid — public, lazily generated.
 *
 *   1. Look up the UUID in the `images` D1 table. If absent → 404.
 *      This is the credit-drain guard: UUIDs are only ever INSERTed
 *      from inside the admin-gated enrichment flow, so a stranger
 *      hitting /img/whatever can't trigger an LLM call.
 *
 *   2. If `status='generated'`, stream the bytes from R2 (key = uuid)
 *      with an immutable far-future cache header.
 *
 *   3. If `status='pending'`, atomically flip to `'generating'` via an
 *      UPDATE-WHERE-status='pending' (claim pattern). The winning request
 *      calls OpenRouter, writes the bytes to R2, flips status to
 *      `'generated'`, and serves them. Losing requests poll briefly.
 *
 *   4. If `status='generating'`, poll a few times then 503 with retry.
 *
 *   5. If `status='failed'`, return 404 (no retries on bad prompts —
 *      we don't want a flaky prompt to drain the daily image budget).
 *
 * Daily cap: env `IMG_GEN_PER_DAY` (default 200). Counter in KV at
 * `__counter:img:YYYY-MM-DD`. When exceeded, even valid UUIDs return
 * 503 until tomorrow. Backstop against runaway costs.
 */

import type { Context } from "hono";
import { OpenRouter } from "@openrouter/sdk";
import type { Env } from "./index";

const DEFAULT_IMG_GEN_PER_DAY = 200;
const POLL_DELAY_MS = 600;
const POLL_MAX_ATTEMPTS = 8;
const DEFAULT_IMAGE_MODEL = "google/gemini-2.5-flash-image-preview";

interface ImageRow {
  uuid: string;
  slug: string;
  prompt: string;
  status: "pending" | "generating" | "generated" | "failed";
  error: string | null;
}

async function loadImageRow(db: D1Database, uuid: string): Promise<ImageRow | null> {
  try {
    return (
      (await db
        .prepare(
          "SELECT uuid, slug, prompt, status, error FROM images WHERE uuid = ?"
        )
        .bind(uuid)
        .first<ImageRow>()) ?? null
    );
  } catch (e) {
    console.error("images: load row failed", uuid, e);
    return null;
  }
}

/** Atomic claim: only the request whose UPDATE actually changed a row
 *  proceeds to generation. Other concurrent requests get false back and
 *  fall through to polling. */
async function tryClaim(db: D1Database, uuid: string): Promise<boolean> {
  try {
    const res = await db
      .prepare(
        "UPDATE images SET status='generating' WHERE uuid = ? AND status='pending'"
      )
      .bind(uuid)
      .run();
    return Number(res.meta?.changes ?? 0) > 0;
  } catch (e) {
    console.error("images: claim failed", uuid, e);
    return false;
  }
}

async function markGenerated(db: D1Database, uuid: string): Promise<void> {
  try {
    await db
      .prepare(
        "UPDATE images SET status='generated', generated_at=?, error=NULL WHERE uuid = ?"
      )
      .bind(Date.now(), uuid)
      .run();
  } catch (e) {
    console.error("images: mark generated failed", uuid, e);
  }
}

async function markFailed(db: D1Database, uuid: string, err: string): Promise<void> {
  try {
    await db
      .prepare("UPDATE images SET status='failed', error=? WHERE uuid = ?")
      .bind(err.slice(0, 500), uuid)
      .run();
  } catch (e) {
    console.error("images: mark failed failed", uuid, e);
  }
}

/* -------------------------------------------------------------------------- */
/*  Daily-cap counter                                                          */
/* -------------------------------------------------------------------------- */

async function dailyCounterKey(): Promise<string> {
  const today = new Date().toISOString().slice(0, 10);
  return `__counter:img:${today}`;
}

async function checkAndIncrementDaily(env: Env): Promise<boolean> {
  const cap = parseInt(env.IMG_GEN_PER_DAY || String(DEFAULT_IMG_GEN_PER_DAY), 10) || DEFAULT_IMG_GEN_PER_DAY;
  const key = await dailyCounterKey();
  try {
    const cur = await env.ARTICLES.get(key);
    const n = cur ? parseInt(cur, 10) || 0 : 0;
    if (n >= cap) return false;
    await env.ARTICLES.put(key, String(n + 1), { expirationTtl: 60 * 60 * 48 });
    return true;
  } catch {
    // On KV failure fall open — the per-uuid status flips still prevent
    // double-spend on the same UUID.
    return true;
  }
}

/* -------------------------------------------------------------------------- */
/*  OpenRouter image-gen call                                                  */
/* -------------------------------------------------------------------------- */

/** Calls OpenRouter via their official SDK with an image-capable model
 *  and the `image` modality enabled. Returns raw PNG/JPEG bytes +
 *  content-type. Throws on any failure (caller marks the row 'failed'
 *  and 502s). */
async function generateImageBytes(
  apiKey: string,
  model: string,
  prompt: string
): Promise<{ bytes: Uint8Array; contentType: string }> {
  const client = new OpenRouter({ apiKey });
  let result: any;
  try {
    result = await client.chat.send({
      httpReferer: "https://halupedia.com",
      appTitle: "Halupedia Image",
      chatRequest: {
        model,
        modalities: ["image"],
        stream: false,
        messages: [{ role: "user", content: prompt }],
      },
    });
  } catch (e: any) {
    throw new Error(`image LLM error: ${e?.message || e}`.slice(0, 300));
  }

  // The SDK normalises wire fields to camelCase. An image-capable model
  // returns choices[0].message.images[0].imageUrl.url as a data URL.
  // We also fall back to snake_case in case the SDK exposes the raw
  // payload for an unexpected response shape.
  const msg: any = result?.choices?.[0]?.message;
  const imgs: any[] = msg?.images ?? [];
  const first = imgs[0];
  const dataUrl: string | undefined =
    first?.imageUrl?.url ?? first?.image_url?.url;
  if (!dataUrl || typeof dataUrl !== "string") {
    throw new Error("no image in LLM response");
  }
  return dataUrlToBytes(dataUrl);
}

function dataUrlToBytes(dataUrl: string): { bytes: Uint8Array; contentType: string } {
  const m = /^data:([^;]+);base64,(.+)$/.exec(dataUrl.trim());
  if (!m) throw new Error("not a base64 data URL");
  const contentType = m[1] || "image/png";
  const b64 = m[2];
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return { bytes, contentType };
}

/* -------------------------------------------------------------------------- */
/*  R2 helpers                                                                 */
/* -------------------------------------------------------------------------- */

function r2KeyFor(uuid: string): string {
  return `img/${uuid}`;
}

async function streamFromR2(env: Env, uuid: string): Promise<Response | null> {
  try {
    const obj = await env.IMAGES.get(r2KeyFor(uuid));
    if (!obj) return null;
    const headers = new Headers();
    headers.set(
      "content-type",
      obj.httpMetadata?.contentType || "image/png"
    );
    headers.set("cache-control", "public, max-age=31536000, immutable");
    headers.set("x-halupedia-cached", "true");
    return new Response(obj.body, { headers });
  } catch (e) {
    console.error("images: R2 read failed", uuid, e);
    return null;
  }
}

async function writeToR2(env: Env, uuid: string, bytes: Uint8Array, contentType: string): Promise<void> {
  await env.IMAGES.put(r2KeyFor(uuid), bytes, {
    httpMetadata: { contentType },
  });
}

/* -------------------------------------------------------------------------- */
/*  Route handler                                                              */
/* -------------------------------------------------------------------------- */

const UUID_RE = /^[0-9a-fA-F]{8}-?[0-9a-fA-F]{4}-?[0-9a-fA-F]{4}-?[0-9a-fA-F]{4}-?[0-9a-fA-F]{12}$|^[0-9a-f]{32}$/;

function notFound(): Response {
  return new Response("not found", {
    status: 404,
    headers: { "content-type": "text/plain", "cache-control": "no-store" },
  });
}

export async function handleImageRequest(c: Context<{ Bindings: Env }>): Promise<Response> {
  const uuid = c.req.param("uuid");
  if (!uuid || !UUID_RE.test(uuid)) return notFound();

  // R2 binding missing → can't serve at all (don't fall back to anything
  // that could amplify cost or leak prompts).
  if (!c.env.IMAGES) {
    return new Response("image storage not configured", { status: 503 });
  }

  const row = await loadImageRow(c.env.DB, uuid);
  if (!row) return notFound();

  if (row.status === "failed") return notFound();

  if (row.status === "generated") {
    const r = await streamFromR2(c.env, uuid);
    if (r) return r;
    // R2 missing despite the DB saying 'generated' — treat as broken.
    return new Response("image missing from storage", { status: 502 });
  }

  if (row.status === "generating") {
    // Wait for the in-flight claim to finish.
    for (let i = 0; i < POLL_MAX_ATTEMPTS; i++) {
      await sleep(POLL_DELAY_MS);
      const r2 = await loadImageRow(c.env.DB, uuid);
      if (r2?.status === "generated") {
        const resp = await streamFromR2(c.env, uuid);
        if (resp) return resp;
      }
      if (r2?.status === "failed") return notFound();
    }
    return new Response("image generation in progress, retry shortly", {
      status: 503,
      headers: { "retry-after": "5" },
    });
  }

  // status === 'pending' → try to claim and generate.
  const claimed = await tryClaim(c.env.DB, uuid);
  if (!claimed) {
    // Someone else claimed it. Poll briefly.
    for (let i = 0; i < POLL_MAX_ATTEMPTS; i++) {
      await sleep(POLL_DELAY_MS);
      const r2 = await loadImageRow(c.env.DB, uuid);
      if (r2?.status === "generated") {
        const resp = await streamFromR2(c.env, uuid);
        if (resp) return resp;
      }
      if (r2?.status === "failed") return notFound();
    }
    return new Response("image generation in progress, retry shortly", {
      status: 503,
      headers: { "retry-after": "5" },
    });
  }

  // We won the claim. Honor the daily cap before spending money.
  const underCap = await checkAndIncrementDaily(c.env);
  if (!underCap) {
    // Release the claim so a later day's request can try again.
    try {
      await c.env.DB
        .prepare("UPDATE images SET status='pending' WHERE uuid = ? AND status='generating'")
        .bind(uuid)
        .run();
    } catch {}
    return new Response("daily image generation cap reached", {
      status: 503,
      headers: { "retry-after": "3600" },
    });
  }

  if (!c.env.OPENROUTER_API_KEY) {
    await markFailed(c.env.DB, uuid, "OPENROUTER_API_KEY not configured");
    return new Response("not configured", { status: 500 });
  }

  const model = c.env.OPENROUTER_IMAGE_MODEL || DEFAULT_IMAGE_MODEL;
  try {
    const { bytes, contentType } = await generateImageBytes(
      c.env.OPENROUTER_API_KEY,
      model,
      row.prompt
    );
    await writeToR2(c.env, uuid, bytes, contentType);
    await markGenerated(c.env.DB, uuid);
    const headers = new Headers();
    headers.set("content-type", contentType);
    headers.set("cache-control", "public, max-age=31536000, immutable");
    headers.set("x-halupedia-cached", "false");
    return new Response(bytes as BodyInit, { headers });
  } catch (e: any) {
    const msg = String(e?.message ?? e);
    console.error("images: generation failed", uuid, msg);
    await markFailed(c.env.DB, uuid, msg);
    return new Response("image generation failed", { status: 502 });
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
