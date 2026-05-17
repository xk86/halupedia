import { summaryMarkdownFromArticle } from "./markdown";

function collapseSummaryText(markdown: string): string {
  return markdown
    .replace(/^#.*$/gm, "")
    .replace(/!\[([^\]]*)\]\([^)]+\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/^[-*+]\s+/gm, "")
    .replace(/^#+\s+/gm, "")
    .replace(/\s+/g, " ")
    .trim();
}

function sharedPrefixLength(left: string, right: string): number {
  const limit = Math.min(left.length, right.length);
  let index = 0;
  while (index < limit && left[index] === right[index]) index += 1;
  return index;
}

export function normalizeSummaryMarkdown(markdown: string): string {
  const firstParagraph = markdown
    .trim()
    .split(/\n{2,}/)
    .map((part) => collapseSummaryText(part))
    .find(Boolean);

  return firstParagraph ?? "";
}

export function summaryLooksLikeLeadCopy(summaryMarkdown: string, articleMarkdown: string): boolean {
  const summary = collapseSummaryText(normalizeSummaryMarkdown(summaryMarkdown)).toLowerCase();
  const lead = collapseSummaryText(summaryMarkdownFromArticle(articleMarkdown)).toLowerCase();
  if (!summary || !lead) return false;
  if (summary === lead) return true;

  const minLength = Math.min(summary.length, lead.length);
  if (minLength < 48) {
    return lead.startsWith(summary) || summary.startsWith(lead);
  }

  const sharedPrefix = sharedPrefixLength(summary, lead);
  return sharedPrefix >= 48 && sharedPrefix / minLength >= 0.8;
}
