/** Public surface of the LanceDB-backed RAG subsystem. */
export * from "./types";
export {
  chunkMarkdown,
  countTokens,
  DEFAULT_CHUNKER_OPTIONS,
  type BodySegment,
  type ChunkerOptions,
} from "./chunker";
export {
  contentHash,
  buildBodyDocuments,
  buildSummaryDocument,
  buildInfoboxDigest,
  buildInfoboxFacts,
  buildLinkHintDocuments,
  buildImageTextDocuments,
  type LinkHintInput,
  type ImageTextInput,
} from "./documents";
export { RagStore, type TextQueryHit, type TextQueryOptions } from "./store";
export { createTextEmbedder, type TextEmbedder, type EmbedResult } from "./embeddings";
export {
  retrieveContext,
  DEFAULT_PROFILES,
  type RetrieverDeps,
  type ProfileConfig,
} from "./retriever";
export { processJobs, type ProcessJobsDeps, type ProcessJobsResult } from "./jobs";
