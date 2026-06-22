import { renderInlineMarkdown } from "../server/markdown";
import { toWikiSegment } from "./wikiPath";

export function renderEntryTitleHtml(title: string): string {
  return renderInlineMarkdown(title);
}

function plainEntryTitleFromHtml(html: string): string {
  if (typeof document === "undefined") {
    return html
      .replace(/<[^>]+>/g, "")
      .replace(/\s+/g, " ")
      .trim();
  }
  const element = document.createElement("span");
  element.innerHTML = html;
  return (element.textContent ?? "").replace(/\s+/g, " ").trim();
}

export function entryTitlePresentation(title: string) {
  const html = renderEntryTitleHtml(title);
  const plainTitle = plainEntryTitleFromHtml(html);
  const wikiSegment = toWikiSegment(plainTitle);
  return {
    html,
    plainTitle,
    wikiPath: `/wiki/${wikiSegment}`,
    wikiSegment,
  };
}

export function plainEntryTitle(title: string): string {
  return entryTitlePresentation(title).plainTitle;
}

export function entryTitleWikiPath(title: string): string {
  return entryTitlePresentation(title).wikiPath;
}

export function entryTitleWikiSegment(title: string): string {
  return entryTitlePresentation(title).wikiSegment;
}
