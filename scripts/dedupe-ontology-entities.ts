/**
 * Ontology entity de-duplication (one-off data repair).
 *
 * Historically `upsertEntity` keyed a lookup on (canonical_name, entity_type)
 * even for entities that own an article. Whenever an article's subject got
 * reclassified — an infobox subtitle edit, or an accepted entity-type
 * suggestion followed by a later re-extraction recomputing the old type — the
 * old (name, type) row was never found under the new type, so a second row
 * was INSERTed instead of updating the first in place. Both rows kept
 * `article_slug` set, so the article ends up "owning" two entities: one live
 * (holding the real relations) and one orphan stuck at a stale type. Any code
 * that reads/writes "the" article entity via `WHERE article_slug = ? LIMIT 1`
 * (notably the entity-type-suggestion apply endpoint) then non-deterministically
 * picks one of the two — which is why applying/auto-merging a type suggestion
 * sometimes silently "doesn't take": it may be updating the dead orphan.
 *
 * `upsertEntity` itself is now fixed (looks up by article_slug first), so this
 * only needs to run once to clean up rows created before that fix. Safe to
 * run again — it's a no-op once there are no duplicates left.
 *
 * Usage:
 *   npm run db:dedupe-ontology-entities              # apply
 *   npm run db:dedupe-ontology-entities -- --dry-run  # report only
 */
import { resolve } from "node:path";
import { openDatabase } from "../src/server/db";
import { loadConfig } from "../src/server/config";

interface EntityRow {
  id: number;
  canonical_name: string;
  entity_type: string;
  created_at: number;
}

function dbPathFromArgs(): string {
  const flagIndex = process.argv.indexOf("--db");
  if (flagIndex >= 0 && process.argv[flagIndex + 1]) return process.argv[flagIndex + 1];
  return loadConfig().app.storage.database_path;
}

function main(): void {
  const dryRun = process.argv.includes("--dry-run");
  const dbPath = resolve(process.cwd(), dbPathFromArgs());
  console.log(`${dryRun ? "[dry-run] " : ""}Deduping ontology entities: ${dbPath}\n`);

  const db = openDatabase(dbPath);

  const slugs = (
    db
      .prepare(
        `SELECT article_slug FROM entities WHERE article_slug IS NOT NULL
         GROUP BY article_slug HAVING COUNT(*) > 1`,
      )
      .all() as Array<{ article_slug: string }>
  ).map((r) => r.article_slug);

  if (slugs.length === 0) {
    console.log("No duplicate article-owned entities found.");
    db.close();
    return;
  }

  console.log(`${slugs.length} article(s) with duplicate entity rows.\n`);

  const relCount = db.prepare(
    `SELECT
       (SELECT COUNT(*) FROM entity_relations WHERE subject_entity_id = ?) +
       (SELECT COUNT(*) FROM entity_relations WHERE object_entity_id = ?) AS n`,
  );
  const reassignSubject = db.prepare(
    `UPDATE OR IGNORE entity_relations SET subject_entity_id = ? WHERE subject_entity_id = ?`,
  );
  const reassignObject = db.prepare(
    `UPDATE OR IGNORE entity_relations SET object_entity_id = ? WHERE object_entity_id = ?`,
  );
  const dropDupeSubjectRels = db.prepare(`DELETE FROM entity_relations WHERE subject_entity_id = ?`);
  const dropDupeObjectRels = db.prepare(`DELETE FROM entity_relations WHERE object_entity_id = ?`);
  const reassignAliases = db.prepare(
    `INSERT OR IGNORE INTO entity_aliases (entity_id, alias)
     SELECT ?, alias FROM entity_aliases WHERE entity_id = ?`,
  );
  const reassignIdentifiers = db.prepare(
    `INSERT OR IGNORE INTO entity_identifiers (entity_id, scheme, value)
     SELECT ?, scheme, value FROM entity_identifiers WHERE entity_id = ?`,
  );
  const deleteAliases = db.prepare(`DELETE FROM entity_aliases WHERE entity_id = ?`);
  const deleteIdentifiers = db.prepare(`DELETE FROM entity_identifiers WHERE entity_id = ?`);
  const deleteEntity = db.prepare(`DELETE FROM entities WHERE id = ?`);

  let mergedRows = 0;
  for (const slug of slugs) {
    const rows = db
      .prepare(
        `SELECT id, canonical_name, entity_type, created_at FROM entities WHERE article_slug = ? ORDER BY id`,
      )
      .all(slug) as EntityRow[];

    // Keep whichever row actually has relations attached (the "real" one);
    // among ties (or none), keep the most recently touched — it reflects the
    // latest reclassification, deterministic or admin-applied.
    let primary = rows[0];
    let primaryUsage = -1;
    for (const row of rows) {
      const usage = (relCount.get(row.id, row.id) as { n: number }).n;
      if (usage > primaryUsage || (usage === primaryUsage && row.created_at > primary.created_at)) {
        primary = row;
        primaryUsage = usage;
      }
    }

    const losers = rows.filter((r) => r.id !== primary.id);
    console.log(
      `  [${slug}] keeping #${primary.id} (${primary.entity_type}), merging ${losers.map((l) => `#${l.id} (${l.entity_type})`).join(", ")}`,
    );
    if (dryRun) continue;

    for (const loser of losers) {
      reassignSubject.run(primary.id, loser.id);
      reassignObject.run(primary.id, loser.id);
      // Any relation left pointing at the loser after the reassign (a row that
      // already existed for the primary — UPDATE OR IGNORE skipped it to avoid
      // a duplicate) is a redundant copy; drop it rather than leaving it dangling.
      dropDupeSubjectRels.run(loser.id);
      dropDupeObjectRels.run(loser.id);
      reassignAliases.run(primary.id, loser.id);
      reassignIdentifiers.run(primary.id, loser.id);
      deleteAliases.run(loser.id);
      deleteIdentifiers.run(loser.id);
      deleteEntity.run(loser.id);
      mergedRows++;
    }
  }

  db.close();
  console.log(
    dryRun
      ? `\n[dry-run] would merge ${slugs.reduce((n, s) => n, 0)} article(s); no writes performed.`
      : `\nMerged ${mergedRows} duplicate row(s) across ${slugs.length} article(s).`,
  );
}

main();
