/**
 * Slug collision audit (READ-ONLY).
 *
 * Surfaces existing articles that the robust slugifier can't cleanly tell
 * apart, so you know what's in a production DB before deploying the new slug
 * scheme. Reports three classes:
 *
 *   1. ROBUST COLLISION (severe) — distinct articles whose slugify(title) is
 *      identical. The new scheme cannot distinguish them; one shadows the
 *      other. Exits non-zero so this is CI-catchable.
 *
 *   2. LEGACY TWINS (warning) — distinct articles whose titles collapse to the
 *      same legacySlugify() form (the "Rich Evans (sex pervert)" vs
 *      "Rich Evans sex pervert" case). They ARE distinct articles with
 *      distinct robust slugs; the catch is only one can own the bare legacy
 *      alias, so a model-emitted stripped-kebab ref resolves to the alias
 *      owner. Graceful (always resolves to a real sibling), but worth eyeballing.
 *
 *   3. STORED-SLUG DRIFT (info) — an article whose stored slug differs from
 *      slugify(title) AND whose robust slug is already another article's slug,
 *      so the robust form is not directly reachable (only via title URL).
 *
 * Opens the DB read-only and never writes — it does NOT trigger the migration
 * or alias backfill that openDatabase() would.
 *
 * Usage:
 *   pnpm db:slug-dupe-check
 *   node --import tsx/esm scripts/slug-dupe-check.ts [--db <path>]
 */

import { DatabaseSync } from "node:sqlite";
import { resolve } from "node:path";
import { loadConfig } from "../src/server/config";
import { slugify, legacySlugify } from "../src/server/slug";

interface Row {
  slug: string;
  title: string;
}

function dbPathFromArgs(): string {
  const flagIndex = process.argv.indexOf("--db");
  if (flagIndex >= 0 && process.argv[flagIndex + 1]) return process.argv[flagIndex + 1];
  return loadConfig().app.storage.database_path;
}

function groupBy<T>(rows: T[], key: (row: T) => string): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const row of rows) {
    const k = key(row);
    const bucket = groups.get(k);
    if (bucket) bucket.push(row);
    else groups.set(k, [row]);
  }
  return groups;
}

function main(): void {
  const dbPath = resolve(process.cwd(), dbPathFromArgs());
  console.log(`Auditing (read-only): ${dbPath}\n`);

  const db = new DatabaseSync(dbPath, { readOnly: true });
  const rows = db
    .prepare(`SELECT slug, title FROM articles ORDER BY slug`)
    .all() as Row[];
  db.close();

  if (rows.length === 0) {
    console.log("No articles — nothing to audit.");
    return;
  }
  console.log(`Checked ${rows.length} article(s).\n`);

  const slugByArticle = new Set(rows.map((r) => r.slug));

  // 1. Robust collisions — distinct articles, same slugify(title).
  const robust = groupBy(rows, (r) => slugify(r.title));
  const robustCollisions = [...robust.entries()].filter(
    ([, group]) => new Set(group.map((g) => g.slug)).size > 1,
  );

  // 2. Legacy twins — distinct articles, same legacySlugify(title).
  const legacy = groupBy(rows, (r) => legacySlugify(r.title));
  const legacyTwins = [...legacy.entries()].filter(
    ([, group]) => new Set(group.map((g) => g.slug)).size > 1,
  );

  // 3. Stored-slug drift — robust form occupied by a different article.
  const drift = rows.filter((r) => {
    const robustSlug = slugify(r.title);
    return robustSlug !== r.slug && slugByArticle.has(robustSlug);
  });

  if (robustCollisions.length) {
    console.log(`❌ ROBUST COLLISIONS (${robustCollisions.length}) — slug scheme cannot distinguish:`);
    for (const [slug, group] of robustCollisions) {
      console.log(`   ${slug}`);
      for (const g of group) console.log(`      • [${g.slug}] "${g.title}"`);
    }
    console.log();
  }

  if (legacyTwins.length) {
    console.log(`⚠️  LEGACY TWINS (${legacyTwins.length}) — share a legacy alias; stripped-kebab refs resolve to the alias owner:`);
    for (const [legacySlug, group] of legacyTwins) {
      const owner = group.find((g) => g.slug === legacySlug);
      console.log(`   ${legacySlug}${owner ? "  (owner: " + owner.slug + ")" : "  (owner: none — alias unwritten)"}`);
      for (const g of group) console.log(`      • [${g.slug}] "${g.title}"`);
    }
    console.log();
  }

  if (drift.length) {
    console.log(`ℹ️  STORED-SLUG DRIFT (${drift.length}) — robust slug occupied by another article (reachable only via title URL):`);
    for (const r of drift) {
      console.log(`   [${r.slug}] "${r.title}"  →  robust "${slugify(r.title)}" taken`);
    }
    console.log();
  }

  if (!robustCollisions.length && !legacyTwins.length && !drift.length) {
    console.log("✅ No slug collisions. Safe to deploy.");
    return;
  }

  console.log(
    `Summary: ${robustCollisions.length} robust collision(s), ${legacyTwins.length} legacy twin(s), ${drift.length} drift.`,
  );
  // Only robust collisions are a hard blocker; twins/drift degrade gracefully.
  if (robustCollisions.length) process.exit(1);
}

main();
