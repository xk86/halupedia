/**
 * RAG audit script.
 *
 * Compares every slug in article_chunks against the live articles table and
 * the deleted_articles tombstone table.  Any chunk whose slug is:
 *   • absent from articles  (orphaned — article deleted without chunk cleanup)
 *   • present in deleted_articles  (tombstoned — deletion was recorded)
 *
 * …is purged from article_chunks.
 *
 * Usage:
 *   node --import tsx/esm scripts/rag-audit.ts [--dry-run]
 *
 * Flags:
 *   --dry-run   Report orphaned/tombstoned slugs but do not delete anything.
 */

import { openDatabase } from "../src/server/db";
import { loadConfig } from "../src/server/config";

const isDryRun = process.argv.includes("--dry-run");

function main() {
  const config = loadConfig();
  const dbPath = config.app.storage.database_path;
  console.log(`Opening database: ${dbPath}`);
  const db = openDatabase(dbPath);

  // All slugs that have RAG chunks
  const chunkSlugs = (
    db.prepare("SELECT DISTINCT slug FROM article_chunks ORDER BY slug").all() as Array<{ slug: string }>
  ).map((r) => r.slug);

  if (chunkSlugs.length === 0) {
    console.log("article_chunks is empty — nothing to audit.");
    db.close();
    return;
  }

  console.log(`\nChecking ${chunkSlugs.length} distinct slug(s) in article_chunks...\n`);

  // Build lookup sets for live articles and tombstones
  const liveSet = new Set(
    (db.prepare("SELECT slug FROM articles").all() as Array<{ slug: string }>).map((r) => r.slug),
  );
  const tombstoneSet = new Set(
    (db.prepare("SELECT slug FROM deleted_articles").all() as Array<{ slug: string }>).map((r) => r.slug),
  );

  const orphaned: string[] = [];
  const tombstoned: string[] = [];
  const ok: string[] = [];

  for (const slug of chunkSlugs) {
    if (tombstoneSet.has(slug)) {
      tombstoned.push(slug);
    } else if (!liveSet.has(slug)) {
      orphaned.push(slug);
    } else {
      ok.push(slug);
    }
  }

  // Report
  console.log(`  ✓ live:       ${ok.length} slug(s)`);
  console.log(`  ✗ tombstoned: ${tombstoned.length} slug(s) — deleted articles whose chunks survived`);
  console.log(`  ✗ orphaned:   ${orphaned.length} slug(s) — no article row and no tombstone\n`);

  if (tombstoned.length > 0) {
    console.log("Tombstoned slugs:");
    for (const slug of tombstoned) {
      const row = db
        .prepare("SELECT title, deleted_at FROM deleted_articles WHERE slug = ?")
        .get(slug) as { title: string; deleted_at: number } | undefined;
      const title = row?.title ?? "(unknown)";
      const deletedAt = row?.deleted_at ? new Date(row.deleted_at).toISOString() : "(unknown)";
      console.log(`  • ${slug}  "${title}"  deleted_at=${deletedAt}`);
    }
    console.log();
  }

  if (orphaned.length > 0) {
    console.log("Orphaned slugs (in chunks but not in articles or deleted_articles):");
    for (const slug of orphaned) {
      const count = (
        db.prepare("SELECT COUNT(*) AS n FROM article_chunks WHERE slug = ?").get(slug) as { n: number }
      ).n;
      console.log(`  • ${slug}  (${count} chunk${count !== 1 ? "s" : ""})`);
    }
    console.log();
  }

  const toPurge = [...tombstoned, ...orphaned];

  if (toPurge.length === 0) {
    console.log("RAG index is clean — no stale chunks found.");
    db.close();
    return;
  }

  if (isDryRun) {
    console.log(`Dry run: would delete chunks for ${toPurge.length} slug(s). Re-run without --dry-run to apply.`);
    db.close();
    return;
  }

  // Delete stale chunks
  const del = db.prepare("DELETE FROM article_chunks WHERE slug = ?");
  let totalDeleted = 0;

  db.exec("BEGIN");
  try {
    for (const slug of toPurge) {
      const info = del.run(slug) as { changes: number };
      totalDeleted += info.changes;
      console.log(`  Deleted ${info.changes} chunk(s) for slug: ${slug}`);
    }
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }

  console.log(`\nDone. Removed ${totalDeleted} stale chunk(s) across ${toPurge.length} slug(s).`);
  db.close();
}

main();
