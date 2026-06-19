import { defineNode } from "../runtime/nodeFactory";
import type { PipelineDeps } from "../deps";
import { getArticleByLookup, getArticleInfobox } from "../../db";
import { stripJsonFences } from "../../prompts";
import { readPromptFile, listArticleImagePresetFiles } from "../../promptEditor";
import { stripTopLevelSections, summaryMarkdownFromArticle } from "../../markdown";

const DEFAULT_PRESET_PROMPT_KEY = "photo";
const PRESET_SELECTION_MAX_ATTEMPTS = 3;

function normalizePresetKey(value: string | undefined): string {
  const key = (value ?? "").trim();
  if (!key || key === "default" || key === "article_image" || key === DEFAULT_PRESET_PROMPT_KEY) return "default";
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
}

function promptKeyForPresetKey(presetKey: string): string {
  if (presetKey === "default") return DEFAULT_PRESET_PROMPT_KEY;
  return presetKey;
}

function imagePresetRowsForPrompt(
  seed: string,
  options: { includeDefault?: boolean; onlyPresetKeys?: Set<string> } = {},
): PresetPromptRow[] {
  const includeDefault = options.includeDefault !== false;
  const defaultPrompt = readPromptFile("runnable", "article_image");
  const rows = [
    ...listArticleImagePresetFiles().map((preset) => ({
      key: promptKeyForPresetKey(preset.key),
      presetKey: preset.key,
      description: promptSummary(`${preset.system}\n${preset.user}`),
    })),
    ...(includeDefault
      ? [
          {
            key: DEFAULT_PRESET_PROMPT_KEY,
            presetKey: "default",
            description: defaultPrompt
              ? promptSummary(`${defaultPrompt.system}\n${defaultPrompt.user}`)
              : "Photoreal editorial/documentary article image.",
          },
        ]
      : []),
  ].filter((row) => !options.onlyPresetKeys || options.onlyPresetKeys.has(row.presetKey));
  return shuffleRowsForSeed(rows, seed);
}

function formatImagePresetRows(rows: PresetPromptRow[]): string {
  return rows.map((row) => `- ${row.key}: ${row.description}`).join("\n");
}

function allowedPresetKeys(rows: PresetPromptRow[]): Map<string, string> {
  const allowed = new Map<string, string>();
  for (const row of rows) {
    allowed.set(row.key, row.presetKey);
    allowed.set(row.presetKey, row.presetKey);
  }
  return allowed;
}

function oneSentenceReason(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.replace(/\s+/g, " ").trim();
  if (!trimmed) return undefined;
  const sentence = trimmed.match(/^.*?[.!?](?:\s|$)/)?.[0]?.trim() ?? trimmed;
  return sentence.slice(0, 280);
}

function parseSelectedPreset(raw: string, allowed: Map<string, string>): { presetKey: string; reason?: string } | null {
  const cleaned = stripJsonFences(raw).trim();
  try {
    const parsed = JSON.parse(cleaned) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const obj = parsed as { presetKey?: unknown; key?: unknown; reason?: unknown };
    const rawKey = obj.presetKey ?? obj.key;
    if (typeof rawKey !== "string") return null;
    const key = normalizePresetKey(rawKey);
    const presetKey = allowed.get(key);
    return presetKey ? { presetKey, reason: oneSentenceReason(obj.reason) } : null;
  } catch {
    return null;
  }
}

