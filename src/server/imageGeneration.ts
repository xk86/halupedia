import type { Logger } from "./logger";
import type { ImageGenerationConfig } from "./types";
import { parseImageSize, validateOpenAIImageSize } from "./imageAspectRatios";

type ImageFetch = (url: string, init?: RequestInit) => Promise<Response>;

let imageFetchImpl: ImageFetch = (url, init) => fetch(url, init);

export function setImageGenerationFetchForTests(fetchImpl: ImageFetch | null): void {
  imageFetchImpl = fetchImpl ?? ((url, init) => fetch(url, init));
}

function imageFetch(url: string, init?: RequestInit): Promise<Response> {
  return imageFetchImpl(url, init);
}

export interface GeneratedArticleImage {
  bytes: Buffer;
  mime: string;
  revisedPrompt?: string;
  backend: "openai" | "ollama";
  model: string;
}

export interface GenerateArticleImageOptions {
  prompt: string;
  config: ImageGenerationConfig;
  logger: Logger;
  size?: string;
}

function normalizeBaseUrl(baseUrl: string, fallback: string): string {
  return (baseUrl || fallback).replace(/\/$/, "");
}

function decodeBase64Image(value: unknown, label: string): Buffer {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${label} response did not include image data`);
  }
  const clean = value.includes(",") ? value.slice(value.indexOf(",") + 1) : value;
  return Buffer.from(clean, "base64");
}

function mimeFromDataUrl(value: string | undefined): string {
  const match = value?.match(/^data:([^;,]+)[;,]/);
  return match?.[1] ?? "image/png";
}

function mimeFromOpenAIOutputFormat(format: string | undefined): string {
  switch (format?.toLowerCase()) {
    case "jpeg":
    case "jpg":
      return "image/jpeg";
    case "webp":
      return "image/webp";
    default:
      return "image/png";
  }
}

function supportsOpenAIOutputCompression(format: string | undefined): boolean {
  const normalized = format?.toLowerCase();
  return normalized === "jpeg" || normalized === "jpg" || normalized === "webp";
}

function parseOllamaGenerateResponse(text: string): { image?: string } {
  const trimmed = text.trim();
  if (!trimmed) return {};
  try {
    return JSON.parse(trimmed) as { image?: string };
  } catch {}

  let final: { image?: string } = {};
  for (const line of trimmed.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line) as { image?: string; done?: boolean };
      if (parsed.image || parsed.done) final = parsed;
    } catch {}
  }
  return final;
}

async function generateWithOpenAI(
  prompt: string,
  config: ImageGenerationConfig,
  logger: Logger,
  size = config.openai.size,
): Promise<GeneratedArticleImage> {
  const openai = config.openai;
  if (!openai.api_key.trim()) {
    throw new Error("OpenAI image generation requires images.generation.openai.api_key");
  }
  const sizeError = validateOpenAIImageSize(size);
  if (sizeError) {
    throw new Error(`OpenAI image generation ${sizeError}`);
  }
  const url = `${normalizeBaseUrl(openai.base_url, "https://api.openai.com/v1")}/images/generations`;
  const startedAt = Date.now();
  const outputFormat = openai.output_format;
  const body: Record<string, unknown> = {
    model: openai.model,
    prompt,
    n: 1,
    size,
    quality: openai.quality,
    output_format: outputFormat,
  };
  if (supportsOpenAIOutputCompression(outputFormat)) {
    body.output_compression = openai.output_compression;
  }
  const response = await imageFetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${openai.api_key}`,
    },
    signal: AbortSignal.timeout(openai.timeout_ms),
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`OpenAI image generation failed: ${response.status} ${text.slice(0, 300)}`);
  }
  const json = (await response.json()) as {
    data?: Array<{ b64_json?: string; url?: string; revised_prompt?: string }>;
  };
  const first = json.data?.[0];
  if (!first) throw new Error("OpenAI image generation returned no images");
  let bytes: Buffer;
  let mime = mimeFromOpenAIOutputFormat(outputFormat);
  if (first.b64_json) {
    bytes = decodeBase64Image(first.b64_json, "OpenAI image generation");
  } else if (first.url) {
    const imageResponse = await imageFetch(first.url, {
      signal: AbortSignal.timeout(openai.timeout_ms),
    });
    if (!imageResponse.ok) {
      throw new Error(`OpenAI generated image download failed: ${imageResponse.status}`);
    }
    mime = imageResponse.headers.get("content-type")?.split(";")[0]?.trim() || "image/png";
    bytes = Buffer.from(await imageResponse.arrayBuffer());
  } else {
    throw new Error("OpenAI image generation returned neither b64_json nor url");
  }
  logger.info("article_image.openai.generated", {
    model: openai.model,
    duration_ms: Date.now() - startedAt,
    bytes: bytes.length,
  });
  return {
    bytes,
    mime,
    revisedPrompt: first.revised_prompt,
    backend: "openai",
    model: openai.model,
  };
}

async function generateWithOllama(
  prompt: string,
  config: ImageGenerationConfig,
  logger: Logger,
  size?: string,
): Promise<GeneratedArticleImage> {
  const ollama = config.ollama;
  const parsedSize = size ? parseImageSize(size) : null;
  const base = normalizeBaseUrl(ollama.base_url, "http://127.0.0.1:11434").replace(/\/v1$/, "");
  const startedAt = Date.now();
  const response = await imageFetch(`${base}/api/generate`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    signal: AbortSignal.timeout(ollama.timeout_ms),
    body: JSON.stringify({
      model: ollama.model,
      prompt,
      stream: false,
      width: parsedSize?.width ?? ollama.width,
      height: parsedSize?.height ?? ollama.height,
      steps: ollama.steps,
    }),
  });
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`Ollama image generation failed: ${response.status} ${text.slice(0, 300)}`);
  }
  const json = parseOllamaGenerateResponse(await response.text());
  const bytes = decodeBase64Image(json.image, "Ollama image generation");
  logger.info("article_image.ollama.generated", {
    model: ollama.model,
    duration_ms: Date.now() - startedAt,
    bytes: bytes.length,
  });
  return {
    bytes,
    mime: mimeFromDataUrl(json.image),
    backend: "ollama",
    model: ollama.model,
  };
}

export async function generateArticleImage({
  prompt,
  config,
  logger,
  size,
}: GenerateArticleImageOptions): Promise<GeneratedArticleImage> {
  if (!config.enabled) {
    throw new Error("image generation is disabled");
  }
  if (config.backend === "ollama") {
    return generateWithOllama(prompt, config, logger, size);
  }
  return generateWithOpenAI(prompt, config, logger, size);
}
