import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/server/config";
import { getArticleByLookup, openDatabase, saveArticle } from "../src/server/db";
import type { LlmRouter } from "../src/server/llm";
import { renderMarkdown, markdownToPlainText } from "../src/server/markdown";
import { getWorldDate } from "../src/server/worldClock";
import {
  ensureTodaysNewsArticle,
  homepageNewsFromMarkdown,
  isCurrentHomepageNews,
  relinkTodaysNewsBriefHeadings,
} from "../src/server/todaysNews";

function appWithWorldClock() {
  const app = loadConfig().app;
  return {
    ...app,
    homepage: { ...app.homepage, rotation_hours: 24 },
    world: {
      ...app.world,
      epoch_real_time: "2025-01-01T00:00:00.000Z",
      epoch_day: 1,
      epoch_date: "2025-01-01",
    },
  };
}

test("world date uses the configured epoch date for plain labels", () => {
  const app = appWithWorldClock();

  const before = getWorldDate(app, Date.parse("2025-09-09T12:00:00.000Z"));
  assert.equal(before.label, "September 9, 2025");

  const after = getWorldDate(app, Date.parse("2025-09-10T12:00:00.000Z"));
  assert.equal(after.label, "September 10, 2025");
});

test("default world config starts dates on January 1, 2000", () => {
  const app = loadConfig().app;
  const epoch = Date.parse(app.world.epoch_real_time);
  const worldDate = getWorldDate(app, epoch);
  assert.equal(app.world.epoch_date, "2000-01-01");
  assert.equal(worldDate.label, "January 1, 2000");
});

test("homepage news preview keeps at least three headlines when briefs provide fallback rows", () => {
  const app = appWithWorldClock();
  const worldDate = getWorldDate(app, Date.parse("2025-09-09T12:00:00.000Z"));
  const preview = homepageNewsFromMarkdown(
    "todays-news-day-000252",
    [
      "# Today's News: September 9, 2025",
      "",
      "A sponsored edition crosses the wires.",
      "",
      "## Headlines",
      "",
      "- **Canal ledgers wobble**: Accountants deny moonlight errors.",
      "- **Archivists delay vote**: The committee requests another stamp.",
      "",
      "## Briefs",
      "",
      "### Ferry court adjourns",
      "Proceedings pause after every witness cites the wrong tide table.",
    ].join("\n"),
    worldDate,
  );

  assert.equal(preview.headlines.length, 3);
  assert.equal(preview.headlines[2].text, "Ferry court adjourns");
});

test("homepage news cache is stale when the date label uses an old format", () => {
  const app = appWithWorldClock();
  const now = Date.parse("2025-09-09T12:00:00.000Z");
  assert.equal(
    isCurrentHomepageNews(
      {
        slug: "todays-news-day-000252",
        title: "Today's News: September 9, 2025",
        worldDate: "September 9, 2025",
        generatorVersion: "1",
      },
      app,
      now,
    ),
    true,
  );
  assert.equal(
    isCurrentHomepageNews(
      {
        slug: "todays-news-day-000252",
        title: "Today's News: September 9, 2025",
        worldDate: "September 9, 2025",
        generatorVersion: "2",
      },
      app,
      now,
    ),
    false,
  );
  assert.equal(
    isCurrentHomepageNews(
      {
        slug: "todays-news-day-000252",
        title: "Today's News: Halu Era 2025, Day 252",
        worldDate: "Halu Era 2025, Day 252",
        generatorVersion: "1",
      },
      app,
      now,
    ),
    false,
  );
});

test("today's news relinks brief headings after post-processing", () => {
  const markdown = [
    "# Today's News: October 29, 2028",
    "",
    "## Headlines",
    "",
    "- **[Ash Convoys Reach Harbor:](ref:todays-news-day-000001-ash-convoys-reach-harbor)**: Relief crews reroute masks.",
    "",
    "## Briefs",
    "",
    "### Ash Convoys Reach Harbor",
    "Relief crews reroute masks.",
  ].join("\n");

  assert.match(
    relinkTodaysNewsBriefHeadings(markdown),
    /^### \[Ash Convoys Reach Harbor\]\(ref:todays-news-day-000001-ash-convoys-reach-harbor\)$/m,
  );
});

