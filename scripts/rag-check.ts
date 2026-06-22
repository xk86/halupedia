/**
 * Validate the active corpus against current config: schema/chunker/model/vocab
 * and presence of a completed build. Exits non-zero on any mismatch so it can
 * gate CI / startup.
 *
 *   npm run rag:check
 */
import { DEFAULT_CHUNKER_OPTIONS } from "../src/server/rag/chunker";
import { openRagScriptContext, SCHEMA_VERSION } from "./ragScript";

async function main() {
  const ctx = await openRagScriptContext();
  try {
    const meta = await ctx.rag.store.readMeta();
    if (!meta) {
      console.error(`rag:check FAIL — no corpus metadata at ${ctx.ragPath}. Run: npm run rag:rebuild`);
      process.exitCode = 1;
      return;
    }
    const problems: string[] = [];
    if (!meta.buildComplete) problems.push("previous build did not complete");
    if (meta.schemaVersion !== SCHEMA_VERSION) problems.push(`schema ${meta.schemaVersion} != ${SCHEMA_VERSION}`);
    if (meta.chunkerVersion !== DEFAULT_CHUNKER_OPTIONS.version) problems.push(`chunker ${meta.chunkerVersion} != ${DEFAULT_CHUNKER_OPTIONS.version}`);
    if (meta.textEmbeddingModel !== ctx.textModel) problems.push(`text model '${meta.textEmbeddingModel}' != '${ctx.textModel}'`);
    if (meta.configHash !== ctx.configHash) problems.push("config hash mismatch (model/chunker/vocabulary changed)");

    if (problems.length) {
      console.error(`rag:check FAIL — corpus is stale/invalid:`);
      for (const p of problems) console.error(`  - ${p}`);
      console.error(`Run: npm run rag:rebuild`);
      process.exitCode = 1;
      return;
    }
    const rows = await ctx.rag.store.countRows();
    console.log(`rag:check OK — schema=${meta.schemaVersion} chunker=${meta.chunkerVersion} model=${meta.textEmbeddingModel} dims=${meta.vectorDimensions} docs=${rows}`);
    console.log(`counts by kind: ${JSON.stringify(meta.documentCountsByKind)}`);
  } finally {
    await ctx.close();
  }
}

main().catch((err) => {
  console.error("rag:check failed:", err);
  process.exit(1);
});
