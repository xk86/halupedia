import { existsSync, createWriteStream, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import PDFDocument from "pdfkit";
import { unified } from "unified";
import rehypeParse from "rehype-parse";
import type { Element, Root, RootContent } from "hast";
import { renderInlineMarkdown, renderMarkdown } from "./markdown";
import { titleToWikiSegment } from "./slug";

export interface PdfDumpMedia {
  id: string;
  caption: string;
  bytes: Buffer | null;
}

export interface PdfDumpArticle {
  slug: string;
  title: string;
  markdown: string;
  infoboxJson: string | null;
  media: PdfDumpMedia[];
  updatedAt: number;
}

export interface PdfDumpOptions {
  articleDatabasePath: string;
  mediaDatabasePath: string;
  outputPath: string;
  since?: number;
  log?: (message: string) => void;
}

export interface PdfDumpTombstone {
  version: 1;
  lastFullExtractionAt: string;
  lastPublishedAt: string;
}

const PAGE_MARGIN = 54;
const TOC_LINES_PER_PAGE = 38;
const UNICODE_FONT = "/System/Library/Fonts/Supplemental/Arial Unicode.ttf";
const HTML_PARSER = unified().use(rehypeParse, { fragment: true });

type SqlValue = string | number | bigint | Buffer | null;

function readRows<T>(db: DatabaseSync, sql: string, ...params: SqlValue[]): T[] {
  return db.prepare(sql).all(...params) as T[];
}

function readOne<T>(db: DatabaseSync, sql: string, ...params: SqlValue[]): T | null {
  return (db.prepare(sql).get(...params) as T | undefined) ?? null;
}

function tableExists(db: DatabaseSync, name: string): boolean {
  return Boolean(readOne(db, "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?", name));
}

/**
 * Read only the live article state. Revision and archive tables are never read.
 * The media DB is opened independently because Halupedia intentionally keeps
 * its binary media outside the article SQLite database.
 */
export function loadEncyclopediaPdfDump(
  articleDatabasePath: string,
  mediaDatabasePath: string,
  since?: number,
): PdfDumpArticle[] {
  const articleDb = new DatabaseSync(resolve(articleDatabasePath), { readOnly: true });
  const mediaDb = new DatabaseSync(resolve(mediaDatabasePath), { readOnly: true });
  try {
    const infoboxes = tableExists(articleDb, "article_infobox")
      ? new Map(
          readRows<{ articleSlug: string; json: string; updatedAt: number }>(
            articleDb,
            "SELECT article_slug AS articleSlug, json, updated_at AS updatedAt FROM article_infobox",
          ).map((row) => [row.articleSlug, row]),
        )
      : new Map<string, { articleSlug: string; json: string; updatedAt: number }>();
    const attachments = tableExists(articleDb, "article_media")
      ? readRows<{ articleSlug: string; mediaId: string; caption: string; updatedAt: number }>(
        articleDb,
        `SELECT article_slug AS articleSlug, media_id AS mediaId, caption, updated_at AS updatedAt
           FROM article_media ORDER BY article_slug ASC, ordinal ASC, id ASC`,
        )
      : [];
    const attachmentsByArticle = new Map<string, Array<{ mediaId: string; caption: string; updatedAt: number }>>();
    for (const attachment of attachments) {
      const values = attachmentsByArticle.get(attachment.articleSlug) ?? [];
      values.push({ mediaId: attachment.mediaId, caption: attachment.caption, updatedAt: attachment.updatedAt });
      attachmentsByArticle.set(attachment.articleSlug, values);
    }

    const articles = readRows<{ slug: string; title: string; markdown: string; generatedAt: number }>(
      articleDb,
      "SELECT slug, title, markdown, generated_at AS generatedAt FROM articles ORDER BY title COLLATE NOCASE ASC, slug ASC",
    );
    const mediaCache = new Map<string, Buffer | null>();
    const mediaBytes = (mediaId: string): Buffer | null => {
      if (mediaCache.has(mediaId)) return mediaCache.get(mediaId) ?? null;
      // model_b64 is the normalized JPEG/PNG representation stored specifically
      // for local consumers. It avoids format conversion while exporting.
      const record = readOne<{ modelB64: string }>(
        mediaDb,
        "SELECT model_b64 AS modelB64 FROM media WHERE id = ?",
        mediaId,
      );
      const bytes = record?.modelB64 ? Buffer.from(record.modelB64, "base64") : null;
      mediaCache.set(mediaId, bytes);
      return bytes;
    };

    return articles
      .map((article) => {
        const infobox = infoboxes.get(article.slug);
        const articleAttachments = attachmentsByArticle.get(article.slug) ?? [];
        const updatedAt = Math.max(
          article.generatedAt,
          infobox?.updatedAt ?? 0,
          ...articleAttachments.map((attachment) => attachment.updatedAt),
        );
        return {
          slug: article.slug,
          title: article.title,
          markdown: article.markdown,
          infoboxJson: infobox?.json ?? null,
          media: articleAttachments.map((attachment) => ({
            id: attachment.mediaId,
            caption: attachment.caption,
            bytes: mediaBytes(attachment.mediaId),
          })),
          updatedAt,
        };
      })
      .filter((article) => since === undefined || article.updatedAt > since);
  } finally {
    articleDb.close();
    mediaDb.close();
  }
}

export function readPdfDumpTombstone(path: string): PdfDumpTombstone {
  const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<PdfDumpTombstone>;
  if (
    parsed.version !== 1 ||
    typeof parsed.lastFullExtractionAt !== "string" ||
    typeof parsed.lastPublishedAt !== "string" ||
    !Number.isFinite(Date.parse(parsed.lastFullExtractionAt)) ||
    !Number.isFinite(Date.parse(parsed.lastPublishedAt))
  ) {
    throw new Error(`Invalid encyclopedia PDF tombstone: ${path}`);
  }
  return parsed as PdfDumpTombstone;
}

export function writePdfDumpTombstone(path: string, tombstone: PdfDumpTombstone): void {
  const outputPath = resolve(path);
  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, `${JSON.stringify(tombstone, null, 2)}\n`);
}

