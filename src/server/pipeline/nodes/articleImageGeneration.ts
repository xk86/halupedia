import { defineNode } from "../runtime/nodeFactory";
import type { PipelineDeps } from "../deps";
import { getArticleByLookup, getArticleInfobox } from "../../db";
import { stripJsonFences } from "../../prompts";
import { readPromptFile, listArticleImagePresetFiles } from "../../promptEditor";
import { stripTopLevelSections, summaryMarkdownFromArticle } from "../../markdown";

function normalizePresetKey(value: string | undefined): string {
  const key = (value ?? "").trim();
  if (!key || key === "default" || key === "article_image") return "default";
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

function availableImagePresetsForPrompt(): string {
  const defaultPrompt = readPromptFile("runnable", "article_image");
  const rows = [
    {
      key: "default",
      description: defaultPrompt
        ? promptSummary(`${defaultPrompt.system}\n${defaultPrompt.user}`)
        : "Default photoreal editorial/documentary article image.",
    },
    ...listArticleImagePresetFiles().map((preset) => ({
      key: preset.key,
      description: promptSummary(`${preset.system}\n${preset.user}`),
    })),
  ];
  return rows.map((row) => `- ${row.key}: ${row.description}`).join("\n");
}

function parseSelectedPreset(raw: string, allowed: Set<string>): string | null {
  const cleaned = stripJsonFences(raw).trim();
  try {
    const parsed = JSON.parse(cleaned) as { presetKey?: unknown; key?: unknown };
    const key = normalizePresetKey(String(parsed.presetKey ?? parsed.key ?? ""));
    return allowed.has(key) ? key : null;
  } catch {
    const tokens = cleaned.match(/[a-z0-9_]+/gi) ?? [];
    for (const token of tokens) {
      const key = normalizePresetKey(token);
      if (allowed.has(key)) return key;
    }
    return null;
  }
}

export const selectArticleImagePresetNode = defineNode({
  name: "llm.select_image_preset",
  kind: "llm",
  description: "Choose the most fitting article-image preset when automatic preset selection is requested.",
  reads: ["input"] as const,
  writes: ["selectedImagePromptKey"] as const,
  async run({ input }, deps: PipelineDeps) {
    const requested = normalizePresetKey(input.imagePromptKey);
    if (requested !== "auto") return { selectedImagePromptKey: requested };
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
    const availablePresets = availableImagePresetsForPrompt();
    const allowed = new Set(
      availablePresets
        .split("\n")
        .map((line) => line.match(/^- ([a-z0-9_]+):/i)?.[1])
        .filter((key): key is string => Boolean(key)),
    );
    const rendered = deps.prompts.render("article_image_preset_selection", {
      requested_title: article.title,
      summary: article.summaryMarkdown || summaryMarkdownFromArticle(article.markdown),
      article_excerpt: articleBody.slice(0, 2400),
      sidebar_context: sidebarContext,
      available_presets: availablePresets,
    });
    const raw = await deps.llm.chat(rendered.role, rendered.system, rendered.user, {
      thinking: rendered.thinking,
      jsonMode: rendered.json,
    });
    const selected = parseSelectedPreset(raw, allowed);
    if (!selected) {
      deps.logger.warn("article_image.preset_selection_invalid", {
        slug: article.slug,
        raw: raw.slice(0, 500),
      });
      return { selectedImagePromptKey: "default" };
    }
    deps.logger.info("article_image.preset_selected", {
      slug: article.slug,
      presetKey: selected,
    });
    return { selectedImagePromptKey: selected };
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
