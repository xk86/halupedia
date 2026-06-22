import { defineNode } from "../runtime/nodeFactory";
import type { PipelineDeps } from "../deps";
import { getArticleByLookup } from "../../db";
import { stripJsonFences } from "../../prompts";
import { readPromptFile, listArticleImagePresetFiles } from "../../promptEditor";
import { stripTopLevelSections, summaryMarkdownFromArticle } from "../../markdown";
import {
  AUTO_IMAGE_ASPECT_RATIO_KEY,
  listArticleImageAspectRatios,
  normalizeArticleImageAspectRatioKey,
} from "../../imageAspectRatios";

const DEFAULT_IMAGE_PRESET_KEY = "documentary_photo";
const PRESET_SELECTION_MAX_ATTEMPTS = 3;

function normalizePresetKey(value: string | undefined): string {
  const key = (value ?? "").trim().toLowerCase();
  if (!key || key === "article_image") return DEFAULT_IMAGE_PRESET_KEY;
  if (key === "auto") return "auto";
  const normalized = key.replace(/^article_image_/, "");
  if (!/^[a-z0-9_]+$/i.test(normalized)) {
    throw new Error("invalid image preset key");
  }
  return normalized;
}

function promptSummary(text: string): string {
  return text
    .replace(/\{\{[a-zA-Z0-9_]+\}\}/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 420);
}

function selectionSummary(text: string): string {
  return text
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 240);
}