function addFooter(doc: PDFKit.PDFDocument, pageNumber: number): void {
  const { width, height } = doc.page;
  const bottomMargin = doc.page.margins.bottom;
  // PDFKit paginates text below the normal content margin. The footer belongs
  // in that margin, so temporarily make it writable without adding a page.
  doc.page.margins.bottom = 0;
  doc
    .font("Helvetica")
    .fontSize(8)
    .fillColor("#666666")
    .text(String(pageNumber), PAGE_MARGIN, height - 32, {
      width: width - PAGE_MARGIN * 2,
      align: "center",
      lineBreak: false,
    });
  doc.page.margins.bottom = bottomMargin;
}

function addSectionLabel(doc: PDFKit.PDFDocument, value: string): void {
  doc
    .font("Helvetica-Bold")
    .fontSize(9)
    .fillColor("#666666")
    .text(value.toUpperCase(), PAGE_MARGIN, doc.y, { characterSpacing: 1.2 });
  doc.moveDown(0.35);
}

function ensureImageRoom(doc: PDFKit.PDFDocument): void {
  if (doc.y > doc.page.height - 310) doc.addPage();
}

type InlineStyle = { bold?: boolean; italic?: boolean; code?: boolean; destination?: string };

interface InlineRun extends InlineStyle {
  text: string;
}

function asElement(node: RootContent): Element | null {
  return node.type === "element" ? node : null;
}

function textContent(node: RootContent | Root): string {
  if (node.type === "text") return node.value;
  if ("children" in node) return node.children.map(textContent).join("");
  return "";
}

function wikiDestination(href: unknown, destinations: Map<string, string>): string | undefined {
  if (typeof href !== "string" || !href.startsWith("/wiki/")) return undefined;
  try {
    return destinations.get(decodeURIComponent(href.slice("/wiki/".length)));
  } catch {
    return undefined;
  }
}

