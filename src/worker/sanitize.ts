import { slugify } from "./slug";

/**
 * Very lenient HTML sanitizer using HTMLRewriter (available on Workers).
 * We:
 *   - Strip disallowed tags entirely (script, style, iframe, html/head/body wrappers, etc).
 *   - Normalize <a href> to always be /slugified-path, strip external links.
 *   - Remove event handler attributes (onclick etc).
 *   - Strip javascript: URLs.
 *
 * This runs on the final generated HTML string before we persist to KV
 * and before we stream the cached copy out.
 */

const ALLOWED_TAGS = new Set([
  "h1", "h2", "h3", "h4", "p", "ul", "ol", "li",
  "blockquote", "a", "em", "i", "strong", "b", "cite",
  "figure", "figcaption", "hr", "br", "small", "sup", "sub",
  "dl", "dt", "dd", "section", "article", "aside",
]);

const DANGEROUS_ATTR = /^on/i;

export function sanitizeHTML(dirty: string): string {
  // Drop code fences if the model wrapped output in ```html ... ```
  let html = dirty.trim();
  html = html.replace(/^```(?:html)?\s*/i, "").replace(/```$/i, "").trim();

  // Remove anything outside article-ish content
  html = html.replace(/<\/?(?:html|head|body|script|style|iframe|meta|link|title|object|embed|form|input|textarea|button)[^>]*>/gi, "");

  // Remove HTML comments
  html = html.replace(/<!--[\s\S]*?-->/g, "");

  // Rewrite tags: drop disallowed, scrub attributes on allowed.
  html = html.replace(/<(\/?)([a-zA-Z0-9]+)([^>]*)>/g, (_m, closing: string, tag: string, attrs: string) => {
    const t = tag.toLowerCase();
    if (!ALLOWED_TAGS.has(t)) return "";
    if (closing) return `</${t}>`;
    const scrubbed = scrubAttrs(t, attrs);
    return `<${t}${scrubbed}>`;
  });

  return html.trim();
}

function scrubAttrs(tag: string, attrs: string): string {
  const out: string[] = [];
  const re = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*(?:=\s*("([^"]*)"|'([^']*)'|([^\s>]+)))?/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(attrs)) !== null) {
    const name = m[1].toLowerCase();
    const raw = (m[3] ?? m[4] ?? m[5] ?? "").trim();
    if (DANGEROUS_ATTR.test(name)) continue;
    if (tag === "a" && name === "href") {
      const normalized = normalizeHref(raw);
      if (normalized) out.push(`href="${escapeAttr(normalized)}"`);
      continue;
    }
    // Only allow a tiny whitelist of attributes
    if (name === "id" || name === "class" || name === "title") {
      out.push(`${name}="${escapeAttr(raw)}"`);
    }
  }
  return out.length ? " " + out.join(" ") : "";
}

function escapeAttr(s: string): string {
  return s.replace(/"/g, "&quot;").replace(/</g, "&lt;");
}

/**
 * Normalize any href to an internal /slug. If the model produced an external
 * URL or javascript: scheme, we drop it (return null).
 */
function normalizeHref(raw: string): string | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (/^(javascript|data|vbscript):/i.test(trimmed)) return null;
  if (/^https?:\/\//i.test(trimmed)) return null;
  if (/^mailto:/i.test(trimmed)) return null;
  // Strip leading slash, query, and hash, slugify, then prepend slash.
  let path = trimmed.replace(/^\/+/, "").split(/[?#]/)[0];
  if (!path) return null;
  const slug = slugify(path);
  if (!slug) return null;
  return `/${slug}`;
}

/**
 * Extract a plaintext summary from the HTML: the first paragraph, trimmed.
 * Used for "from context" when users follow a link from this article.
 */
export function extractSummary(html: string): string {
  const pMatch = html.match(/<p[^>]*>([\s\S]*?)<\/p>/i);
  const raw = pMatch ? pMatch[1] : html;
  const text = raw.replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
  // First 1–2 sentences, capped.
  const sentences = text.match(/[^.!?]+[.!?]+/g) ?? [text];
  return sentences.slice(0, 2).join(" ").slice(0, 400).trim();
}

export function extractTitle(html: string, fallback: string): string {
  const h1 = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
  if (!h1) return fallback;
  return h1[1].replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim() || fallback;
}

/**
 * Quick sanity check: did the model produce something that looks like an article?
 * If not, we regenerate once.
 */
export function looksLikeArticle(html: string): boolean {
  if (html.length < 200) return false;
  if (!/<h1[^>]*>/i.test(html)) return false;
  if (!/<p[^>]*>/i.test(html)) return false;
  const linkCount = (html.match(/<a\s+href=/gi) ?? []).length;
  if (linkCount < 5) return false;
  return true;
}
