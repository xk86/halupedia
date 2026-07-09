export interface PromptUsage {
  description: string;
  usedBy: string[];
}

const RUNNABLE_PROMPT_USAGE: Record<string, PromptUsage> = {
  article: {
    description:
      "Writes a new article body from the requested title and retrieved context.",
    usedBy: ["article.generate"],
  },
  article_image: {
    description:
      "Builds the final image-generation instructions for the selected headline-image preset.",
    usedBy: ["article.image_generate"],
  },
  article_image_preset_selection: {
    description:
      "Chooses the headline-image preset and aspect ratio from article context.",
    usedBy: ["article.image_generate"],
  },
  article_quick_edit: {
    description:
      "Applies a targeted rewrite to selected text or a single article section.",
    usedBy: ["article.rewrite"],
  },
  article_refresh: {
    description:
      "Refreshes an existing article body with newly retrieved local context.",
    usedBy: ["article.refresh"],
  },
  article_rewrite: {
    description:
      "Rewrites an existing article, section, or selection from edit instructions.",
    usedBy: ["article.rewrite"],
  },
  article_summary: {
    description:
      "Produces the concise summary stored with an article and used by retrieval.",
    usedBy: ["article.generate", "article.post_process", "article.summary"],
  },
  comment: {
    description:
      "Legacy fictional-comment prompt retained in configuration; no current runtime call site uses it.",
    usedBy: [],
  },
  did_you_know: {
    description:
      "Generates a front-page Did You Know fact from a source article.",
    usedBy: ["homepage.refresh"],
  },
  identity: {
    description:
      "Creates a persistent fictional commenter identity for the local discussion system.",
    usedBy: ["comments"],
  },
  image_caption: {
    description:
      "Writes the short article-specific caption shown with a stored image.",
    usedBy: ["article.post_process", "image.caption"],
  },
  image_description: {
    description:
      "Describes an uploaded image before the article-specific caption is generated.",
    usedBy: ["image.caption"],
  },
  infobox: {
    description: "Extracts the structured infobox stored beside an article.",
    usedBy: ["article.post_process", "admin.infobox_regenerate"],
  },
  link_recheck: {
    description:
      "Legacy whole-article link-check prompt retained in configuration; no current runtime call site uses it.",
    usedBy: [],
  },
  link_repair: {
    description:
      "Legacy link-repair prompt retained in configuration; no current runtime call site uses it.",
    usedBy: [],
  },
  link_selection: {
    description:
      "Legacy link-selection prompt retained in configuration; deterministic selection logic is used now.",
    usedBy: [],
  },
  link_suggestion: {
    description:
      "Proposes an internal-link target and hidden description for selected article text.",
    usedBy: ["article.link_suggestion"],
  },
  ontology: {
    description:
      "Extracts high-confidence ontology claims from an article when LLM extraction is enabled.",
    usedBy: ["article.post_process"],
  },
  random_page: {
    description:
      "Chooses the title and slug for a random-page request before article generation.",
    usedBy: ["random.page"],
  },
  see_also: {
    description:
      "Generates related-entry suggestions for an article's See Also section.",
    usedBy: ["article.post_process"],
  },
  todays_news: {
    description:
      "Writes the daily front-page news digest from the current lore packet.",
    usedBy: ["homepage.refresh"],
  },
};

const SHARED_PROMPT_USAGE: Record<string, PromptUsage> = {
  linking_guide: {
    description:
      "Shared constraints for choosing compact, canonical internal-link targets.",
    usedBy: ["article.link_suggestion"],
  },
  rewrite_scope_full: {
    description: "Shared output contract for full-article rewrites.",
    usedBy: ["article.rewrite"],
  },
  rewrite_scope_partial: {
    description: "Shared output contract for section and selection rewrites.",
    usedBy: ["article.rewrite"],
  },
  shared_article_rules: {
    description:
      "Shared article tone, structure, reference, and linking rules.",
    usedBy: ["article.generate", "article.refresh", "article.rewrite"],
  },
  shared_link_format: {
    description:
      "Shared formatting and placement rules for halu: and ref: links.",
    usedBy: ["article.generate", "article.refresh", "article.rewrite", "homepage.refresh"],
  },
  shared_rewrite_modes: {
    description:
      "Shared instruction fragments for subtle, aggressive, and quick rewrite modes.",
    usedBy: ["article.refresh", "article.rewrite"],
  },
  shared_tone: {
    description:
      "Base tone and content policy included by most model-facing prompts.",
    usedBy: ["shared prompt include"],
  },
};

const UNKNOWN_USAGE: PromptUsage = {
  description: "User-defined prompt with no registered runtime description.",
  usedBy: [],
};

export function getPromptUsage(
  scope: "runnable" | "shared",
  key: string,
): PromptUsage {
  return (
    (scope === "shared" ? SHARED_PROMPT_USAGE : RUNNABLE_PROMPT_USAGE)[key] ??
    UNKNOWN_USAGE
  );
}
