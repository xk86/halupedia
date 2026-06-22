/**
 * Text embedding adapter — wraps the existing OpenAI-compatible `llm.embed`
 * with bounded batching and a stable model id for corpus metadata.
 *
 * Phase 2 will add a multimodal image embedding path here against the user's
 * CLIP-style endpoint; the text path stays unchanged.
 */
import type { HostEndpoint, LlmRouter } from "../llm";

export interface EmbedResult {
  vectors: number[][];
  model: string;
  host?: string;
  dimensions?: number;
}

const DEFAULT_BATCH = 64;

export interface TextEmbedder {
  readonly model: string;
  embed(texts: string[]): Promise<EmbedResult>;
}

/** Build a batching text embedder over the LLM router's embeddings role. */
export function createTextEmbedder(llm: LlmRouter, batchSize = DEFAULT_BATCH): TextEmbedder {
  const model = llm.embeddingInfo?.().model ?? "unknown";
  return {
    model,
    async embed(texts: string[]): Promise<EmbedResult> {
      if (texts.length === 0) return { vectors: [], model };
      const vectors: number[][] = [];
      let host: string | undefined;
      for (let i = 0; i < texts.length; i += batchSize) {
        const batch = texts.slice(i, i + batchSize);
        const part = await llm.embed(batch, (endpoint: HostEndpoint) => {
          host = endpoint.hostId;
        });
        vectors.push(...part);
      }
      return { vectors, model, host, dimensions: vectors[0]?.length };
    },
  };
}
