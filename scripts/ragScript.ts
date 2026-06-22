/**
 * Shared bootstrap for the RAG CLI scripts (check / rebuild / process-jobs).
 * Builds a RagRuntime against the real configured database + embedding host.
 */
import { createHash } from "node:crypto";
import { loadConfig } from "../src/server/config";
import { openDatabase } from "../src/server/db";
import { openMediaDatabase, getMediaById } from "../src/server/mediaDb";
import { OpenAICompatRouter } from "../src/server/llm";
import { createConsoleLogger } from "../src/server/logger";
import { createRagRuntime, type RagRuntime } from "../src/server/rag";
import { DEFAULT_CHUNKER_OPTIONS } from "../src/server/rag/chunker";
import { loadOntologyVocabulary } from "../src/server/ontology";

export const SCHEMA_VERSION = 1;

export interface RagScriptContext {
  db: ReturnType<typeof openDatabase>;
  mediaDb: ReturnType<typeof openMediaDatabase>;
  llm: OpenAICompatRouter;
  rag: RagRuntime;
  app: ReturnType<typeof loadConfig>["app"];
  textModel: string;
  ragPath: string;
  configHash: string;
  chunkerVersion: number;
  vocabHash: string;
  close(): Promise<void>;
}

export function ragLancePath(app: ReturnType<typeof loadConfig>["app"]): string {
  return (app.rag as { path?: string }).path ?? "data/rag.lance";
}

export function corpusConfigHash(textModel: string, chunkerVersion: number, vocabHash: string): string {
  return createHash("sha256")
    .update(`${SCHEMA_VERSION}|${textModel}|chunk:${chunkerVersion}|vocab:${vocabHash}`)
    .digest("hex")
    .slice(0, 16);
}

export async function openRagScriptContext(): Promise<RagScriptContext> {
  const runtime = loadConfig();
  const logger = createConsoleLogger();
  const db = openDatabase(runtime.app.storage.database_path);
  const mediaDb = openMediaDatabase(runtime.app.images.media_database_path);
  const llm = new OpenAICompatRouter(runtime.llm, logger);
  await llm.probeConnections();

  const vocab = loadOntologyVocabulary();
  const ragPath = ragLancePath(runtime.app);
  const rag = await createRagRuntime({
    db,
    llm,
    path: ragPath,
    logger,
    vocab,
    imageDescriptions: (ids) => {
      const map = new Map<string, string>();
      for (const id of ids) {
        const desc = getMediaById(mediaDb, id)?.description ?? "";
        if (desc) map.set(id, desc);
      }
      return map;
    },
  });

  const textModel = rag.embedder.model;
  return {
    db,
    mediaDb,
    llm,
    rag,
    app: runtime.app,
    textModel,
    ragPath,
    configHash: corpusConfigHash(textModel, DEFAULT_CHUNKER_OPTIONS.version, vocab.hash),
    chunkerVersion: DEFAULT_CHUNKER_OPTIONS.version,
    vocabHash: vocab.hash,
    async close() {
      await rag.close();
      db.close();
      mediaDb.close();
    },
  };
}

export function listLiveArticleSlugs(db: ReturnType<typeof openDatabase>): string[] {
  return (db.prepare(`SELECT slug FROM articles ORDER BY slug`).all() as Array<{ slug: string }>).map(
    (r) => r.slug,
  );
}
