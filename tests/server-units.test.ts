import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, saveArticle } from "../src/server/db";
import { extractInternalLinks, markdownToPlainText, renderMarkdown } from "../src/server/markdown";
import type { LlmClient } from "../src/server/llm";
import { indexArticleChunks, retrieveContext } from "../src/server/retrieval";

class NoopLlmClient implements LlmClient {
  async chat(): Promise<string> {
    throw new Error("chat should not be called in retrieval unit tests");
  }

  async streamChat(): Promise<{ content: string; finishReason: string }> {
    throw new Error("streamChat should not be called in retrieval unit tests");
  }

  async embed(): Promise<number[][]> {
    return [];
  }

  async probeConnections(): Promise<void> {}
}

test("extractInternalLinks dedupes targets and ignores invalid links", () => {
  const links = extractInternalLinks([
    'A [Valid Link](halu:glow-fruit "Sweet and bright") appears once.',
    'A duplicate target [Glow](halu:glow-fruit "Different label") should be ignored.',
    'A missing hint [Ignored](halu:ignored) should be skipped.',
    'A second valid [Night Bloom](halu:night-bloom "Used at dusk").',
  ].join("\n"));

  assert.deepEqual(links, [
    {
      targetSlug: "glow-fruit",
      visibleLabel: "Valid Link",
      hiddenHint: "Sweet and bright",
    },
    {
      targetSlug: "night-bloom",
      visibleLabel: "Night Bloom",
      hiddenHint: "Used at dusk",
    },
  ]);
});

test("renderMarkdown rewrites halu links to wiki paths", () => {
  const html = renderMarkdown('Visit [Glow Fruit](halu:glow-fruit "hidden hint") for details.');
  assert.match(html, /href="\/wiki\/Glow_fruit"/);
  assert.doesNotMatch(html, /hidden hint/);
});

test("retrieveContext returns matching lexical context from indexed article chunks", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "halupedia-retrieval-"));
  t.after(() => {
    rmSync(root, { recursive: true, force: true });
  });

  const db = openDatabase(join(root, "halupedia.sqlite"));
  const llm = new NoopLlmClient();
  const generatedAt = 1_715_000_000_000;

  const sourceMarkdown = [
    "# Archive Entry",
    "",
    "Glow fruit grows in the crater orchard near the observatory.",
    "",
    "Keep a lantern nearby when harvesting glow fruit at dusk.",
  ].join("\n");
  saveArticle(
    db,
    {
      slug: "archive-entry",
      canonicalSlug: "archive-entry",
      title: "Archive Entry",
      markdown: sourceMarkdown,
      html: renderMarkdown(sourceMarkdown),
      plain_text: markdownToPlainText(sourceMarkdown),
      generated_at: generatedAt,
    },
    [],
    ["archive-entry"]
  );
  await indexArticleChunks(db, llm, "archive-entry", sourceMarkdown, false, 120);

  const currentMarkdown = [
    "# Test Article",
    "",
    'A note points toward [Archive Entry](halu:archive-entry "Glow fruit orchard notes").',
  ].join("\n");
  saveArticle(
    db,
    {
      slug: "test-article",
      canonicalSlug: "test-article",
      title: "Test Article",
      markdown: currentMarkdown,
      html: renderMarkdown(currentMarkdown),
      plain_text: markdownToPlainText(currentMarkdown),
      generated_at: generatedAt + 1,
    },
    [
      {
        targetSlug: "archive-entry",
        visibleLabel: "Archive Entry",
        hiddenHint: "Glow fruit orchard notes",
      },
    ],
    ["test-article"]
  );

  const packet = await retrieveContext(
    db,
    llm,
    "test-article",
    ["Glow fruit orchard notes"],
    true,
    3,
    0.2,
    false
  );

  assert.equal(packet.relatedTitles[0], "Archive Entry");
  assert.equal(packet.sourceArticles[0].slug, "archive-entry");
  assert.match(packet.context, /Glow fruit grows in the crater orchard/);
});
