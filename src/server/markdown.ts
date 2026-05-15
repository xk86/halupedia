import MarkdownIt from "markdown-it";
import { slugToTitle, slugify, titleToWikiSegment } from "./slug";
import type { ParsedInternalLink } from "./types";

const LINK_RE = /\[([^\]]+)\]\(halu:([^) "\t\r\n]+)(?:\s+"([^"]*)")?\)/g;

const md = new MarkdownIt({
  html: false,
  linkify: false,
  breaks: false,
});

const TEX_COMMANDS: Record<string, string> = {
  alpha: "α",
  beta: "β",
  gamma: "γ",
  delta: "δ",
  epsilon: "ϵ",
  zeta: "ζ",
  eta: "η",
  theta: "θ",
  iota: "ι",
  kappa: "κ",
  lambda: "λ",
  mu: "μ",
  nu: "ν",
  xi: "ξ",
  pi: "π",
  rho: "ρ",
  sigma: "σ",
  tau: "τ",
  upsilon: "υ",
  phi: "φ",
  chi: "χ",
  psi: "ψ",
  omega: "ω",
  Gamma: "Γ",
  Delta: "Δ",
  Theta: "Θ",
  Lambda: "Λ",
  Xi: "Ξ",
  Pi: "Π",
  Sigma: "Σ",
  Phi: "Φ",
  Psi: "Ψ",
  Omega: "Ω",
  cdot: "·",
  times: "×",
  pm: "±",
  leq: "≤",
  geq: "≥",
  neq: "≠",
  approx: "≈",
  to: "→",
  leftarrow: "←",
  rightarrow: "→",
};

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function renderInlineTeX(tex: string): string {
  const replaced = tex
    .trim()
    .replace(/\\([A-Za-z]+)/g, (_match, command: string) => TEX_COMMANDS[command] ?? command)
    .replace(/\\_/g, "_")
    .replace(/\\\$/g, "$");
  return escapeHtml(replaced);
}

md.inline.ruler.before("escape", "inline_tex", (state, silent) => {
  const start = state.pos;
  if (state.src[start] !== "$") return false;
  if (state.src[start + 1] === "$") return false;
  if (start > 0 && state.src[start - 1] === "\\") return false;

  let end = start + 1;
  while (end < state.posMax) {
    if (state.src[end] === "$" && state.src[end - 1] !== "\\") break;
    end += 1;
  }
  if (end >= state.posMax || end === start + 1) return false;
  if (!silent) {
    const token = state.push("inline_tex", "", 0);
    token.content = state.src.slice(start + 1, end);
  }
  state.pos = end + 1;
  return true;
});

md.renderer.rules.inline_tex = (tokens, idx) => `<span class="math-inline">${renderInlineTeX(tokens[idx].content)}</span>`;

const defaultLinkOpen =
  md.renderer.rules.link_open ??
  ((tokens, idx, options, _env, self) => self.renderToken(tokens, idx, options));

md.renderer.rules.link_open = (tokens, idx, options, env, self) => {
  const hrefIndex = tokens[idx].attrIndex("href");
  const titleIndex = tokens[idx].attrIndex("title");
  const href = hrefIndex >= 0 ? tokens[idx].attrs?.[hrefIndex]?.[1] ?? "" : "";
  if (href.startsWith("#")) {
    return defaultLinkOpen(tokens, idx, options, env, self);
  }
  if (!href.startsWith("halu:")) {
    tokens[idx].attrSet("href", "#");
    if (titleIndex >= 0) tokens[idx].attrs?.splice(titleIndex, 1);
    return defaultLinkOpen(tokens, idx, options, env, self);
  }

  const normalized = slugify(href.slice("halu:".length));
  tokens[idx].attrSet("href", `/wiki/${titleToWikiSegment(slugToTitle(normalized))}`);
  if (titleIndex >= 0) tokens[idx].attrs?.splice(titleIndex, 1);
  return defaultLinkOpen(tokens, idx, options, env, self);
};

export function normalizeMarkdown(input: string): string {
  let markdown = input.trim();
  markdown = markdown.replace(/^```(?:markdown|md)?\s*/i, "").replace(/```$/i, "").trim();
  markdown = markdown.replace(/<!--[\s\S]*?-->/g, "");
  markdown = markdown.replace(/<script[\s\S]*?<\/script>/gi, "");
  markdown = markdown.replace(/<iframe[\s\S]*?<\/iframe>/gi, "");
  markdown = markdown.replace(/<\/?[a-z][^>]*>/gi, "");
  return markdown;
}

export function extractInternalLinks(markdown: string): ParsedInternalLink[] {
  const links: ParsedInternalLink[] = [];
  const seen = new Set<string>();
  let match: RegExpExecArray | null;

  while ((match = LINK_RE.exec(markdown)) !== null) {
    const visibleLabel = match[1].trim();
    const targetSlug = slugify(match[2]);
    const hiddenHint = (match[3] ?? "").trim().slice(0, 400);
    if (!visibleLabel || !targetSlug || !hiddenHint) continue;
    const key = targetSlug;
    if (seen.has(key)) continue;
    seen.add(key);
    links.push({ targetSlug, visibleLabel, hiddenHint });
  }

  return links;
}

function normalizeHeadingLabel(heading: string): string {
  return heading.trim().toLowerCase();
}

export function stripTopLevelSections(markdown: string, headings: string[]): string {
  const targetHeadings = new Set(headings.map(normalizeHeadingLabel));
  const lines = markdown.split("\n");
  const kept: string[] = [];
  let skipping = false;

  for (const line of lines) {
    const headingMatch = line.match(/^##\s+(.+?)\s*$/);
    if (headingMatch) {
      const heading = normalizeHeadingLabel(headingMatch[1]);
      if (targetHeadings.has(heading)) {
        skipping = true;
        continue;
      }
      skipping = false;
    }
    if (!skipping) kept.push(line);
  }

  return kept
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function stripFootnoteArtifacts(markdown: string): string {
  return markdown
    .replace(/\$\{\}\^\d+\$/g, "")
    .replace(/\[\^[^\]]+\]/g, "")
    .replace(/^\$\{\}\^\d+\$.*$/gm, "")
    .replace(/^\[\^[^\]]+\]:.*$/gm, "")
    .replace(/^[-*]{3,}\s*$/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function sectionSlice(markdown: string, heading: string): string {
  const pattern = new RegExp(`^##\\s+${heading}\\s*$`, "im");
  const match = pattern.exec(markdown);
  if (!match) return "";
  const start = match.index + match[0].length;
  const rest = markdown.slice(start);
  const nextHeading = /\n##\s+/i.exec(rest);
  return (nextHeading ? rest.slice(0, nextHeading.index) : rest).trim();
}

export function renderMarkdown(markdown: string): string {
  return md.render(markdown);
}

export function extractTitle(markdown: string, fallbackSlug: string): string {
  const match = markdown.match(/^#\s+(.+)$/m);
  return match?.[1]?.trim() || fallbackSlug;
}

export function markdownToPlainText(markdown: string): string {
  return renderMarkdown(markdown)
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}
