/**
 * Did You Know (DYK) fact generation and normalisation helpers.
 */

import type { LlmClient } from "./llm";
import { getPrompt, renderTemplate, stripJsonFences } from "./prompts";
import { stripTopLevelSections } from "./markdown";
import { slugify } from "./slug";
import { escapeRegExp } from "./selectionUtils";
import type { loadConfig } from "./config";

const MARKDOWN_LINK_RE = /\[([^\]]+)\]\(([^)]+)\)/g;

function normalizeDykLinks(fact: string): string {
  return fact.replace(MARKDOWN_LINK_RE, (match, label: string, target: string) => {
    const trimmedTarget = target.trim();
    if (!trimmedTarget.toLowerCase().startsWith("halu:")) return match;

    const rawSlug = trimmedTarget.slice("halu:".length).split(/[\s"')/]/u)[0] ?? "";
    const slug = slugify(rawSlug);
    return slug ? `[${label}](/${slug})` : label;
  });
}

function hasMarkdownLink(fact: string): boolean {
  MARKDOWN_LINK_RE.lastIndex = 0;
  return MARKDOWN_LINK_RE.test(fact);
}

/**
 * Ensure a DYK fact string contains a link back to the source article.
 *
 * Links use the plain slug form `[Title](/${slug})` so navigation goes
 * through the server's `/:slug` handler (which normalises and redirects as
 * needed) rather than hard-coding the wiki-path form. Halu links are not
 * used in DYK — they exist for article seeding only.
 *
 * Priority:
 *   1. Convert halu links to plain slug links.
 *   2. If any Markdown link is already present, preserve the fact.
 *   3. No link at all → prepend a source link attribution.
 */
export function ensureDykHasSourceLink(
  fact: string,
  slug: string,
  title: string,
): string {
  fact = normalizeDykLinks(fact);
  if (hasMarkdownLink(fact)) return fact;

  const slugLink = `[${title}](/${slug})`;
  const slugPattern = new RegExp(`\\(/${escapeRegExp(slug)}\\)`, "i");

  if (slugPattern.test(fact)) return fact;

  if (fact.startsWith("... ")) {
    return `... ${slugLink}: ${fact.slice("... ".length)}`;
  }
  return `${slugLink} — ${fact}`;
}

export function normalizeHomepageFact(raw: string): string {
  let fact = stripJsonFences(raw)
    .replace(/^["']|["']$/g, "")
    .replace(/\s+/g, " ")
    .trim();
  fact = fact.replace(/^did you know(?:\.\.\.|\s+that|\s*)/i, "");
  fact = fact.replace(/^[.?!\s]+/, "");
  fact = fact.replace(/[.?!\s]+$/, "");
  return fact ? `... ${fact}?` : "";
}

export async function generateDidYouKnowFact(
  llm: LlmClient,
  lightLlm: LlmClient,
  promptConfig: ReturnType<typeof loadConfig>["prompts"],
  article: { slug: string; title: string; markdown: string; plainText?: string },
): Promise<string> {
  const prompt = getPrompt(promptConfig, "did_you_know");
  const selectedLlm = prompt.model === "light" ? lightLlm : llm;
  const articleTitleMarkdown = `[${article.title}](/${article.slug})`;
  const raw = await selectedLlm.chat(
    prompt.system,
    renderTemplate(prompt.user, {
      article_title: articleTitleMarkdown,
      article_excerpt: stripTopLevelSections(article.markdown, [
        "References",
        "See also",
      ]).slice(0, 6000),
      slug: article.slug,
      requested_title: article.title,
      current_article: article.markdown.slice(0, 12000),
      previous_summary: "",
      summary_feedback: "",
      rag_context: "",
      link_hints: "",
      related_titles: "",
      parent_comment: "",
      selected_text: "",
      edit_instructions: "",
      full_article: article.markdown.slice(0, 12000),
      dyk_articles: "",
    }),
    { thinking: prompt.thinking },
  );
  return normalizeHomepageFact(raw);
}
