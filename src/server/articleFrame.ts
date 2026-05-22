/**
 * Article frame parsing — extracts structured sections from raw LLM output.
 *
 * The article prompt instructs the model to delimit its output with markers:
 *
 *   ---body          (or ---halu-body, ---halu_body, ## Body, etc.)
 *   <article markdown>
 *   ---used-refs
 *   ["slug-a", "slug-b"]
 *
 * This module parses that framed output into typed sections without calling
 * any LLM or touching the database — purely deterministic.
 *
 * Extracted from index.ts so that both route handlers and pipeline nodes can
 * import it without creating a circular dependency through the server entry
 * point.
 */

import { stripTopLevelSections } from "./markdown";
import type { Logger } from "./logger";

type FrameSection = "meta" | "body" | "usedRefs";

const HALU_MARKER_RE =
  /^[-_=]+(halu[-_]body|halu[-_]meta|halu[-_]used[-_]refs|halu[-_]used[-_]references)\s*(.*)?$/;
const ALIAS_MARKER_RE =
  /^[-_=]{3,}(body|used[-_]refs|used[-_]references|references[-_]used|meta)\s*(.*)?$/;

function normKeyword(s: string): string {
  return s.toLowerCase().replace(/_/g, "-");
}

function identifyFrameMarker(
  line: string,
): { section: FrameSection; inline: string } | null {
  const normalized = line.trim().toLowerCase();

  const hm = HALU_MARKER_RE.exec(normalized);
  if (hm) {
    const kw = normKeyword(hm[1]);
    const inline = hm[2]?.trim() ?? "";
    switch (kw) {
      case "halu-body": return { section: "body", inline };
      case "halu-meta": return { section: "meta", inline };
      case "halu-used-refs":
      case "halu-used-references": return { section: "usedRefs", inline };
    }
  }

  const am = ALIAS_MARKER_RE.exec(normalized);
  if (am) {
    const kw = normKeyword(am[1]);
    const inline = am[2]?.trim() ?? "";
    switch (kw) {
      case "body": return { section: "body", inline };
      case "meta": return { section: "meta", inline };
      case "used-refs":
      case "used-references":
      case "references-used": return { section: "usedRefs", inline };
    }
  }

  switch (normalized) {
    case "## meta": case "## metadata": return { section: "meta", inline: "" };
    case "## body": case "## article": case "## article body": return { section: "body", inline: "" };
    case "## used refs": case "## used references": case "## references used":
      return { section: "usedRefs", inline: "" };
  }

  return null;
}

function extractFrameSections(raw: string): {
  sections: Partial<Record<FrameSection, string>>;
  preBody: string;
} {
  const sectionLines: Partial<Record<FrameSection, string[]>> = {};
  const preSectionLines: string[] = [];
  let current: FrameSection | null = null;
  for (const line of raw.split("\n")) {
    const result = identifyFrameMarker(line);
    if (result !== null) {
      current = result.section;
      sectionLines[current] ??= [];
      if (result.inline) (sectionLines[current] ??= []).push(result.inline);
    } else if (current !== null) {
      (sectionLines[current] ??= []).push(line);
    } else {
      preSectionLines.push(line);
    }
  }
  const sections: Partial<Record<FrameSection, string>> = {};
  for (const [k, lines] of Object.entries(sectionLines) as [FrameSection, string[]][]) {
    sections[k] = lines.join("\n").trimEnd();
  }
  return { sections, preBody: preSectionLines.join("\n").trim() };
}

export type ParseArticleFrameResult = { body: string };

/**
 * Extract the article body from raw LLM output.
 *
 * The model is instructed to wrap body content with `---body`, optionally
 * followed by other sections. This function extracts only the body markdown.
 * References are constructed algorithmically from the final body — the model
 * does not declare which refs it used, and no `---used-refs` section is
 * parsed or required.
 *
 * Legacy `---used-refs` sections emitted by older prompts are silently ignored.
 */
export function parseArticleFrameOutput(
  raw: string,
  // Kept for call-site compat; ignored — refs come from body scan now.
  _providedSlugs?: ReadonlySet<string>,
  _pinnedSlugs?: ReadonlySet<string>,
  logger?: Logger,
): ParseArticleFrameResult {
  const { sections, preBody } = extractFrameSections(raw);

  let body = sections.body ?? "";
  if (!body && !sections.meta && !sections.usedRefs && !preBody) body = raw.trim();
  if (!body && preBody) body = preBody;
  if (!body && sections.meta) {
    const headingIdx = sections.meta.search(/^#+ /m);
    if (headingIdx >= 0) body = sections.meta.slice(headingIdx).trim();
  }
  if (!body) body = raw.trim();

  logger?.debug("article.frame_extracted", {
    body_chars: body.length,
    had_body_marker: Boolean(sections.body),
    had_used_refs: Boolean(sections.usedRefs),
  });

  return { body };
}

export function parsePartialArticleFrame(accumulated: string): string | null {
  const { sections, preBody } = extractFrameSections(accumulated);
  if (sections.body) return sections.body;
  if (preBody && /^#+ /m.test(preBody)) return preBody;
  if (sections.meta) {
    const headingIdx = sections.meta.search(/^#+ /m);
    if (headingIdx >= 0) return sections.meta.slice(headingIdx);
  }
  return null;
}
