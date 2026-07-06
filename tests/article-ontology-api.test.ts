import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { openDatabase, saveArticle, type InfoboxData } from "../src/server/db";
import { createApp } from "../src/server/index";
import { markdownToPlainText, renderMarkdown } from "../src/server/markdown";
import { indexArticleOntology, loadOntologyVocabulary } from "../src/server/ontology";

function seedOntologyArticle(databasePath: string) {
  const db = openDatabase(databasePath);
  const markdown = "# Silicon Oxide\n\nA test article.";
  saveArticle(
    db,
    {
      slug: "silicon-oxide",
      canonicalSlug: "silicon-oxide",
      title: "Silicon Oxide",
      markdown,
      html: renderMarkdown(markdown),
      plain_text: markdownToPlainText(markdown),
      generated_at: Date.now(),
    },
    [],
    ["silicon-oxide"],
  );

  const infobox: InfoboxData = {
    title: "Silicon Oxide",
    subtitle: "Material",
    groups: [
      {
        label: "",
        rows: [
          { label: "Composition", value: "*Silicon dioxide* $\\text{SiO}_2$" },
        ],
      },
    ],
  };
  indexArticleOntology(db, {
    slug: "silicon-oxide",
    title: "Silicon Oxide",
    infobox,
    vocab: loadOntologyVocabulary(),
  });
  db.close();
}

test("article ontology API renders literal fact objects as inline markdown", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "halupedia-ontology-api-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const databasePath = join(root, "test.db");
  seedOntologyArticle(databasePath);

  const { app, shutdown } = await createApp({
    databasePath,
    skipLlmProbe: true,
    skipHomepagePrepare: true,
  });
  t.after(() => shutdown());

  const res = await app.fetch(
    new Request("http://halupedia.test/api/article/silicon-oxide/ontology"),
  );
  assert.equal(res.status, 200);
  const body = (await res.json()) as {
    facts: Array<{ object: string; objectHtml: string }>;
  };
  const composition = body.facts.find((fact) =>
    fact.object.includes("Silicon dioxide"),
  );

  assert.ok(composition);
  assert.match(composition.objectHtml, /<em>Silicon dioxide<\/em>/);
  assert.match(composition.objectHtml, /katex/);
});
