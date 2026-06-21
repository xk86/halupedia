import type { ImageAspectRatioConfig, ImageGenerationConfig } from "./types";

export const DEFAULT_IMAGE_ASPECT_RATIO_KEY = "landscape";
export const AUTO_IMAGE_ASPECT_RATIO_KEY = "auto";

const MIN_OPENAI_IMAGE_PIXELS = 600_000;

export interface ImageSize {
  width: number;
  height: number;
}

export interface ArticleImageAspectRatioOption extends ImageAspectRatioConfig {
  key: string;
}

const BUILT_IN_ASPECT_RATIOS: Record<string, ImageAspectRatioConfig> = {
  landscape: {
    label: "landscape",
    size: "1088x624",
    selection_when: "Use for ordinary article headline images, places, scenes, objects, and general encyclopedia illustrations.",
  },
  square: {
    label: "square",
    size: "832x832",
    selection_when: "Use for icons, specimens, centered artifacts, album-like covers, badges, symbols, and compact visual subjects.",
  },
  portrait: {
    label: "portrait",
    size: "832x1088",
    selection_when: "Use for people, character portraits, statues, fashion, costumes, tall objects, and vertical compositions.",
  },
  poster: {
    label: "poster portrait",
    size: "768x1152",
    selection_when: "Use for posters, covers, propaganda, exhibition placards, title cards, and designed printed artifacts.",
  },
  wide: {
    label: "wide landscape",
    size: "1152x672",
    selection_when: "Use for broad landscapes, group scenes, architecture, maps, ceremonies, battle scenes, or environment-heavy subjects.",
  },
};

export function parseImageSize(size: string): ImageSize | null {
  const match = size.trim().match(/^(\d+)x(\d+)$/i);
  if (!match) return null;
  const width = Number(match[1]);
  const height = Number(match[2]);
  if (!Number.isInteger(width) || !Number.isInteger(height)) return null;
  return { width, height };
}

export function validateOpenAIImageSize(size: string): string | null {
  const parsed = parseImageSize(size);
  if (!parsed) return "image size must use WIDTHxHEIGHT, for example 1088x624";
  if (parsed.width <= 0 || parsed.height <= 0) return "image size dimensions must be positive";
  if (parsed.width % 16 !== 0 || parsed.height % 16 !== 0) {
    return "image size width and height must be divisible by 16";
  }
  if (parsed.width * parsed.height < MIN_OPENAI_IMAGE_PIXELS) {
    return `image size must be at least ${MIN_OPENAI_IMAGE_PIXELS} pixels`;
  }
  return null;
}

function normalizeAspectRatioKey(value: string | undefined): string {
  const key = (value ?? "").trim().toLowerCase();
  if (!key || key === DEFAULT_IMAGE_ASPECT_RATIO_KEY) return DEFAULT_IMAGE_ASPECT_RATIO_KEY;
  if (key === AUTO_IMAGE_ASPECT_RATIO_KEY) return AUTO_IMAGE_ASPECT_RATIO_KEY;
  if (!/^[a-z0-9_]+$/i.test(key)) {
    throw new Error("invalid image aspect ratio key");
  }
  return key;
}

export function normalizeArticleImageAspectRatioKey(value: string | undefined): string {
  return normalizeAspectRatioKey(value);
}

export function listArticleImageAspectRatios(
  config: ImageGenerationConfig,
): ArticleImageAspectRatioOption[] {
  const configured = config.aspect_ratios ?? {};
  const { default: legacyDefaultAspectRatio, ...configuredAspectRatios } = configured;
  const defaultFromOpenAI = {
    ...BUILT_IN_ASPECT_RATIOS.landscape,
    size: config.openai.size,
  };
  const merged = {
    ...BUILT_IN_ASPECT_RATIOS,
    landscape: configured.landscape ?? legacyDefaultAspectRatio ?? defaultFromOpenAI,
    ...configuredAspectRatios,
  };
  return Object.entries(merged)
    .map(([key, option]) => ({
      key: key.toLowerCase(),
      label: option.label || key,
      size: option.size,
      selection_when: option.selection_when,
    }))
    .filter((option) => !validateOpenAIImageSize(option.size));
}

export function resolveArticleImageAspectRatio(
  config: ImageGenerationConfig,
  value: string | undefined,
): ArticleImageAspectRatioOption {
  const key = normalizeAspectRatioKey(value);
  if (key === AUTO_IMAGE_ASPECT_RATIO_KEY) {
    throw new Error("automatic image aspect ratio was not resolved");
  }
  const option = listArticleImageAspectRatios(config).find((row) => row.key === key);
  if (!option) throw new Error(`unknown image aspect ratio: ${key}`);
  return option;
}