function inlineRuns(
  nodes: RootContent[],
  destinations: Map<string, string>,
  style: InlineStyle = {},
): InlineRun[] {
  const runs: InlineRun[] = [];
  for (const node of nodes) {
    if (node.type === "text") {
      if (node.value) runs.push({ text: node.value, ...style });
      continue;
    }
    const element = asElement(node);
    if (!element) continue;
    if (element.tagName === "br") {
      runs.push({ text: "\n", ...style });
      continue;
    }
    const next: InlineStyle = { ...style };
    if (element.tagName === "strong" || element.tagName === "b") next.bold = true;
    if (element.tagName === "em" || element.tagName === "i") next.italic = true;
    if (element.tagName === "code") next.code = true;
    if (element.tagName === "a") next.destination = wikiDestination(element.properties.href, destinations);
    runs.push(...inlineRuns(element.children, destinations, next));
  }
  return runs;
}

function fontForRun(run: InlineRun): string {
  if (run.code) return "Courier";
  if (existsSync(UNICODE_FONT)) return UNICODE_FONT;
  if (run.bold && run.italic) return "Helvetica-BoldOblique";
  if (run.bold) return "Helvetica-Bold";
  if (run.italic) return "Helvetica-Oblique";
  return "Helvetica";
}

function writeInlineHtml(
  doc: PDFKit.PDFDocument,
  html: string,
  destinations: Map<string, string>,
  options: { size?: number; color?: string; width?: number } = {},
): void {
  const root = HTML_PARSER.parse(html) as Root;
  writeInlineNodes(doc, root.children, destinations, options);
}

function writeInlineNodes(
  doc: PDFKit.PDFDocument,
  nodes: RootContent[],
  destinations: Map<string, string>,
  options: { size?: number; color?: string; width?: number } = {},
): void {
  const runs = inlineRuns(nodes, destinations);
  if (runs.length === 0) return;
  const width = options.width ?? doc.page.width - PAGE_MARGIN * 2;
  runs.forEach((run, index) => {
    doc.font(fontForRun(run)).fontSize(options.size ?? 10).fillColor(run.destination ? "#165c9c" : options.color ?? "#111111");
    doc.text(run.text, {
      width,
      continued: index < runs.length - 1,
      goTo: run.destination,
      underline: Boolean(run.destination),
    });
  });
}

function writeRenderedBlocks(
  doc: PDFKit.PDFDocument,
  nodes: RootContent[],
  destinations: Map<string, string>,
  state: { skippedLeadingTitle: boolean },
): void {
  for (const node of nodes) {
    const element = asElement(node);
    if (!element) continue;
    const tag = element.tagName;
    if (/^h[1-6]$/.test(tag)) {
      const heading = textContent(element).trim();
      if (!state.skippedLeadingTitle && tag === "h1") {
        state.skippedLeadingTitle = true;
        continue;
      }
      state.skippedLeadingTitle = true;
      doc.moveDown(0.5);
      writeInlineHtml(doc, `<strong>${heading}</strong>`, destinations, { size: tag === "h2" ? 14 : 12 });
      doc.moveDown(0.3);
      continue;
    }
    if (tag === "p") {
      writeInlineNodes(doc, element.children, destinations, { size: 10 });
      doc.moveDown(0.5);
      continue;
    }
    if (tag === "pre") {
      doc.font("Courier").fontSize(8.5).fillColor("#222222").text(textContent(element));
      doc.moveDown(0.5);
      continue;
    }
    if (tag === "ul" || tag === "ol") {
      const items = element.children.filter((child) => asElement(child)?.tagName === "li");
      items.forEach((item, index) => {
        doc.font("Helvetica").fontSize(10).fillColor("#111111").text(tag === "ol" ? `${index + 1}. ` : "- ", { continued: true });
        writeInlineNodes(doc, asElement(item)?.children ?? [], destinations, { size: 10 });
      });
      doc.moveDown(0.4);
      continue;
    }
    if (tag === "table") {
      for (const row of element.children) {
        const rowElement = asElement(row);
        if (!rowElement) continue;
        const cells = rowElement.children
          .flatMap((child) => asElement(child)?.children ?? [])
          .filter((child) => asElement(child)?.tagName === "td" || asElement(child)?.tagName === "th")
          .map(textContent);
        if (cells.length) doc.font("Courier").fontSize(8.5).fillColor("#222222").text(cells.join(" | "));
      }
      doc.moveDown(0.5);
      continue;
    }
    if (tag === "aside") {
      addSectionLabel(doc, "Article sidebar");
      writeRenderedBlocks(doc, element.children, destinations, state);
      continue;
    }
    writeRenderedBlocks(doc, element.children, destinations, state);
  }
}

