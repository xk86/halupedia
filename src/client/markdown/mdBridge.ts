// Markdown <-> HTML bridge for the ProseKit editor.
//
// ProseKit (ProseMirror) stores a rich document, not markdown text, so the
// editor round-trips through HTML: markdown is rendered to HTML to load the
// doc, and the doc's HTML is converted back to markdown on change. markdown-it
// renders (matching how articles render elsewhere in the client); the reverse
// trip uses the remark/rehype pipeline, which is the path ProseKit documents.

import MarkdownIt from "markdown-it";
import { unified } from "unified";
import rehypeParse from "rehype-parse";
import rehypeRemark from "rehype-remark";
import remarkStringify from "remark-stringify";

const md = new MarkdownIt({ html: false, linkify: false });

/** Render a markdown string to HTML for loading into the editor doc. */
export function markdownToHtml(markdown: string): string {
  return md.render(markdown);
}

const htmlToMdProcessor = unified()
  .use(rehypeParse, { fragment: true })
  .use(rehypeRemark)
  .use(remarkStringify, {
    bullet: "-",
    emphasis: "_",
    strong: "*",
    fences: true,
    rule: "-",
    listItemIndent: "one",
  });

/** Convert the editor doc's HTML back into a markdown string. */
export async function htmlToMarkdown(html: string): Promise<string> {
  const file = await htmlToMdProcessor.process(html);
  return String(file).replace(/\n+$/, "\n").trimEnd();
}