function stableHash(value: string): number {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function shuffleRowsForSeed<T extends { key: string }>(rows: T[], seed: string): T[] {
  return [...rows].sort((a, b) => {
    const diff = stableHash(`${seed}:${a.key}`) - stableHash(`${seed}:${b.key}`);
    return diff || a.key.localeCompare(b.key);
  });
}

interface PresetPromptRow {
  key: string;
  presetKey: string;
  description: string;
  selectionWhen?: string;
  recommendedAspectRatios: string[];
}

interface AspectRatioPromptRow {
  key: string;
  label: string;
  size: string;
  selectionWhen?: string;
  recommended?: boolean;
}

function imagePresetRowsForPrompt(
  seed: string,
  options: { includeDefault?: boolean; onlyPresetKeys?: Set<string>; excludePresetKeys?: Set<string> } = {},
): PresetPromptRow[] {
  const includeDefault = options.includeDefault !== false;
  const defaultPrompt = readPromptFile("runnable", "article_image");
  const rows = [
    ...listArticleImagePresetFiles().map((preset) => ({
      key: preset.key,
      presetKey: preset.key,
      description: promptSummary(`${preset.system}\n${preset.user}`),
      selectionWhen: preset.selectionWhen,
      recommendedAspectRatios: preset.recommendedAspectRatios,
    })),
    ...(includeDefault
      ? [
          {
            key: DEFAULT_IMAGE_PRESET_KEY,
            presetKey: DEFAULT_IMAGE_PRESET_KEY,
            description: defaultPrompt
              ? promptSummary(`${defaultPrompt.system}\n${defaultPrompt.user}`)
              : "Photoreal editorial/documentary article image.",
            selectionWhen:
              "The article is best served by a grounded documentary, archival, field, portrait, location, museum, lab, or editorial photograph.",
            recommendedAspectRatios: [],
          },
        ]
      : []),
  ].filter((row) =>
    (!options.onlyPresetKeys || options.onlyPresetKeys.has(row.presetKey)) &&
    (!options.excludePresetKeys || !options.excludePresetKeys.has(row.presetKey))
  );
  return shuffleRowsForSeed(rows, seed);
}

function formatImagePresetRows(rows: PresetPromptRow[]): string {
  return rows
    .map((row) => [
      `- ${row.key}:`,
      row.selectionWhen ? `  ${selectionSummary(row.selectionWhen)}` : `  Style: ${promptSummary(row.description)}`,
      row.recommendedAspectRatios.length > 0
        ? `  Recommended aspect ratios: ${row.recommendedAspectRatios.join(", ")}`
        : "",
    ].filter(Boolean).join("\n"))
    .join("\n");
}

function formatAspectRatioRows(rows: AspectRatioPromptRow[]): string {
  return rows
    .map((row) => [
      `- ${row.key}: ${row.label} (${row.size})${row.recommended ? " [recommended for selected preset]" : ""}`,
      row.selectionWhen ? `  ${promptSummary(row.selectionWhen)}` : "",
    ].filter(Boolean).join("\n"))
    .join("\n");
}

function allowedPresetKeys(rows: PresetPromptRow[]): Map<string, string> {
  const allowed = new Map<string, string>();
  for (const row of rows) {
    allowed.set(row.key, row.presetKey);
  }
  return allowed;
}

function allowedAspectRatioKeys(rows: AspectRatioPromptRow[]): Set<string> {
  return new Set(rows.map((row) => row.key));
}

function presetSelectionJsonSchema(
  rows: PresetPromptRow[],
  aspectRows: AspectRatioPromptRow[],
  requireAspect: boolean,
): Record<string, unknown> {
  const properties: Record<string, unknown> = {
    presetKey: {
      type: "string",
      enum: rows.map((row) => row.key),
      description: "One key from the allowed preset list.",
    },
    reason: {
      type: "string",
      description: "One short sentence explaining the preset choice.",
    },
  };
  const required = ["presetKey", "reason"];

  if (aspectRows.length > 0) {
    properties.aspectRatioKey = {
      type: "string",
      enum: aspectRows.map((row) => row.key),
      description: "One key from the allowed aspect ratio list.",
    };
    properties.aspectRatioReason = {
      type: "string",
      description: "One short sentence explaining the aspect ratio choice.",
    };
    if (requireAspect) {
      required.push("aspectRatioKey", "aspectRatioReason");
    }
  }

  return {
    type: "object",
    additionalProperties: false,
    properties,
    required,
  };
}

function oneSentenceReason(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.replace(/\s+/g, " ").trim();
  if (!trimmed) return undefined;
  const sentence = trimmed.match(/^.*?[.!?](?:\s|$)/)?.[0]?.trim() ?? trimmed;
  return sentence.slice(0, 280);
}

function parseSelectedPreset(
  raw: string,
  allowedPresets: Map<string, string>,
  allowedAspects: Set<string>,
  requireAspect: boolean,
): { presetKey: string; aspectRatioKey?: string; reason?: string; aspectRatioReason?: string } | null {
  const cleaned = stripJsonFences(raw).trim();
  try {
    const parsed = JSON.parse(cleaned) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const obj = parsed as {
      presetKey?: unknown;
      key?: unknown;
      aspectRatioKey?: unknown;
      aspectKey?: unknown;
      reason?: unknown;
      aspectRatioReason?: unknown;
    };
    const rawKey = obj.presetKey ?? obj.key;
    if (typeof rawKey !== "string") return null;
    const key = normalizePresetKey(rawKey);
    const presetKey = allowedPresets.get(key);
    if (!presetKey) return null;

    const rawAspectKey = obj.aspectRatioKey ?? obj.aspectKey;
    let aspectRatioKey: string | undefined;
    if (typeof rawAspectKey === "string") {
      aspectRatioKey = normalizeArticleImageAspectRatioKey(rawAspectKey);
      if (!allowedAspects.has(aspectRatioKey)) return null;
    } else if (requireAspect) {
      return null;
    }

    return {
      presetKey,
      aspectRatioKey,
      reason: oneSentenceReason(obj.reason),
      aspectRatioReason: oneSentenceReason(obj.aspectRatioReason),
    };
  } catch {
    return null;
  }
}

async function selectPresetWithRetries(options: {
  articleSlug: string;
  deps: PipelineDeps;
  rows: PresetPromptRow[];
  aspectRows: AspectRatioPromptRow[];
  renderSelectionPrompt: (
    rows: PresetPromptRow[],
    aspectRows: AspectRatioPromptRow[],
    selectionGuidance: string,
  ) => ReturnType<PipelineDeps["prompts"]["render"]>;
  baseSelectionGuidance: string;
  requireAspect: boolean;
  invalidEvent: string;
}): Promise<{ presetKey: string; aspectRatioKey?: string; reason?: string; aspectRatioReason?: string }> {
  const allowedPresets = allowedPresetKeys(options.rows);
  const allowedAspects = allowedAspectRatioKeys(options.aspectRows);
  const jsonSchema = presetSelectionJsonSchema(options.rows, options.aspectRows, options.requireAspect);
  let lastRaw = "";
  for (let attempt = 1; attempt <= PRESET_SELECTION_MAX_ATTEMPTS; attempt += 1) {
    const retryGuidance = attempt === 1
      ? options.baseSelectionGuidance
      : [
          options.baseSelectionGuidance,
          `Previous response missed the selector schema. Return exactly {"presetKey":"one_allowed_key","aspectRatioKey":"one_allowed_aspect_key","reason":"one short sentence","aspectRatioReason":"one short sentence"}. Attempt ${attempt} of ${PRESET_SELECTION_MAX_ATTEMPTS}.`,
        ].filter(Boolean).join("\n\n");
    const rendered = options.renderSelectionPrompt(options.rows, options.aspectRows, retryGuidance);
    const raw = await options.deps.llm.chat(rendered.role, rendered.system, rendered.user, {
      thinking: rendered.thinking,
      jsonMode: rendered.json,
      jsonSchema,
    });
    lastRaw = raw;
    const selected = parseSelectedPreset(raw, allowedPresets, allowedAspects, options.requireAspect);
    if (selected) return selected;
    options.deps.logger.warn(options.invalidEvent, {
      slug: options.articleSlug,
      attempt,
      maxAttempts: PRESET_SELECTION_MAX_ATTEMPTS,
      raw: raw.slice(0, 500),
    });
  }
  throw new Error(
    `article image preset selection returned invalid selector responses after ${PRESET_SELECTION_MAX_ATTEMPTS} attempts: ${lastRaw.slice(0, 160)}`,
  );
}

function articleImagePresetSelectionContext(input: { slug?: string }, deps: PipelineDeps) {
  if (!input.slug) throw new Error("image preset selection requires an article slug");

  const article = getArticleByLookup(deps.db, input.slug);
  if (!article) throw new Error("article not found");

  const articleBody = stripTopLevelSections(article.markdown, ["References", "See also"]);
  const seed = `${article.slug}:${article.title}`;
  const renderSelectionPrompt = (
    rows: PresetPromptRow[],
    aspectRows: AspectRatioPromptRow[],
    selectionGuidance: string,
  ) =>
    deps.prompts.render("article_image_preset_selection", {
      requested_title: article.title,
      summary: article.summaryMarkdown || summaryMarkdownFromArticle(article.markdown),
      article_excerpt: articleBody.slice(0, 2400),
      available_presets: formatImagePresetRows(rows),
      available_aspect_ratios: formatAspectRatioRows(aspectRows),
      selection_guidance: selectionGuidance,
    });
  return { article, seed, renderSelectionPrompt };
}

function aspectRatioRowsForPrompt(deps: PipelineDeps, requested: string, presetRows: PresetPromptRow[] = []): AspectRatioPromptRow[] {
  const recommendedKeys = new Set(presetRows.flatMap((row) => row.recommendedAspectRatios));
  const rows = listArticleImageAspectRatios(deps.runtime.app.images.generation).map((option) => ({
    key: option.key,
    label: option.label,
    size: option.size,
    selectionWhen: option.selection_when,
    recommended: recommendedKeys.has(option.key),
  })).sort((a, b) => Number(b.recommended) - Number(a.recommended));
  if (requested === AUTO_IMAGE_ASPECT_RATIO_KEY) return rows;
  return rows.filter((row) => row.key === requested);
}

export const selectArticleImagePresetNode = defineNode({
  name: "llm.select_image_preset_initial",
  kind: "llm",
  description: "Choose the initial article-image preset when automatic preset selection is requested.",
  reads: ["input"] as const,
  writes: [
    "initialImagePromptKey",
    "initialImagePromptReason",
    "selectedImagePromptKey",
    "selectedImagePromptReason",
    "selectedImageAspectRatioKey",
    "selectedImageAspectRatioReason",
  ] as const,
  async run({ input }, deps: PipelineDeps) {
    const requested = normalizePresetKey(input.imagePromptKey);
    const requestedAspect = normalizeArticleImageAspectRatioKey(input.imageAspectRatioKey);
    if (requested !== "auto" && requestedAspect !== AUTO_IMAGE_ASPECT_RATIO_KEY) {
      return {
        initialImagePromptKey: requested,
        selectedImagePromptKey: requested,
        selectedImageAspectRatioKey: requestedAspect,
      };
    }

    const { article, seed, renderSelectionPrompt } = articleImagePresetSelectionContext(input, deps);
    const rows = requested === "auto"
      ? imagePresetRowsForPrompt(seed)
      : imagePresetRowsForPrompt(seed, { onlyPresetKeys: new Set([requested]) });
    const aspectRows = aspectRatioRowsForPrompt(
      deps,
      requestedAspect,
      requested === "auto" ? [] : rows,
    );
    if (rows.length === 0) throw new Error(`unknown image preset: ${requested}`);
    if (aspectRows.length === 0) throw new Error(`unknown image aspect ratio: ${requestedAspect}`);
    const selected = await selectPresetWithRetries({
      articleSlug: article.slug,
      deps,
      rows,
      aspectRows,
      renderSelectionPrompt,
      baseSelectionGuidance: [
        requested === "auto" ? "" : `The preset is fixed to "${requested}"; choose only the image aspect ratio.`,
        requestedAspect === AUTO_IMAGE_ASPECT_RATIO_KEY ? "" : `The aspect ratio is fixed to "${requestedAspect}"; choose only the preset.`,
      ].filter(Boolean).join("\n"),
      requireAspect: requestedAspect === AUTO_IMAGE_ASPECT_RATIO_KEY,
      invalidEvent: "article_image.preset_selection_invalid",
    });
    deps.logger.info("article_image.preset_selected", {
      slug: article.slug,
      presetKey: selected.presetKey,
      aspectRatioKey: selected.aspectRatioKey ?? requestedAspect,
      reason: selected.reason,
      aspectRatioReason: selected.aspectRatioReason,
    });
    return {
      initialImagePromptKey: selected.presetKey,
      initialImagePromptReason: selected.reason,
      selectedImagePromptKey: selected.presetKey,
      selectedImagePromptReason: selected.reason,
      selectedImageAspectRatioKey: selected.aspectRatioKey ?? requestedAspect,
      selectedImageAspectRatioReason: selected.aspectRatioReason,
    };
  },
});

export const selectChallengerArticleImagePresetNode = defineNode({
  name: "llm.select_image_preset_challenger",
  kind: "llm",
  description: "Choose the best article-image preset challenger to compare with the initial selection.",
  reads: ["input", "initialImagePromptKey"] as const,
  writes: ["challengerImagePromptKey", "challengerImagePromptReason"] as const,
  async run({ input, initialImagePromptKey }, deps: PipelineDeps) {
    if (
      normalizePresetKey(input.imagePromptKey) !== "auto" ||
      !initialImagePromptKey
    ) return {};

    const { article, seed, renderSelectionPrompt } = articleImagePresetSelectionContext(input, deps);
    const rows = imagePresetRowsForPrompt(seed, {
      excludePresetKeys: new Set([initialImagePromptKey]),
    });
    const requestedAspect = normalizeArticleImageAspectRatioKey(input.imageAspectRatioKey);
    const aspectRows = aspectRatioRowsForPrompt(deps, requestedAspect);
    if (rows.length === 0) return {};
    const selected = await selectPresetWithRetries({
      articleSlug: article.slug,
      deps,
      rows,
      aspectRows,
      renderSelectionPrompt,
      baseSelectionGuidance: `The previous pass chose "${initialImagePromptKey}". This pass considers the alternative presets listed below. Choose the strongest alternative preset from the list.`,
      requireAspect: false,
      invalidEvent: "article_image.preset_challenger_invalid",
    });
    deps.logger.info("article_image.preset_challenger_selected", {
      slug: article.slug,
      presetKey: selected.presetKey,
      reason: selected.reason,
    });
    return { challengerImagePromptKey: selected.presetKey, challengerImagePromptReason: selected.reason };
  },
});

export const judgeArticleImagePresetFinalNode = defineNode({
  name: "llm.select_image_preset_final",
  kind: "llm",
  description: "Choose between the first-pass preset and its strongest challenger for final automatic preset selection.",
  reads: ["input", "initialImagePromptKey", "challengerImagePromptKey"] as const,
  writes: [
    "selectedImagePromptKey",
    "selectedImagePromptReason",
    "selectedImageAspectRatioKey",
    "selectedImageAspectRatioReason",
  ] as const,
  async run({ input, initialImagePromptKey, challengerImagePromptKey }, deps: PipelineDeps) {
    if (
      normalizePresetKey(input.imagePromptKey) !== "auto" ||
      !initialImagePromptKey ||
      !challengerImagePromptKey
    ) {
      return {};
    }

    const { article, seed, renderSelectionPrompt } = articleImagePresetSelectionContext(input, deps);
    const rows = imagePresetRowsForPrompt(seed, {
      onlyPresetKeys: new Set([initialImagePromptKey, challengerImagePromptKey]),
    });
    const requestedAspect = normalizeArticleImageAspectRatioKey(input.imageAspectRatioKey);
    const aspectRows = aspectRatioRowsForPrompt(deps, requestedAspect);
    const selected = await selectPresetWithRetries({
      articleSlug: article.slug,
      deps,
      rows,
      aspectRows,
      renderSelectionPrompt,
      baseSelectionGuidance: `The first pass chose "${initialImagePromptKey}". The strongest challenger is "${challengerImagePromptKey}". Choose between only "${initialImagePromptKey}" and "${challengerImagePromptKey}". Pick "${challengerImagePromptKey}" when it fits the article theme well enough to add useful variety. Pick "${initialImagePromptKey}" when it gives the clearer, more accurate, and more representative image for the article's main subject.`,
      requireAspect: false,
      invalidEvent: "article_image.preset_final_invalid",
    });
    deps.logger.info("article_image.preset_final_selected", {
      slug: article.slug,
      challengerPresetKey: challengerImagePromptKey,
      presetKey: selected.presetKey,
      aspectRatioKey: selected.aspectRatioKey,
      reason: selected.reason,
      aspectRatioReason: selected.aspectRatioReason,
    });
    return {
      selectedImagePromptKey: selected.presetKey,
      selectedImagePromptReason: selected.reason,
      ...(selected.aspectRatioKey ? { selectedImageAspectRatioKey: selected.aspectRatioKey } : {}),
      ...(selected.aspectRatioReason ? { selectedImageAspectRatioReason: selected.aspectRatioReason } : {}),
    };
  },
});

export const generateArticleImageAttachmentNode = defineNode({
  name: "image.generate_attach",
  kind: "write",
  description: "Generate a headline image, ingest it, and attach it to the article.",
  reads: ["input", "selectedImagePromptKey", "selectedImageAspectRatioKey"] as const,
  writes: ["imageGenerationResult"] as const,
  async run({ input, selectedImagePromptKey, selectedImageAspectRatioKey }, deps: PipelineDeps) {
    if (!input.slug) {
      throw new Error("image generation requires an article slug");
    }
    if (!deps.generateArticleImageAttachment) {
      throw new Error("image generation dependency is not wired");
    }
    const result = await deps.generateArticleImageAttachment(
      input.slug,
      input.imageReplace === true,
      selectedImagePromptKey ?? input.imagePromptKey,
      selectedImageAspectRatioKey ?? input.imageAspectRatioKey,
    );
    return { imageGenerationResult: result };
  },
});