function writeCurrentSidebar(
  doc: PDFKit.PDFDocument,
  article: PdfDumpArticle,
  destinations: Map<string, string>,
): void {
  if (!article.infoboxJson) return;
  type SidebarData = {
    title?: unknown;
    subtitle?: unknown;
    groups?: Array<{ label?: unknown; rows?: Array<{ label?: unknown; value?: unknown }> }>;
  };
  let infobox: SidebarData | null = null;
  try {
    infobox = JSON.parse(article.infoboxJson) as SidebarData;
  } catch {
    return;
  }
  if (!infobox) return;
  addSectionLabel(doc, "Current sidebar");
  if (infobox.title) writeInlineHtml(doc, `<strong>${renderInlineMarkdown(infobox.title)}</strong>`, destinations, { size: 12 });
  if (infobox.subtitle) writeInlineHtml(doc, renderInlineMarkdown(infobox.subtitle), destinations, { size: 9, color: "#555555" });
  for (const group of Array.isArray(infobox.groups) ? infobox.groups : []) {
    if (group.label) writeInlineHtml(doc, `<strong>${renderInlineMarkdown(group.label)}</strong>`, destinations, { size: 9 });
    for (const row of Array.isArray(group.rows) ? group.rows : []) {
      const label = row.label == null ? "" : renderInlineMarkdown(row.label);
      const value = row.value == null ? "" : renderInlineMarkdown(row.value);
      writeInlineHtml(doc, `<strong>${label}</strong>: ${value}`, destinations, { size: 9 });
    }
  }
  doc.moveDown(0.7);
}

function writeArticle(
  doc: PDFKit.PDFDocument,
  article: PdfDumpArticle,
  destinations: Map<string, string>,
): number {
  doc.addPage();
  const pageNumber = doc.bufferedPageRange().count - 1;
  const destination = `article-${article.slug}`;
  doc.addNamedDestination(destination, "FitH", PAGE_MARGIN);
  // @types/pdfkit omits PDFKit's supported pageNumber/top/fit options.
  doc.outline.addItem(article.title, { pageNumber, top: PAGE_MARGIN, fit: false } as any);

  writeInlineHtml(doc, renderInlineMarkdown(article.title), destinations, { size: 20 });
  doc.moveDown(0.8);

  for (const media of article.media) {
    if (!media.bytes) continue;
    try {
      ensureImageRoom(doc);
      doc.image(media.bytes, {
        fit: [360, 240],
        align: "center",
        valign: "center",
      });
      if (media.caption) {
        doc.moveDown(0.25);
        writeInlineHtml(doc, renderInlineMarkdown(media.caption), destinations, { size: 9, color: "#555555" });
      }
      doc.moveDown(0.75);
    } catch {
      // This is a dump: unsupported or corrupt media is skipped without noise.
    }
  }

  writeCurrentSidebar(doc, article, destinations);

  addSectionLabel(doc, "Current article");
  const rendered = renderMarkdown(article.markdown);
  const root = HTML_PARSER.parse(rendered) as Root;
  writeRenderedBlocks(doc, root.children, destinations, { skippedLeadingTitle: false });
  return pageNumber;
}

