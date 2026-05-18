/**
 * Did You Know (DYK) fact generation and normalisation helpers.
 */

import type { LlmClient } from "./llm";
import { getPrompt, renderTemplate, stripJsonFences } from "./prompts";
import { stripTopLevelSections } from "./markdown";
import { slugify } from "./slug";
import { escapeRegExp } from "./selectionUtils";
import type { loadConfig } from "./config";

/**
 * Ensure a DYK fact string contains a link back to the source article.
 *
 * Links use the plain slug form `[Title](/${slug})` so navigation goes
 * through the server's `/:slug` handler (which normalises and redirects as
 * needed) rather than hard-coding the wiki-path form. Halu links are not
 * used in DYK — they exist for article seeding only.
 *
 * Priority:
 *   1. Fact already has a link to this slug → return unchanged.
 *   2. Halu link present → convert to a plain slug link.
 *   3. Title appears as plain text → linkify the first occurrence.
 *   4. No mention at all → prepend a link attribution.
 */
export function ensureDykHasSourceLink(
  fact: string,
  slug: string,
  title: string,
): string {
  const slugLink = `[${title}](/${slug})`;
  const slugPattern = new RegExp(`\\(/${escapeRegExp(slug)}\\)`, "i");

  if (slugPattern.test(fact)) return fact;

  const haluPattern = new RegExp(`\\(halu:${escapeRegExp(slug)}[\\s"')/]`, "i");
  if (haluPattern.test(fact)) {
    return fact.replace(
      new RegExp(`\\[([^\\]]+)\\]\\(halu:${escapeRegExp(slug)}[^)]*\\)`, "gi"),
      `[$1](/${slug})`,
    );
  }

  const titlePattern = new RegExp(
    `(?<![\\[(/])${escapeRegExp(title)}(?![\\]])`,
    "i",
  );
  const match = titlePattern.exec(fact);
  if (match) {
    return (
      fact.slice(0, match.index) +
      slugLink +
      fact.slice(match.index + match[0].length)
    );
  }

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
  return fact ? `... ${fact}.` : "";
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