async function selectPresetWithRetries(options: {
  articleSlug: string;
  deps: PipelineDeps;
  rows: PresetPromptRow[];
  renderSelectionPrompt: (rows: PresetPromptRow[], selectionGuidance: string) => ReturnType<PipelineDeps["prompts"]["render"]>;
  baseSelectionGuidance: string;
  invalidEvent: string;
}): Promise<{ presetKey: string; reason?: string }> {
  const allowed = allowedPresetKeys(options.rows);
  let lastRaw = "";
  for (let attempt = 1; attempt <= PRESET_SELECTION_MAX_ATTEMPTS; attempt += 1) {
    const retryGuidance = attempt === 1
      ? options.baseSelectionGuidance
      : [
          options.baseSelectionGuidance,
          `Previous response was rejected because it was not valid JSON in the required shape. Return exactly {"presetKey":"one_allowed_key","reason":"one short sentence"} with no extra text. Attempt ${attempt} of ${PRESET_SELECTION_MAX_ATTEMPTS}.`,
        ].filter(Boolean).join("\n\n");
    const rendered = options.renderSelectionPrompt(options.rows, retryGuidance);
    const raw = await options.deps.llm.chat(rendered.role, rendered.system, rendered.user, {
      thinking: rendered.thinking,
      jsonMode: rendered.json,
    });
    lastRaw = raw;
    const selected = parseSelectedPreset(raw, allowed);
    if (selected) return selected;
    options.deps.logger.warn(options.invalidEvent, {
      slug: options.articleSlug,
      attempt,
      maxAttempts: PRESET_SELECTION_MAX_ATTEMPTS,
      raw: raw.slice(0, 500),
    });
  }
  throw new Error(
    `article image preset selection returned invalid JSON after ${PRESET_SELECTION_MAX_ATTEMPTS} attempts: ${lastRaw.slice(0, 160)}`,
  );
}

function articleImagePresetSelectionContext(input: { slug?: string }, deps: PipelineDeps) {
  if (!input.slug) throw new Error("image preset selection requires an article slug");

  const article = getArticleByLookup(deps.db, input.slug);
  if (!article) throw new Error("article not found");

  const infobox = getArticleInfobox(deps.db, article.slug);
  const sidebarContext = infobox
    ? [
        infobox.title,
        infobox.subtitle ?? "",
        ...infobox.groups.flatMap((group) => [
          group.label,
          ...group.rows.flatMap((row) => [row.label, row.value]),
        ]),
      ]
        .filter(Boolean)
        .join("\n")
        .slice(0, 1600)
    : "";
  const articleBody = stripTopLevelSections(article.markdown, ["References", "See also"]);
  const seed = `${article.slug}:${article.title}`;
  const renderSelectionPrompt = (rows: PresetPromptRow[], selectionGuidance: string) =>
    deps.prompts.render("article_image_preset_selection", {
      requested_title: article.title,
      summary: article.summaryMarkdown || summaryMarkdownFromArticle(article.markdown),
      article_excerpt: articleBody.slice(0, 2400),
      sidebar_context: sidebarContext,
      available_presets: formatImagePresetRows(rows),
      selection_guidance: selectionGuidance,
    });
  return { article, seed, renderSelectionPrompt };
}

export const selectArticleImagePresetNode = defineNode({
  name: "llm.select_image_preset_initial",
  kind: "llm",
  description: "Choose the initial article-image preset when automatic preset selection is requested.",
  reads: ["input"] as const,
  writes: ["initialImagePromptKey", "initialImagePromptReason", "selectedImagePromptKey", "selectedImagePromptReason"] as const,
  async run({ input }, deps: PipelineDeps) {
    const requested = normalizePresetKey(input.imagePromptKey);
    if (requested !== "auto") return { initialImagePromptKey: requested, selectedImagePromptKey: requested };

    const { article, seed, renderSelectionPrompt } = articleImagePresetSelectionContext(input, deps);
    const rows = imagePresetRowsForPrompt(seed);
    const selected = await selectPresetWithRetries({
      articleSlug: article.slug,
      deps,
      rows,
      renderSelectionPrompt,
      baseSelectionGuidance: "",
      invalidEvent: "article_image.preset_selection_invalid",
    });
    deps.logger.info("article_image.preset_selected", {
      slug: article.slug,
      presetKey: selected.presetKey,
      reason: selected.reason,
    });
    return {
      initialImagePromptKey: selected.presetKey,
      initialImagePromptReason: selected.reason,
      selectedImagePromptKey: selected.presetKey,
      selectedImagePromptReason: selected.reason,
    };
  },
});