test("today's news prompt includes date-matched ongoing world-state lore", async () => {
  const root = mkdtempSync(join(tmpdir(), "halupedia-news-test-"));
  try {
    const db = openDatabase(join(root, "halupedia.sqlite"));
    const now = Date.now();
    const runtime = loadConfig();
    runtime.app.rag.enabled = false;
    runtime.app.world = {
      ...runtime.app.world,
      epoch_real_time: new Date(now).toISOString(),
      epoch_day: 1,
      epoch_date: "2028-10-29",
    };

    const markdown = [
      "# Caldera Night",
      "",
      "In October 2028, a super volcano blocks the sun for one month, forcing coastal regions to ration emergency lighting and ash masks.",
    ].join("\n");
    saveArticle(
      db,
      {
        slug: "caldera-night",
        canonicalSlug: "caldera-night",
        title: "Caldera Night",
        markdown,
        html: renderMarkdown(markdown),
        summaryMarkdown: "A super volcano blocks the sun for one month in October 2028.",
        plain_text: markdownToPlainText(markdown),
        generated_at: now - 1000,
      },
      [],
      ["caldera-night"],
      { operation: "test", skipRevision: true },
    );
    const cityMarkdown = [
      "# Lumen Harbor",
      "",
      "Lumen Harbor is an in-canon city whose waterfront lamps remain active through Caldera Night.",
    ].join("\n");
    saveArticle(
      db,
      {
        slug: "lumen-harbor",
        canonicalSlug: "lumen-harbor",
        title: "Lumen Harbor",
        markdown: cityMarkdown,
        html: renderMarkdown(cityMarkdown),
        summaryMarkdown: "Lumen Harbor is an in-canon city with weather-relevant civic infrastructure.",
        plain_text: markdownToPlainText(cityMarkdown),
        generated_at: now - 900,
      },
      [],
      ["lumen-harbor"],
      { operation: "test", skipRevision: true },
    );

    let capturedUserPrompt = "";
    const llm: LlmRouter = {
      async chat(_role, _system, user) {
        capturedUserPrompt = user;
        return [
          "# Today's News: October 29, 2028",
          "",
          "October 29, 2028 | Emergency lighting remains rationed under the ash sky.",
          "",
          "## Headlines",
          "",
          "- **Ash Convoys Reach Harbor**: Relief crews reroute masks through darkened streets.",
          "- **Schools Extend Lamp Hours**: Classrooms stay open under rationed battery banks.",
          "- **Transit Slows Under Caldera Dust**: Switch crews clear ash from exposed junctions.",
          "",
          "## Briefs",
          "",
          "**Ash Convoys Reach Harbor**: Relief crews reroute masks through darkened streets.",
          "",
          "**Schools Extend Lamp Hours**: Classrooms stay open under rationed battery banks.",
          "",
          "**Transit Slows Under Caldera Dust**: Switch crews clear ash from exposed junctions.",
          "",
          "## Context",
          "",
          "The edition follows Caldera Night's month-long ash conditions.",
        ].join("\n");
      },
      async streamChat() {
        throw new Error("not used");
      },
      async embed() {
        throw new Error("not used");
      },
      async probeConnections() {},
    };

    const news = await ensureTodaysNewsArticle(db, llm, runtime);
    assert.ok(news);
    assert.equal(news.generatorVersion, "1");
    assert.ok(news.headlines[0].slug);
    assert.match(capturedUserPrompt, /Caldera Night/);
    assert.match(capturedUserPrompt, /Why included: date match/);
    assert.match(capturedUserPrompt, /super volcano blocks the sun for one month/);
    const savedEdition = getArticleByLookup(db, "todays-news-day-000001");
    assert.ok(savedEdition);
    assert.match(savedEdition.markdown, /- \*\*\[Ash Convoys Reach Harbor\]\(halu:(?:caldera-night|lumen-harbor)/);
    assert.match(savedEdition.markdown, /### \[Ash Convoys Reach Harbor\]\(halu:(?:caldera-night|lumen-harbor)/);
    assert.doesNotMatch(savedEdition.markdown, /halu:todays-news-day-000001-ash-convoys-reach-harbor/);
    assert.doesNotMatch(savedEdition.markdown, /\*\*Ash Convoys Reach Harbor\*\*:/);
    assert.doesNotMatch(savedEdition.markdown, /todays-news-generator-version/);
    assert.doesNotMatch(savedEdition.markdown, /^## Context$/m);
    assert.doesNotMatch(savedEdition.markdown, /^## World Briefing$/m);
    assert.match(savedEdition.markdown, /^## Travel & Infrastructure$/m);
    assert.match(savedEdition.markdown, /\| Network \| Status \| Advisory \|/);
    assert.match(savedEdition.markdown, /^## Public Notices$/m);
    assert.match(savedEdition.markdown, /^## Culture & Sport$/m);
    assert.match(savedEdition.markdown, /^## Science Desk$/m);
    assert.match(savedEdition.markdown, /^## Markets$/m);
    assert.match(savedEdition.markdown, /\| Ticker \| Stock or index \| Move \| Desk note \|/);
    assert.match(savedEdition.markdown, /🟢|🔴/);
    assert.doesNotMatch(savedEdition.markdown, /\| (HLC|BKD|TIDE|UAO|MASK|CIV) \|/);
    assert.match(savedEdition.markdown, /^## Weather$/m);
    assert.match(savedEdition.markdown, /\| Metric \| Report \|/);
    assert.match(savedEdition.markdown, /\*\*Weather desk: \[Lumen Harbor\]\(halu:lumen-harbor "Lumen Harbor"\)\*\*/);
    assert.match(savedEdition.markdown, /^## Corrections & Continuity$/m);
    assert.equal(getArticleByLookup(db, "todays-news-day-000001-ash-convoys-reach-harbor"), null);
    db.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
