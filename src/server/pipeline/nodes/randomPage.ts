/**
 * Node for the random.page workflow: ask the model to choose a (possibly new)
 * article to navigate to, using existing articles as inspiration. Lives in a
 * workflow purely so the call is traced/timed alongside the article flows
 * instead of being an invisible one-off llm.chat.
 */

import { defineNode } from "../runtime/nodeFactory";
import type { PipelineDeps } from "../deps";
import { renderTemplate } from "../../prompts";
import { stripJsonFences } from "../../prompts";
import {
  isSlugForm,
  isSlugStyleWikiSegment,
  normalizeCanonicalTitle,
  slugToTitle,
  slugify,
  wikiSegmentToRequestedTitle,
} from "../../slug";

/** Parse the model's random-page response (JSON, a wiki path, or bare text)
 *  into a {title, slug} pair. Mirrors the legacy inline parser. */
export function normalizeRandomPageChoice(raw: string): { title: string; slug: string } {
  const cleaned = stripJsonFences(raw).trim();
  let title = "";
  let slug = "";
  try {
    const json = JSON.parse(cleaned) as { title?: unknown; slug?: unknown };
    let rawTitle = String(json.title ?? "").trim();
    // A slug-shaped title ("archive-rotation-protocol") must expand to words
    // BEFORE canonical capitalization — capitalizing first would turn it into
    // a hyphenated title that now slugs with named dashes (a different article).
    if (isSlugForm(rawTitle.normalize("NFC"))) rawTitle = slugToTitle(rawTitle);
    title = normalizeCanonicalTitle(rawTitle);
    slug = slugify(String(json.slug ?? ""));
  } catch {
    const wikiMatch = cleaned.match(/(?:^|[/\s"'])wiki\/([^\n"'<>#?]+)/i);
    const candidate = (wikiMatch?.[1] ?? cleaned.split(/\n/)[0] ?? "")
      .replace(/^["'`/]+|["'`/]+$/g, "")
      .replace(/[?#].*$/, "")
      .trim();
    title = normalizeCanonicalTitle(wikiSegmentToRequestedTitle(candidate));
    slug = slugify(title);
  }
  if (title && slug && slugify(title) === slug && isSlugStyleWikiSegment(title)) {
    title = wikiSegmentToRequestedTitle(title);
  }
  if (!title && slug) title = normalizeCanonicalTitle(slugToTitle(slug));
  if (!slug && title) slug = slugify(title);
  if (!title || !slug) throw new Error("random page prompt returned an empty title or slug");
  return { title, slug };
}

export const chooseRandomPageNode = defineNode({
  name: "random_page.llm.choose",
  kind: "llm",
  description: "Ask the model to pick a random article title/slug from inspiration.",
  reads: ["input"] as const,
  writes: ["randomPageChoice"] as const,
  async run({ input }, deps: PipelineDeps) {
    const entry = deps.prompts.get("random_page");
    const prompt = entry.resolved;
    const role = prompt.model ?? "heavy";
    const inspiration = input.inspiration ?? [];
    const raw = await deps.llm.chat(
      role,
      prompt.system,
      renderTemplate(prompt.user, {
        slug: "",
        requested_title: "",
        current_article: "",
        previous_summary: "",
        summary_feedback: "",
        article_excerpt: "",
        rag_context: "",
        link_hints: "",
        related_titles: "",
        parent_comment: "",
        selected_text: "",
        edit_instructions: "",
        full_article: "",
        dyk_articles: "",
        article_title: "",
        inspiration_titles: inspiration.length
          ? inspiration.map((a) => `- ${a.title} (${a.slug})`).join("\n")
          : "(none)",
      }),
      { thinking: prompt.thinking, jsonMode: prompt.json },
    );
    return { randomPageChoice: normalizeRandomPageChoice(raw) };
  },
});
