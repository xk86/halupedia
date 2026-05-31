/**
 * Image ingestion: fetch, downscale, dedup, store.
 *
 * Caption / description generation is handled separately by the
 * `image.caption` pipeline workflow so it is traceable, prompt-editable,
 * and visible in the admin panel. Callers trigger that workflow after ingest.
 *
 * The only external binaries required are vipsthumbnail and vipsheader
 * (libvips — pre-installed on the host).
 */

import { createHash, randomBytes } from "node:crypto";
import { execFile as _execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { lookup as dnsLookup } from "node:dns/promises";
import type { DatabaseSync } from "node:sqlite";
import type { Logger } from "./logger";
import type { ImagesConfig } from "./types";
import {
  getMediaBySha256,
  insertMedia,
  getMediaById,
  type MediaRecord,
} from "./mediaDb";

const execFile = promisify(_execFile);

// ─── SSRF guard ───────────────────────────────────────────────────────────────

function isPrivateIp(ip: string): boolean {
  const v4 = ip.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4) {
    const [, a, b] = v4.map(Number);
    if (a === 127) return true;
    if (a === 10) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 169 && b === 254) return true;
    if (a === 0) return true;
    if (a === 100 && b >= 64 && b <= 127) return true;
    return false;
  }
  const v6 = ip.toLowerCase();
  if (v6 === "::1") return true;
  if (v6.startsWith("fc") || v6.startsWith("fd")) return true;
  if (v6.startsWith("fe80")) return true;
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

// ─── Core ingest (no LLM) ─────────────────────────────────────────────────────

export interface IngestResult {
  mediaId: string;
  /** True when a new media record was created; false on sha256 dedup. */
  isNew: boolean;
  width: number;
  height: number;
}

async function storeImage(
  mediaDb: DatabaseSync,
  bytes: Buffer,
  mime: string,
  sourceUrl: string | null,
  config: ImagesConfig,
  logger: Logger,
): Promise<IngestResult> {
  const sha256 = createHash("sha256").update(bytes).digest("hex");

  const existing = getMediaBySha256(mediaDb, sha256);
  if (existing) {
    logger.info("media.dedup", { id: existing.id, sha256: sha256.slice(0, 12) });
    return { mediaId: existing.id, isNew: false, width: existing.width, height: existing.height };
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

    const mediaId = `img-${sha256.slice(0, 12)}`;
    insertMedia(mediaDb, {
      id: mediaId,
      sha256,
      sourceUrl,
      mime,
      width: origDims.width,
      height: origDims.height,
      bytes,
      byteSize: bytes.length,
      modelB64,
      modelMime: "image/jpeg",
      modelWidth: thumb.width,
      modelHeight: thumb.height,
      description: "",
    });

    logger.info("media.ingested", {
      id: mediaId,
      sha256: sha256.slice(0, 12),
      width: origDims.width,
      height: origDims.height,
      model_width: thumb.width,
      model_height: thumb.height,
    });

    return { mediaId, isNew: true, width: origDims.width, height: origDims.height };
  } finally {
    await rm(inputPath, { force: true });
    await rm(thumbPath, { force: true });
  }
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Fetch a remote image, downscale, dedup and store it.
 * Caption / description is NOT generated here — the caller triggers the
 * `image.caption` pipeline workflow asynchronously after ingest.
 */
export async function ingestImageFromUrl(
  url: string,
  {
    mediaDb,
    config,
    logger,
  }: {
    mediaDb: DatabaseSync;
    config: ImagesConfig;
    logger: Logger;
  },
): Promise<IngestResult> {
  await assertSafeUrl(url, config.allow_private_hosts);
  const { bytes, mime } = await fetchImageBytes(url, config);
  return storeImage(mediaDb, bytes, mime, url, config, logger);
}

/**
 * Ingest already-fetched bytes (file upload / clipboard paste).
 * Skips SSRF checks — caller is responsible for the bytes.
 */
export async function ingestImageFromBuffer(
  bytes: Buffer,
  mime: string,
  {
    mediaDb,
    config,
    logger,
    sourceLabel = "upload",
  }: {
    mediaDb: DatabaseSync;
    config: ImagesConfig;
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
  logger.info("media.buffer_ingest", { mime, bytes: bytes.length, source: sourceLabel });
  return storeImage(mediaDb, bytes, mime, null, config, logger);
}

export type { MediaRecord };
