/**
 * Offline corpus rebuild.
 *
 *   npm run rag:rebuild               # rebuild the whole corpus
 *   npm run rag:rebuild -- --dry-run  # report only, write nothing
 *   npm run rag:rebuild -- --slug foo # rebuild a single article
 *
 * Enqueues upsert jobs for live articles, drains them into LanceDB (real
 * embeddings + ontology extraction), then writes corpus metadata last.
 */
import {
  countPendingRagJobs,
  enqueueRagIndexJob,
} from "../src/server/db";
import { DEFAULT_CHUNKER_OPTIONS } from "../src/server/rag/chunker";
import { listLiveArticleSlugs, openRagScriptContext, SCHEMA_VERSION } from "./ragScript";

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const slugIdx = args.indexOf("--slug");
  const onlySlug = slugIdx >= 0 ? args[slugIdx + 1] : undefined;

  const ctx = await openRagScriptContext();
  try {
    const slugs = onlySlug ? [onlySlug] : listLiveArticleSlugs(ctx.db);
    console.log(`rag:rebuild — ${slugs.length} article(s); model=${ctx.textModel}; path=${ctx.ragPath}`);

    if (dryRun) {
      console.log(`[dry-run] would enqueue + index ${slugs.length} article(s); no writes performed.`);
      return;
    }

    // A full rebuild starts from a clean table so a stale/mis-inferred schema
    // can't survive (and so articles deleted since the last build leave no
    // orphan rows). A single-article rebuild merges into the existing corpus.
    if (!onlySlug) {
      await ctx.rag.store.dropTextTable();
      console.log("dropped existing rag_text_documents table for a clean rebuild");
    }

    for (const slug of slugs) {
      enqueueRagIndexJob(ctx.db, { articleSlug: slug, sourceKind: "article_body", sourceId: slug, operation: "upsert" });
    }

    let totalDocs = 0;
    let guard = 0;
    while (countPendingRagJobs(ctx.db) > 0 && guard < 10_000) {
      const res = await ctx.rag.drain();
      totalDocs += res.documentsUpserted;
      if (res.articlesProcessed === 0 && res.articlesDeleted === 0 && res.failures === 0) break;
      guard += 1;
    }

    const counts = await ctx.rag.store.countByKind();
    const dims = (await ctx.rag.embedder.embed(["dimension probe"])).vectors[0]?.length ?? 0;
    await ctx.rag.store.writeMeta({
      schemaVersion: SCHEMA_VERSION,
      chunkerVersion: DEFAULT_CHUNKER_OPTIONS.version,
      textEmbeddingModel: ctx.textModel,
      imageEmbeddingModel: "",
      vectorDimensions: dims,
      configHash: ctx.configHash,
      sourceDatabaseId: ctx.app.storage.database_path,
      buildTimestamp: Date.now(),
      buildComplete: true,
      documentCountsByKind: counts,
    });

    const pending = countPendingRagJobs(ctx.db);
    console.log(`rag:rebuild done — ${totalDocs} documents upserted; dims=${dims}; pending jobs=${pending}`);
    console.log(`document counts by kind: ${JSON.stringify(counts)}`);
    if (pending > 0) {
      console.error(`WARNING: ${pending} job(s) still pending (see rag_index_jobs.last_error)`);
      process.exitCode = 1;
    }
  } finally {
    await ctx.close();
  }
}

main().catch((err) => {
  console.error("rag:rebuild failed:", err);
  process.exit(1);
});
