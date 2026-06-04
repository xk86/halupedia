import { renderMarkdown } from "../server/markdown";

function stripWrappingParagraph(html: string): string {
  const trimmed = html.trim();
  const match = trimmed.match(/^<p>([\s\S]*)<\/p>$/);
  return match ? match[1] : trimmed;
}

export function renderInlineHtml(markdown: string): string {
  return stripWrappingParagraph(renderMarkdown(markdown));
}
