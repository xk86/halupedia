/**
 * Image ingestion, caption generation, and media lifecycle.
 *
 * All heavy lifting (fetch, downscale, caption) lives here so routes and
 * pipeline nodes stay thin. The only external binaries are vipsthumbnail
 * and vipsheader (libvips, pre-installed on the host).
 */

import { createHash, randomBytes } from "node:crypto";
import { execFile as _execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { lookup as dnsLookup } from "node:dns/promises";
import type { DatabaseSync } from "node:sqlite";
import type { LlmRouter } from "./llm";
import type { Logger } from "./logger";
import type { ImagesConfig } from "./types";
import {
  getMediaBySha256,
  insertMedia,
  updateMediaDescription,
  updateMediaId,
  getMediaById,
  type MediaRecord,
} from "./mediaDb";
import {
  getArticleByLookup,
} from "./db";

const execFile = promisify(_execFile);

// ─── SSRF guard ───────────────────────────────────────────────────────────────

function isPrivateIp(ip: string): boolean {
  // IPv4 private / loopback / link-local ranges
  const v4 = ip.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4) {
    const [, a, b, c] = v4.map(Number);
    if (a === 127) return true;                          // 127.0.0.0/8
    if (a === 10) return true;                           // 10.0.0.0/8
    if (a === 172 && b >= 16 && b <= 31) return true;   // 172.16.0.0/12
    if (a === 192 && b === 168) return true;             // 192.168.0.0/16
    if (a === 169 && b === 254) return true;             // 169.254.0.0/16 link-local
    if (a === 0) return true;                            // 0.0.0.0/8
    if (a === 100 && b >= 64 && b <= 127) return true;  // 100.64.0.0/10 carrier-grade NAT
    return false;
  }
  // IPv6
  const v6 = ip.toLowerCase();
  if (v6 === "::1") return true;
  if (v6.startsWith("fc") || v6.startsWith("fd")) return true; // fc00::/7
  if (v6.startsWith("fe80")) return true;                       // fe80::/10
  if (v6 === "::" || v6 === "0:0:0:0:0:0:0:0") return true;
  return false;
}

async function assertSafeUrl(url: string, allowPrivate: boolean): Promise<URL> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error("Invalid URL");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("Only http/https URLs are allowed");
  }
  if (!allowPrivate) {
    let resolved: string;
    try {
      const result = await dnsLookup(parsed.hostname);
      resolved = result.address;
    } catch {
      throw new Error(`Could not resolve hostname: ${parsed.hostname}`);
    }
    if (isPrivateIp(resolved)) {
      throw new Error("URL resolves to a private/loopback address");
    }
  }
  return parsed;
}

// ─── Image fetching ───────────────────────────────────────────────────────────

