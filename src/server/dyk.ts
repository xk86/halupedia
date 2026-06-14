/**
 * Did You Know (DYK) fact generation and normalisation helpers.
 */

import type { LlmRouter } from "./llm";
import { getPrompt, renderTemplate, stripJsonFences } from "./prompts";
import { stripTopLevelSections } from "./markdown";
import { slugify } from "./slug";
import type { loadConfig } from "./config";
import { parseMarkdownLinks } from "./text/markdownLinkParser";
import { normalizeMarkdownLinks } from "./text/linkNormalize";
import { buildHaluLink } from "./text/links/haluLinks";

/**
 * Ensure a DYK fact string contains a link back to the source article.
 *
 * DYK is markdown, so it uses the same internal markdown-link parser as the
 * article pipeline. Fallback links are accepted as input, but only the source
 * article link survives; unrelated links are stripped to plain label text.
 */
export function ensureDykHasSourceLink(
  fact: string,
  slug: string,
  title: string,
): string {
  const sourceSlug = slugify(slug);
  let normalized = normalizeMarkdownLinks(fact, "dyk").markdown;
  const parsed = parseMarkdownLinks(normalized).links;
  let output = "";
  let cursor = 0;
  let hasSourceLink = false;

  for (const link of parsed) {
    const linkSlug = slugify(link.slug ?? "");
    const isSource = linkSlug === sourceSlug;
    output += normalized.slice(cursor, link.start);
    if (isSource && !hasSourceLink) {
      output += buildHaluLink(link.label.trim() || title, sourceSlug, title);
      hasSourceLink = true;
    } else {
      output += link.label.trim();
    }
    cursor = link.end;
  }
  output += normalized.slice(cursor);
  normalized = output;

  if (hasSourceLink) return normalized;

  const sourceLink = buildHaluLink(title, sourceSlug, title);

  // Try to wrap the first unlinked occurrence of the title in the text.
  const titleEscaped = title.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const titlePattern = new RegExp(
    `(?<![\\p{L}\\p{N}])(${titleEscaped})(?![\\p{L}\\p{N}])`,
    "iu",
  );
  const existingLinkRanges = parseMarkdownLinks(normalized).links.map((l) => ({
    start: l.start,
    end: l.end,
  }));
  const titleMatch = titlePattern.exec(normalized);
  if (
    titleMatch &&
    !existingLinkRanges.some(
      (r) => titleMatch.index >= r.start && titleMatch.index < r.end,
    )
  ) {
    return (
      normalized.slice(0, titleMatch.index) +
      buildHaluLink(title, sourceSlug, title) +
      normalized.slice(titleMatch.index + titleMatch[0].length)
    );
  }

  //TODO: we do this too much- should fix w prompting or something.
  // Title not in text — restructure as "... that according to [Title], rest of fact?"
  // so the link is always the grammatical subject, never prepended with a colon.
  const stripped = normalized
    .replace(/^\.\.\.\s*that\s+/i, "")
    .replace(/^\.\.\.\s*/i, "")
    .replace(/[.?!\s]+$/, "")
    .trim();
  return `... that according to ${sourceLink}, ${stripped}?`;
}

export function normalizeHomepageFact(raw: string): string {
  // todo: use jsonrepair to fix json, not bespoke regexp
  let fact = stripJsonFences(raw)
    .replace(/^["']|["']$/g, "")
    .replace(/\s+/g, " ")
    .trim();
  fact = fact.replace(/^did you know(?:\.\.\.|\s+that|\s*)/i, "");
  fact = fact.replace(/^\.\.\.\s*/i, "");
  fact = fact.replace(/^that\s+/i, "");
  fact = fact.replace(/^[.?!\s]+/, "");
  fact = fact.replace(/[.?!\s]+$/, "");
  return fact ? `... that ${fact}?` : "";
}

export async function generateDidYouKnowFact(
  llm: LlmRouter,
  promptConfig: ReturnType<typeof loadConfig>["prompts"],
  article: { slug: string; title: string; markdown: string; plainText?: string },
): Promise<string> {
  const prompt = getPrompt(promptConfig, "did_you_know");
  const role = prompt.model ?? "heavy";
  const articleTitleMarkdown = buildHaluLink(article.title, article.slug, article.title);
  const raw = await llm.chat(
    role,
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
