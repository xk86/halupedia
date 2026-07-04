/**
 * RagRuntime — the single integration seam between the server/pipeline and the
 * RAG subsystem. Owns the LanceDB store, the embedder, the ontology vocabulary,
 * and the retrieval profiles, and exposes the three operations callers need:
 * retrieve, assemble (evidence), and drain (process indexing jobs).
 *
 * Keeping this seam thin means the pipeline never imports store/jobs/retriever
 * internals directly, and the old retrieval helpers can be deleted without
 * touching call sites again.
 */
import type { DatabaseSync } from "node:sqlite";
import type { LlmRouter } from "../llm";
import type { Logger } from "../logger";
import type { PromptConfig } from "../types";
import { createOntologyDocumentProvider, loadOntologyVocabulary, type OntologyVocabulary } from "../ontology";
import { createTextEmbedder, type TextEmbedder } from "./embeddings";
import { processJobs, type ProcessJobsResult } from "./jobs";
import { assembleEvidence, type AssembledEvidence } from "./promptAssembly";
import { DEFAULT_PROFILES, retrieveContext, type ProfileConfig } from "./retriever";
import { RagStore } from "./store";
import type { RetrievalProfile, RetrievalResult, RetrieveContextArgs } from "./types";

export interface RagRuntimeOptions {
  db: DatabaseSync;
  llm: LlmRouter;
  /** LanceDB directory path (e.g. data/rag.lance). */
  path: string;
  logger?: Logger;
  profiles?: Record<RetrievalProfile, ProfileConfig>;
  vocab?: OntologyVocabulary;
  /** Look up media descriptions (media DB) by id for image_description docs. */
  imageDescriptions?: (mediaIds: string[]) => Map<string, string>;
  /**
   * Enable the cached light-model ontology extraction pass (in addition to
   * deterministic infobox extraction) during background reindexing. Requires
   * `prompts`. Off by default so tests/rebuilds stay deterministic.
   */
  ontologyLlmExtraction?: boolean;
  /** Prompt config, required when `ontologyLlmExtraction` is enabled. */
  prompts?: PromptConfig;
}

export interface RagRuntime {
  readonly store: RagStore;
  readonly embedder: TextEmbedder;
  readonly vocab: OntologyVocabulary;
  readonly profiles: Record<RetrievalProfile, ProfileConfig>;
  retrieve(args: RetrieveContextArgs): Promise<RetrievalResult>;
  assemble(result: RetrievalResult, profile: RetrievalProfile): AssembledEvidence;
  /** Process pending indexing jobs (re-derive docs, embed, upsert to LanceDB). */
  drain(): Promise<ProcessJobsResult>;
  close(): Promise<void>;
}

export async function createRagRuntime(opts: RagRuntimeOptions): Promise<RagRuntime> {
  const store = await RagStore.open(opts.path);
  const embedder = createTextEmbedder(opts.llm);
  const vocab = opts.vocab ?? loadOntologyVocabulary();
  const profiles = opts.profiles ?? DEFAULT_PROFILES;
  const ontologyProvider = createOntologyDocumentProvider(
    opts.db,
    vocab,
    opts.ontologyLlmExtraction && opts.prompts
      ? { llm: opts.llm, prompts: opts.prompts, logger: opts.logger }
      : undefined,
  );

  return {
    store,
    embedder,
    vocab,
    profiles,
    retrieve(args) {
      return retrieveContext(
        { db: opts.db, store, embedder, profiles, logger: opts.logger },
        args,
      );
    },
    assemble(result, profile) {
      return assembleEvidence(result, { maxTokens: profiles[profile].maxPromptTokens });
    },
    drain() {
      return processJobs({
        db: opts.db,
        store,
        embedder,
        logger: opts.logger,
        extraDocuments: ontologyProvider,
        imageDescriptions: opts.imageDescriptions,
      });
    },
    close() {
      return store.close();
    },
  };
}