async function fetchImageBytes(
  url: string,
  config: ImagesConfig,
): Promise<{ bytes: Buffer; mime: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.fetch_timeout_ms);
  let response: Response;
  try {
    response = await fetch(url, { signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
  if (!response.ok) throw new Error(`Image fetch failed: ${response.status}`);
  const contentType = response.headers.get("content-type") ?? "";
  const mime = contentType.split(";")[0].trim();
  if (!mime.startsWith("image/")) {
    throw new Error(`URL did not return an image (content-type: ${contentType})`);
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length > config.max_bytes) {
    throw new Error(`Image too large (${bytes.length} bytes, max ${config.max_bytes})`);
  }
  return { bytes, mime };
}

// ─── vips helpers ─────────────────────────────────────────────────────────────

async function getDims(filepath: string): Promise<{ width: number; height: number }> {
  const [wOut, hOut] = await Promise.all([
    execFile("vipsheader", ["-f", "width", filepath]),
    execFile("vipsheader", ["-f", "height", filepath]),
  ]);
  return {
    width: parseInt(wOut.stdout.trim(), 10),
    height: parseInt(hOut.stdout.trim(), 10),
  };
}

async function makeThumbnail(
  inputPath: string,
  maxEdge: number,
  quality: number,
): Promise<{ path: string; width: number; height: number }> {
  const outPath = `${inputPath}-thumb.jpg`;
  await execFile("vipsthumbnail", [
    inputPath,
    "--size", `${maxEdge}x${maxEdge}>`,
    "-o", `${outPath}[Q=${quality}]`,
  ]);
  const dims = await getDims(outPath);
  return { path: outPath, ...dims };
}

// ─── Caption generation ───────────────────────────────────────────────────────

interface CaptionResult {
  titleSlug: string;
  description: string;
  caption: string;
}

function sanitizeSlug(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

async function generateCaption(
  llm: LlmRouter,
  modelB64: string,
  modelMime: string,
  articleTitle: string,
  articleExcerpt: string,
  logger: Logger,
): Promise<CaptionResult> {
  const system = `You are an in-universe archivist for a fictional encyclopedia. Given an image and surrounding article text, produce a JSON object with three fields:
- title_slug: a kebab-case memorable slug for the image (e.g. "benzodiazepine-structural-formula"). No prefix.
- description: 1-2 sentences describing the image as if it belongs in this fictional world. Treat the article's subject as real.
- caption: a brief (under 12 words) visible caption for use alongside the image in the article.

Return ONLY valid JSON, nothing else. Example: {"title_slug":"...", "description":"...", "caption":"..."}`;

  const user = `Article title: ${articleTitle}

Article excerpt:
${articleExcerpt.slice(0, 1500)}

Describe the attached image in the context of this article.`;

  try {
    const raw = await llm.chat("light", system, user, {
      jsonMode: true,
      images: [{ mime: modelMime, b64: modelB64 }],
    });
    const match = raw.match(/\{[\s\S]*\}/);
    if (!match) throw new Error("no JSON in caption response");
    const parsed = JSON.parse(match[0]) as Partial<Record<string, string>>;
    const titleSlug = sanitizeSlug(String(parsed.title_slug ?? ""));
    const description = String(parsed.description ?? "").replace(/\s+/g, " ").trim();
    const caption = String(parsed.caption ?? "").replace(/\s+/g, " ").trim();
    if (!titleSlug || !description) throw new Error("caption response missing fields");
    return { titleSlug, description, caption };
  } catch (err) {
    logger.warn("media.caption_failed", {
      error: err instanceof Error ? err.message : String(err),
    });
    return { titleSlug: "", description: "", caption: "" };
  }
}

// ─── Slug uniqueness ──────────────────────────────────────────────────────────

function uniqueSlug(mediaDb: DatabaseSync, base: string, sha256: string): string {
  const fallback = `img-${sha256.slice(0, 12)}`;
  if (!base) return fallback;
  // Check if slug exists with a different sha256 (collision)
  for (let i = 0; i < 10; i++) {
    const candidate = i === 0 ? base : `${base}-${i + 1}`;
    const existing = getMediaById(mediaDb, candidate);
    if (!existing) return candidate;          // free slot
    if (existing.sha256 === sha256) return candidate; // same image, reuse
  }
  return fallback;
}

// ─── Public API ───────────────────────────────────────────────────────────────

export interface IngestResult {
  mediaId: string;
  isNew: boolean;
  description: string;
  caption: string;
  width: number;
  height: number;
}

/**
 * Fetch, downscale, deduplicate, and (if new) caption an image.
 * Returns the stable media ID to store in article_media.
 */
export async function ingestImageFromUrl(
  url: string,
  {
    mediaDb,
    mainDb,
    llm,
    config,
    articleSlug,
    logger,
  }: {
    mediaDb: DatabaseSync;
    mainDb: DatabaseSync;
    llm: LlmRouter;
    config: ImagesConfig;
    articleSlug: string;
    logger: Logger;
  },
): Promise<IngestResult> {
  // SSRF check
  await assertSafeUrl(url, config.allow_private_hosts);

  // Fetch
  const { bytes, mime } = await fetchImageBytes(url, config);
  const sha256 = createHash("sha256").update(bytes).digest("hex");

  // Deduplicate
  const existing = getMediaBySha256(mediaDb, sha256);
  if (existing) {
    logger.info("media.dedup", { id: existing.id, sha256: sha256.slice(0, 12) });
    // Generate a fresh caption for this article context even on dedup
    const article = getArticleByLookup(mainDb, articleSlug);
    let caption = existing.description;
    if (article && llm.supportsVision("light")) {
      const res = await generateCaption(
        llm,
        existing.model_b64,
        existing.model_mime,
        article.title,
        article.markdown.slice(0, 1500),
        logger,
      );
      caption = res.caption || existing.description;
    }
    return {
      mediaId: existing.id,
      isNew: false,
      description: existing.description,
      caption,
      width: existing.width,
      height: existing.height,
    };
  }

  // Write to temp files
  const tmpId = randomBytes(8).toString("hex");
  const ext = mime.replace("image/", "").replace("jpeg", "jpg").split(";")[0];
  const inputPath = join(tmpdir(), `halu-img-${tmpId}.${ext}`);
  const thumbPath = `${inputPath}-thumb.jpg`;

  try {
    await writeFile(inputPath, bytes);

    // Read original dims
    const origDims = await getDims(inputPath);

    // Generate model thumbnail (≤256px)
    const thumb = await makeThumbnail(inputPath, config.model_max_edge, config.jpeg_quality);

    // Read thumb bytes + base64
    const thumbBytes = await readFile(thumbPath);
    const modelB64 = thumbBytes.toString("base64");

    // Caption (requires vision support)
    const article = getArticleByLookup(mainDb, articleSlug);
    let captionResult: CaptionResult = { titleSlug: "", description: "", caption: "" };
    if (llm.supportsVision("light")) {
      captionResult = await generateCaption(
        llm,
        modelB64,
        "image/jpeg",
        article?.title ?? articleSlug,
        article?.markdown ?? "",
        logger,
      );
    }

    // Determine stable ID
    const tempId = `img-${sha256.slice(0, 12)}`;
    insertMedia(mediaDb, {
      id: tempId,
      sha256,
      sourceUrl: url,
      mime,
      width: origDims.width,
      height: origDims.height,
      bytes,
      byteSize: bytes.length,
      modelB64,
      modelMime: "image/jpeg",
      modelWidth: thumb.width,
      modelHeight: thumb.height,
      description: captionResult.description,
    });

    // Try to rename to the nice slug
    let finalId = tempId;
    if (captionResult.titleSlug) {
      const niceId = uniqueSlug(mediaDb, captionResult.titleSlug, sha256);
      if (niceId !== tempId && updateMediaId(mediaDb, tempId, niceId)) {
        finalId = niceId;
      }
    }

    logger.info("media.ingested", {
      id: finalId,
      sha256: sha256.slice(0, 12),
      width: origDims.width,
      height: origDims.height,
      model_width: thumb.width,
      model_height: thumb.height,
      vision: llm.supportsVision("light"),
    });

    return {
      mediaId: finalId,
      isNew: true,
      description: captionResult.description,
      caption: captionResult.caption,
      width: origDims.width,
      height: origDims.height,
    };
  } finally {
    await rm(inputPath, { force: true });
    await rm(thumbPath, { force: true });
  }
}

/**
 * Ingest an already-fetched image buffer (from a file upload or paste).
 * Skips URL fetch and SSRF checks — caller is responsible for the bytes.
 */
export async function ingestImageFromBuffer(
  bytes: Buffer,
  mime: string,
  {
    mediaDb,
    mainDb,
    llm,
    config,
    articleSlug,
    logger,
    sourceLabel = "upload",
  }: {
    mediaDb: DatabaseSync;
    mainDb: DatabaseSync;
    llm: LlmRouter;
    config: ImagesConfig;
    articleSlug: string;
    logger: Logger;
    sourceLabel?: string;
  },
): Promise<IngestResult> {
  if (bytes.length > config.max_bytes) {
    throw new Error(`Image too large (${bytes.length} bytes, max ${config.max_bytes})`);
  }
  if (!mime.startsWith("image/")) {
    throw new Error(`Not an image (mime: ${mime})`);
  }

  const sha256 = createHash("sha256").update(bytes).digest("hex");

  // Dedup
  const existing = getMediaBySha256(mediaDb, sha256);
  if (existing) {
    logger.info("media.dedup", { id: existing.id, sha256: sha256.slice(0, 12), source: sourceLabel });
    const article = getArticleByLookup(mainDb, articleSlug);
    let caption = existing.description;
    if (article && llm.supportsVision("light")) {
      const res = await generateCaption(llm, existing.model_b64, existing.model_mime, article.title, article.markdown.slice(0, 1500), logger);
      caption = res.caption || existing.description;
    }
    return { mediaId: existing.id, isNew: false, description: existing.description, caption, width: existing.width, height: existing.height };
  }

  const tmpId = randomBytes(8).toString("hex");
  const ext = mime.replace("image/", "").replace("jpeg", "jpg").split(";")[0] || "jpg";
  const inputPath = join(tmpdir(), `halu-img-${tmpId}.${ext}`);
  const thumbPath = `${inputPath}-thumb.jpg`;

  try {
    await writeFile(inputPath, bytes);
    const origDims = await getDims(inputPath);
    const thumb = await makeThumbnail(inputPath, config.model_max_edge, config.jpeg_quality);
    const thumbBytes = await readFile(thumbPath);
    const modelB64 = thumbBytes.toString("base64");

    const article = getArticleByLookup(mainDb, articleSlug);
    let captionResult: CaptionResult = { titleSlug: "", description: "", caption: "" };
    if (llm.supportsVision("light")) {
      captionResult = await generateCaption(llm, modelB64, "image/jpeg", article?.title ?? articleSlug, article?.markdown ?? "", logger);
    }

    const tempId = `img-${sha256.slice(0, 12)}`;
    insertMedia(mediaDb, {
      id: tempId, sha256, sourceUrl: null, mime,
      width: origDims.width, height: origDims.height, bytes, byteSize: bytes.length,
      modelB64, modelMime: "image/jpeg", modelWidth: thumb.width, modelHeight: thumb.height,
      description: captionResult.description,
    });

    let finalId = tempId;
    if (captionResult.titleSlug) {
      const niceId = uniqueSlug(mediaDb, captionResult.titleSlug, sha256);
      if (niceId !== tempId && updateMediaId(mediaDb, tempId, niceId)) finalId = niceId;
    }

    logger.info("media.ingested", { id: finalId, sha256: sha256.slice(0, 12), source: sourceLabel, width: origDims.width, height: origDims.height });
    return { mediaId: finalId, isNew: true, description: captionResult.description, caption: captionResult.caption, width: origDims.width, height: origDims.height };
  } finally {
    await rm(inputPath, { force: true });
    await rm(thumbPath, { force: true });
  }
}

export type { MediaRecord };