export const selectSpecializedArticleImagePresetNode = defineNode({
  name: "llm.select_image_preset_challenger",
  kind: "llm",
  description: "Choose the best specialized article-image preset challenger when the initial selection picked photo.",
  reads: ["input", "initialImagePromptKey"] as const,
  writes: ["specializedImagePromptKey", "specializedImagePromptReason"] as const,
  async run({ input, initialImagePromptKey }, deps: PipelineDeps) {
    if (normalizePresetKey(input.imagePromptKey) !== "auto" || initialImagePromptKey !== "default") return {};

    const { article, seed, renderSelectionPrompt } = articleImagePresetSelectionContext(input, deps);
    const rows = imagePresetRowsForPrompt(seed, { includeDefault: false });
    if (rows.length === 0) return {};
    const selected = await selectPresetWithRetries({
      articleSlug: article.slug,
      deps,
      rows,
      renderSelectionPrompt,
      baseSelectionGuidance: `The previous pass chose ${DEFAULT_PRESET_PROMPT_KEY}. For this pass, ${DEFAULT_PRESET_PROMPT_KEY} is not an allowed key; choose the best fitting specialized preset from the list.`,
      invalidEvent: "article_image.preset_challenger_invalid",
    });
    deps.logger.info("article_image.preset_challenger_selected", {
      slug: article.slug,
      presetKey: selected.presetKey,
      reason: selected.reason,
    });
    return { specializedImagePromptKey: selected.presetKey, specializedImagePromptReason: selected.reason };
  },
});

export const judgeArticleImagePresetDefaultNode = defineNode({
  name: "llm.select_image_preset_final",
  kind: "llm",
  description: "Choose between photo and the best specialized challenger for final automatic preset selection.",
  reads: ["input", "initialImagePromptKey", "specializedImagePromptKey"] as const,
  writes: ["selectedImagePromptKey", "selectedImagePromptReason"] as const,
  async run({ input, initialImagePromptKey, specializedImagePromptKey }, deps: PipelineDeps) {
    if (
      normalizePresetKey(input.imagePromptKey) !== "auto" ||
      initialImagePromptKey !== "default" ||
      !specializedImagePromptKey
    ) {
      return {};
    }

    const { article, seed, renderSelectionPrompt } = articleImagePresetSelectionContext(input, deps);
    const rows = imagePresetRowsForPrompt(seed, {
      onlyPresetKeys: new Set(["default", specializedImagePromptKey]),
    });
    const selected = await selectPresetWithRetries({
      articleSlug: article.slug,
      deps,
      rows,
      renderSelectionPrompt,
      baseSelectionGuidance: `The first pass chose ${DEFAULT_PRESET_PROMPT_KEY}. The strongest specialized challenger is "${promptKeyForPresetKey(specializedImagePromptKey)}". Choose between only ${DEFAULT_PRESET_PROMPT_KEY} and "${promptKeyForPresetKey(specializedImagePromptKey)}". Pick "${promptKeyForPresetKey(specializedImagePromptKey)}" if it fits the article theme well enough to add useful variety; pick ${DEFAULT_PRESET_PROMPT_KEY} if "${promptKeyForPresetKey(specializedImagePromptKey)}" would distract from, flatten, or misrepresent the article.`,
      invalidEvent: "article_image.preset_final_invalid",
    });
    deps.logger.info("article_image.preset_final_selected", {
      slug: article.slug,
      challengerPresetKey: specializedImagePromptKey,
      presetKey: selected.presetKey,
      reason: selected.reason,
    });
    return { selectedImagePromptKey: selected.presetKey, selectedImagePromptReason: selected.reason };
  },
});

export const generateArticleImageAttachmentNode = defineNode({
  name: "image.generate_attach",
  kind: "write",
  description: "Generate a headline image, ingest it, and attach it to the article.",
  reads: ["input", "selectedImagePromptKey"] as const,
  writes: ["imageGenerationResult"] as const,
  async run({ input, selectedImagePromptKey }, deps: PipelineDeps) {
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
    );
    return { imageGenerationResult: result };
  },
});
