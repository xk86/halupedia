import { existsSync, createWriteStream, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import PDFDocument from "pdfkit";

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
}

export interface PdfDumpOptions {
  articleDatabasePath: string;
  mediaDatabasePath: string;
  outputPath: string;
  log?: (message: string) => void;
}

const PAGE_MARGIN = 54;
const TOC_LINES_PER_PAGE = 38;
const UNICODE_FONT = "/System/Library/Fonts/Supplemental/Arial Unicode.ttf";

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
): PdfDumpArticle[] {
  const articleDb = new DatabaseSync(resolve(articleDatabasePath), { readOnly: true });
  const mediaDb = new DatabaseSync(resolve(mediaDatabasePath), { readOnly: true });
  try {
    const infoboxes = tableExists(articleDb, "article_infobox")
      ? new Map(
          readRows<{ articleSlug: string; json: string }>(
            articleDb,
            "SELECT article_slug AS articleSlug, json FROM article_infobox",
          ).map((row) => [row.articleSlug, row.json]),
        )
      : new Map<string, string>();
    const attachments = tableExists(articleDb, "article_media")
      ? readRows<{ articleSlug: string; mediaId: string; caption: string }>(
          articleDb,
          `SELECT article_slug AS articleSlug, media_id AS mediaId, caption
           FROM article_media ORDER BY article_slug ASC, ordinal ASC, id ASC`,
        )
      : [];
    const attachmentsByArticle = new Map<string, Array<{ mediaId: string; caption: string }>>();
    for (const attachment of attachments) {
      const values = attachmentsByArticle.get(attachment.articleSlug) ?? [];
      values.push({ mediaId: attachment.mediaId, caption: attachment.caption });
      attachmentsByArticle.set(attachment.articleSlug, values);
    }

    const articles = readRows<{ slug: string; title: string; markdown: string }>(
      articleDb,
      "SELECT slug, title, markdown FROM articles ORDER BY title COLLATE NOCASE ASC, slug ASC",
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

    return articles.map((article) => ({
      ...article,
      infoboxJson: infoboxes.get(article.slug) ?? null,
      media: (attachmentsByArticle.get(article.slug) ?? []).map((attachment) => ({
        id: attachment.mediaId,
        caption: attachment.caption,
        bytes: mediaBytes(attachment.mediaId),
      })),
    }));
  } finally {
    articleDb.close();
    mediaDb.close();
  }
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

function writeArticle(doc: PDFKit.PDFDocument, article: PdfDumpArticle): number {
  doc.addPage();
  const pageNumber = doc.bufferedPageRange().count - 1;
  const destination = `article-${article.slug}`;
  doc.addNamedDestination(destination, "FitH", PAGE_MARGIN);
  // @types/pdfkit omits PDFKit's supported pageNumber/top/fit options.
  doc.outline.addItem(article.title, { pageNumber, top: PAGE_MARGIN, fit: false } as any);

  doc
    .font("Helvetica-Bold")
    .fontSize(20)
    .fillColor("#111111")
    .text(article.title, { width: doc.page.width - PAGE_MARGIN * 2 });
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
        doc.font("Helvetica-Oblique").fontSize(9).fillColor("#555555").text(media.caption);
      }
      doc.moveDown(0.75);
    } catch {
      // This is a dump: unsupported or corrupt media is skipped without noise.
    }
  }

  if (article.infoboxJson) {
    addSectionLabel(doc, "Current sidebar");
    doc
      .font("Courier")
      .fontSize(8.5)
      .fillColor("#222222")
      .text(article.infoboxJson, { width: doc.page.width - PAGE_MARGIN * 2 });
    doc.moveDown(1);
  }

  addSectionLabel(doc, "Current article markdown");
  doc
    .font(existsSync(UNICODE_FONT) ? UNICODE_FONT : "Courier")
    .fontSize(9)
    .fillColor("#111111")
    .text(article.markdown, { width: doc.page.width - PAGE_MARGIN * 2 });
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
  const articles = loadEncyclopediaPdfDump(options.articleDatabasePath, options.mediaDatabasePath);
  const outputPath = resolve(options.outputPath);
  mkdirSync(dirname(outputPath), { recursive: true });
  log(`PDF dump: loading ${articles.length} current articles`);

  const doc = new PDFDocument({
    autoFirstPage: false,
    bufferPages: true,
    margin: PAGE_MARGIN,
    info: {
      Title: "Halupedia encyclopedia dump",
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
    .text("Halupedia encyclopedia dump", { align: "center" });
  doc.moveDown(1);
  doc.font("Helvetica").fontSize(12).fillColor("#333333").text(`${articles.length} current articles`, { align: "center" });
  doc.moveDown(0.5);
  doc.fontSize(10).text(`Generated ${new Date().toISOString()}`, { align: "center" });

  const tocStartPage = doc.bufferedPageRange().count;
  const tocPages = Math.max(1, Math.ceil(articles.length / TOC_LINES_PER_PAGE));
  for (let i = 0; i < tocPages; i += 1) doc.addPage();

  const articleStartPages: number[] = [];
  articles.forEach((article, index) => {
    log(`PDF dump: ${index + 1}/${articles.length} ${article.title}`);
    articleStartPages.push(writeArticle(doc, article));
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
