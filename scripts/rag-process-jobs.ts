/**
 * Drain pending RAG indexing jobs into LanceDB. Used to recover after a crash
 * or to flush jobs enqueued while the indexer wasn't running.
 *
 *   npm run rag:process-jobs
 */
import { countPendingRagJobs } from "../src/server/db";
import { openRagScriptContext } from "./ragScript";

async function main() {
  const ctx = await openRagScriptContext();
  try {
    const before = countPendingRagJobs(ctx.db);
    if (before === 0) {
      console.log("rag:process-jobs — no pending jobs.");
      return;
    }
    console.log(`rag:process-jobs — ${before} pending job(s); model=${ctx.textModel}`);
    let total = 0;
    let guard = 0;
    while (countPendingRagJobs(ctx.db) > 0 && guard < 10_000) {
      const res = await ctx.rag.drain();
      total += res.documentsUpserted;
      if (res.articlesProcessed === 0 && res.articlesDeleted === 0 && res.failures === 0) break;
      guard += 1;
    }
    const pending = countPendingRagJobs(ctx.db);
    console.log(`rag:process-jobs done — ${total} document(s) upserted; ${pending} still pending.`);
    if (pending > 0) process.exitCode = 1;
  } finally {
    await ctx.close();
  }
}

main().catch((err) => {
  console.error("rag:process-jobs failed:", err);
  process.exit(1);
});