function writeTableOfContents(
  doc: PDFKit.PDFDocument,
  articles: PdfDumpArticle[],
  tocStartPage: number,
  articleStartPages: number[],
): void {
  for (let tocOffset = 0; tocOffset < Math.max(1, Math.ceil(articles.length / TOC_LINES_PER_PAGE)); tocOffset += 1) {
    doc.switchToPage(tocStartPage + tocOffset);
    doc.x = PAGE_MARGIN;
    doc.y = PAGE_MARGIN;
    doc.font("Helvetica-Bold").fontSize(18).fillColor("#111111").text("Contents");
    doc.moveDown(1);
    const start = tocOffset * TOC_LINES_PER_PAGE;
    const entries = articles.slice(start, start + TOC_LINES_PER_PAGE);
    entries.forEach((article, index) => {
      const articleIndex = start + index;
      const page = articleStartPages[articleIndex] + 1;
      const y = doc.y;
      doc.font("Helvetica").fontSize(10).fillColor("#111111").text(article.title, PAGE_MARGIN, y, {
        width: doc.page.width - PAGE_MARGIN * 2 - 34,
        lineBreak: false,
        ellipsis: true,
      });
      doc.font("Helvetica").fontSize(10).text(String(page), doc.page.width - PAGE_MARGIN - 28, y, {
        width: 28,
        align: "right",
        lineBreak: false,
      });
      doc.goTo(PAGE_MARGIN, y, doc.page.width - PAGE_MARGIN * 2, 14, `article-${article.slug}`);
      doc.y = y + 15;
    });
  }
}

export async function writeEncyclopediaPdfDump(options: PdfDumpOptions): Promise<void> {
  const log = options.log ?? (() => {});
  const articles = loadEncyclopediaPdfDump(options.articleDatabasePath, options.mediaDatabasePath, options.since);
  const outputPath = resolve(options.outputPath);
  mkdirSync(dirname(outputPath), { recursive: true });
  log(`PDF dump: loading ${articles.length} ${options.since === undefined ? "current" : "updated"} articles`);

  const doc = new PDFDocument({
    autoFirstPage: false,
    bufferPages: true,
    margin: PAGE_MARGIN,
    info: {
      Title: options.since === undefined ? "Halupedia encyclopedia dump" : "Halupedia encyclopedia update",
      Author: "Halupedia",
      Subject: "Current encyclopedia content export",
      Creator: "Halupedia PDF dump",
    },
  });
  const stream = createWriteStream(outputPath);
  doc.pipe(stream);

  doc.addPage();
  doc
    .font("Helvetica-Bold")
    .fontSize(28)
    .fillColor("#111111")
    .text(options.since === undefined ? "Halupedia encyclopedia dump" : "Halupedia encyclopedia update", { align: "center" });
  doc.moveDown(1);
  doc.font("Helvetica").fontSize(12).fillColor("#333333").text(`${articles.length} ${options.since === undefined ? "current" : "updated"} articles`, { align: "center" });
  doc.moveDown(0.5);
  doc.fontSize(10).text(`Generated ${new Date().toISOString()}`, { align: "center" });

  const tocStartPage = doc.bufferedPageRange().count;
  const tocPages = Math.max(1, Math.ceil(articles.length / TOC_LINES_PER_PAGE));
  for (let i = 0; i < tocPages; i += 1) doc.addPage();

  const articleStartPages: number[] = [];
  const destinations = new Map(articles.map((article) => [titleToWikiSegment(article.title), `article-${article.slug}`]));
  articles.forEach((article, index) => {
    log(`PDF dump: ${index + 1}/${articles.length} ${article.title}`);
    articleStartPages.push(writeArticle(doc, article, destinations));
  });
  writeTableOfContents(doc, articles, tocStartPage, articleStartPages);

  const pages = doc.bufferedPageRange();
  for (let page = pages.start; page < pages.start + pages.count; page += 1) {
    doc.switchToPage(page);
    addFooter(doc, page + 1);
  }

  await new Promise<void>((resolvePromise, reject) => {
    stream.once("finish", resolvePromise);
    stream.once("error", reject);
    doc.end();
  });
  log(`PDF dump: wrote ${outputPath}`);
}
