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
  toLegacyView,
  DEFAULT_PROFILES,
  type RetrieverDeps,
  type ProfileConfig,
  type LegacyRetrievalView,
} from "./retriever";
export { processJobs, type ProcessJobsDeps, type ProcessJobsResult } from "./jobs";
export {
  assembleEvidence,
  renderLinkAllowlist,
  type AssembledEvidence,
  type LinkAllowlistEntry,
} from "./promptAssembly";
export {
  createRagRuntime,
  type RagRuntime,
  type RagRuntimeOptions,
} from "./runtime";
