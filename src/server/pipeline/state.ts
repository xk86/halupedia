/**
 * Canonical PipelineState — the single shared, typed object that flows
 * through every workflow node.
 *
 * Design rules (enforced elsewhere; documented here):
 *
 *   1. Every field is **explicit**. There are no lazy getters, no hidden
 *      database accessors, no "fetch on first read". If a node needs data,
 *      a prior read-node must have populated it.
 *
 *   2. Every field is **declared**. A node may only touch fields listed in
 *      its `reads` and `writes` arrays — see `runtime/nodeFactory.ts`.
 *
 *   3. Fields are append-only or replace-only — no in-place mutation. The
 *      runtime computes diffs between successive states for the trace.
 *
 *   4. **References, see-also, and traces are sidecar.** They live as
 *      first-class state fields, never embedded in `articleBody` markdown.
 *
 * State is partitioned into three layers:
 *   - input:        what the workflow was invoked with (immutable per run)
 *   - intermediate: produced and consumed by nodes
 *   - output:       the persisted result(s)
 *
 * Each individual workflow defines a subset of this state — the global
 * shape here is the union, not a requirement that every workflow populates
 * every field.
 */

import { z } from "zod";

// ─── Identifiers ─────────────────────────────────────────────────────────────

export const SlugSchema = z
  .string()
  .min(1)
  .regex(/^[a-z0-9-]+$/);
export type Slug = z.infer<typeof SlugSchema>;

// ─── Input layer ─────────────────────────────────────────────────────────────

export const WorkflowInputSchema = z.object({
  /** Stable id for the originating request — surfaced in traces. */
  requestId: z.string(),
  /** Workflow kind, e.g. "article.generate" / "article.rewrite". */
  workflow: z.string(),
  /** Slug the workflow operates on (may be empty for slug-less workflows). */
  slug: z.string().optional(),
  /** Display title submitted by the caller. */
  requestedTitle: z.string().optional(),
  /** Free-text instructions for rewrite/refresh/edit workflows. */
  instructions: z.string().optional(),
  /** Slugs the caller wants forcibly included in the reference list. */
  pinnedSlugs: z.array(SlugSchema).optional(),
  /** Slugs the caller explicitly selected as user-added references. */
  userReferenceSlugs: z.array(SlugSchema).optional(),
  /** Slugs the caller wants forcibly excluded from the reference list. */
  blacklistSlugs: z.array(SlugSchema).optional(),
  /** Caller-explicit reference selection (overrides RAG when present). */
  selectedReferenceSlugs: z.array(SlugSchema).nullable().optional(),

  // Rewrite-specific options ─────────────────────────────────────────────────
  /** Plain text the user selected (selection-edit path). */
  selectedText: z.string().optional(),
  /** Section id to rewrite (section-rewrite path). */
  targetSectionId: z.string().optional(),
  /** True when RAG retrieval should be driven by ragQuery. */
  ragEnabled: z.boolean().optional(),
  /** Free-text query for RAG retrieval (rewrite path). */
  ragQuery: z.string().optional(),
  /** Rewrite mode label (e.g. "subtle", "aggressive"). */
  rewriteModeName: z.string().optional(),
  /** True when user explicitly initiated a manual edit (bypasses protection). */
  isManualEdit: z.boolean().optional(),
  /** Include recent edit history in the prompt. */
  includeRecentEditHistory: z.boolean().optional(),

  // Deterministic save-specific options ─────────────────────────────────────
  /** Caller-provided markdown for no-LLM save workflows. */
  rawMarkdown: z.string().optional(),

  // Image caption-specific ─────────────────────────────────────────────────
  /** Media DB id of the image to caption. */
  imageId: z.string().optional(),
  /** Whether article.image_generate may replace an existing headline image. */
  imageReplace: z.boolean().optional(),
  /** Article-image preset key used for article.image_generate. */
  imagePromptKey: z.string().optional(),
  /** Article-image aspect ratio key used for article.image_generate. */
  imageAspectRatioKey: z.string().optional(),

  // Random-page-specific ─────────────────────────────────────────────────────
  /** Existing articles offered to the model as inspiration for a random pick. */
  inspiration: z
    .array(z.object({ slug: z.string(), title: z.string() }))
    .optional(),
});
export type WorkflowInput = z.infer<typeof WorkflowInputSchema>;

// ─── Intermediate / output layer pieces ──────────────────────────────────────

/** A reference entry as it exists inside the pipeline (sidecar, not body). */
export const ReferenceEntrySchema = z.object({
  slug: SlugSchema,
  title: z.string(),
  content: z.string(),
  kind: z.enum(["summary", "chunk"]),
  pinned: z.boolean(),
  score: z.number().optional(),
  source: z
    .enum(["body", "user", "prior", "rag", "recursive", "pinned"])
    .optional(),
});
export type ReferenceEntry = z.infer<typeof ReferenceEntrySchema>;

/** A see-also candidate. May point at an article that does not yet exist. */
export const SeeAlsoEntrySchema = z.object({
  slug: SlugSchema,
  title: z.string(),
  hint: z.string(),
});
export type SeeAlsoEntry = z.infer<typeof SeeAlsoEntrySchema>;

/** Snapshot of an article loaded from the DB. */
export const LoadedArticleSchema = z
  .object({
    slug: SlugSchema,
    canonicalSlug: SlugSchema,
    title: z.string(),
    body: z.string(),
    summary: z.string(),
    generatedAt: z.number(),
  })
  .nullable();
export type LoadedArticle = z.infer<typeof LoadedArticleSchema>;

/** Retrieved context from RAG; structured, never raw concatenated prose. */
export const RetrievedContextSchema = z.object({
  sourceArticles: z.array(
    z.object({
      slug: SlugSchema,
      title: z.string(),
      content: z.string(),
      score: z.number().optional(),
    }),
  ),
  ragTitles: z.array(z.string()),
  backlinks: z.array(z.object({ slug: SlugSchema, title: z.string() })),
  // Diagnostics about how retrieval ranked chunks (embeddings vs lexical
  // fallback, which host served the query embedding). Surfaced in the admin
  // RAG trace; absent when no semantic retrieval ran.
  embedding: z
    .object({
      strategy: z.string(),
      model: z.string().optional(),
      host: z.string().optional(),
      baseUrl: z.string().optional(),
      dimensions: z.number().optional(),
      corpusChunks: z.number().optional(),
      embeddedChunks: z.number().optional(),
    })
    .optional(),
});
export type RetrievedContext = z.infer<typeof RetrievedContextSchema>;

/**
 * The exact RAG-related values interpolated into a render node's prompt, plus
 * retrieval diagnostics. Captured verbatim so the admin trace can show, byte for
 * byte, the evidence and link allowlist the model actually received — never a
 * reconstruction. Evidence (`evidenceContext`) and the link allowlist
 * (`linkAllowlist`) are distinct prompt variables and stay distinct here.
 */
export const RagPromptTraceSchema = z.object({
  promptKey: z.string(),
  evidenceContext: z.string(),
  linkAllowlist: z.string(),
  relatedTitles: z.string(),
  linkHints: z.string(),
  articleVibe: z.string(),
  retrieval: z.object({
    strategy: z.string().optional(),
    model: z.string().optional(),
    host: z.string().optional(),
    dimensions: z.number().optional(),
    candidates: z.array(
      z.object({
        slug: z.string(),
        title: z.string(),
        score: z.number().optional(),
        contentChars: z.number(),
      }),
    ),
  }),
});
export type RagPromptTrace = z.infer<typeof RagPromptTraceSchema>;

/** A rendered prompt — kept in state so trace can show exactly what was sent. */
export const RenderedPromptSchema = z.object({
  /** Registry key, e.g. "article", "article_summary". */
  key: z.string(),
  /** Content-hash of the underlying template (detects prompt drift). */
  templateHash: z.string(),
  /** Role of the LLM target — "heavy" or "light". */
  role: z.enum(["heavy", "light"]),
  system: z.string(),
  user: z.string(),
  /** Hash of the fully-rendered system+user text (replay fingerprint). */
  renderedHash: z.string(),
  /** Variable bag handed to the template — kept verbatim for replay. */
  variables: z.record(z.string(), z.unknown()),
  thinking: z.boolean(),
  json: z.boolean(),
});
export type RenderedPrompt = z.infer<typeof RenderedPromptSchema>;

/** Raw model output + structural finish-reason metadata. */
export const LlmOutputSchema = z.object({
  promptKey: z.string(),
  text: z.string(),
  finishReason: z.string(),
  durationMs: z.number(),
  ttftMs: z.number().optional(),
  /** sha256 of `text` — referenced by downstream nodes for cache lookups. */
  contentHash: z.string(),
});
export type LlmOutput = z.infer<typeof LlmOutputSchema>;

/** A diagnostic captured by a validation node. */
export const ValidationIssueSchema = z.object({
  code: z.string(),
  severity: z.enum(["info", "warn", "error"]),
  message: z.string(),
  field: z.string().optional(),
});
export type ValidationIssue = z.infer<typeof ValidationIssueSchema>;

// ─── The state shape itself ──────────────────────────────────────────────────

export const PipelineStateSchema = z.object({
  // input ───────────────────────────────────────────────────────────────────
  input: WorkflowInputSchema,

  // identity (populated by read/derive nodes) ────────────────────────────────
  canonicalSlug: SlugSchema.optional(),
  canonicalTitle: z.string().optional(),
  displayTitle: z.string().optional(),

  // loaded article (for rewrite/refresh paths) ───────────────────────────────
  loadedArticle: LoadedArticleSchema.optional(),
  /** Recent edit revisions, formatted for prompt or sentinel-string downstream. */
  recentEditHistory: z.string().optional(),
  /** Per-article canonical "vibe": human-authored ground truth, never RAG'd.
   *  Injected into generation/rewrite prompts; for rewrites it is the edit
   *  instruction the model conforms the article to. */
  articleVibe: z.string().optional(),

  // retrieval ────────────────────────────────────────────────────────────────
  retrievedContext: RetrievedContextSchema.optional(),
  /** Exact RAG values placed into the prompt (for the admin trace). */
  ragPromptTrace: RagPromptTraceSchema.optional(),

  // references / see-also (sidecar, never in body markdown) ──────────────────
  references: z.array(ReferenceEntrySchema).optional(),
  /** References saved on a prior revision; used to keep continuity. */
  priorReferences: z.array(ReferenceEntrySchema).optional(),
  seeAlso: z.array(SeeAlsoEntrySchema).optional(),

  // prompt + model ───────────────────────────────────────────────────────────
  renderedPrompt: RenderedPromptSchema.optional(),
  llmOutput: LlmOutputSchema.optional(),

  // body markdown — progressively transformed by deterministic nodes ─────────
  /** Parsed body extracted from raw LLM output (frame stripped, prose only). */
  rawArticleBody: z.string().optional(),
  /** After deterministic normalization (link normalize, sanitize, etc). */
  articleBody: z.string().optional(),
  /** Final body markdown that will be persisted. */
  finalArticleBody: z.string().optional(),
  /** Generated summary markdown (sidecar; not embedded in body). */
  articleSummary: z.string().optional(),

  // validation results ───────────────────────────────────────────────────────
  validationIssues: z.array(ValidationIssueSchema).optional(),

  // persistence outcome ──────────────────────────────────────────────────────
  persistedAt: z.number().optional(),
  persistedRevisionId: z.number().optional(),

  // post-process specifics ───────────────────────────────────────────────────
  /** Timestamp the article was at when post-process started (staleness guard). */
  postProcessExpectedGeneratedAt: z.number().optional(),
  /** Whether the article has section-level protection locks. */
  protectedSectionIds: z.array(z.string()).optional(),
  /** Whether the whole article is protection-locked (skips LLM rewrites). */
  isProtected: z.boolean().optional(),
  /** Markdown for the selection range being rewritten (partial-rewrite path). */
  selectedMarkdown: z.string().optional(),
  /** Character range within the full article markdown for the selected text. */
  selectionRange: z
    .object({ start: z.number(), end: z.number() })
    .nullable()
    .optional(),
  /** Section id being rewritten (section-rewrite path). */
  sectionId: z.string().optional(),
  /** Rewrite mode label (from rewriteModes config). */
  rewriteMode: z.string().optional(),

  // RAG indexing ─────────────────────────────────────────────────────────────
  /** True once RAG chunks have been re-indexed for this article. */
  ragIndexed: z.boolean().optional(),

  // Ontology ─────────────────────────────────────────────────────────────────
  /** Outcome of synchronous ontology extraction (post-process only) — the
   *  trace pane's window into what facts were derived and why an LLM was
   *  (or wasn't) called. */
  ontologyExtraction: z
    .object({
      entities: z.number(),
      relations: z.number(),
      categories: z.number(),
      llmEnabled: z.boolean(),
      llmReason: z.string().optional(),
      extraction: z
        .object({
          entities: z.array(
            z.object({
              name: z.string(),
              type: z.string(),
              articleSlug: z.string().optional(),
              aliases: z.array(z.string()).optional(),
              identifiers: z
                .array(z.object({ scheme: z.string(), value: z.string() }))
                .optional(),
              description: z.string().optional(),
            }),
          ),
          relations: z.array(
            z.object({
              subject: z.string(),
              predicate: z.string(),
              object: z.string(),
              objectSlug: z.string().optional(),
              objectIsLiteral: z.boolean().optional(),
              source: z.enum(["infobox", "extracted", "curated", "inferred"]),
              confidence: z.number().optional(),
              inferredFrom: z.string().optional(),
            }),
          ),
          categories: z.array(z.string()),
        })
        .optional(),
    })
    .optional(),

  // Homepage ────────────────────────────────────────────────────────────────
  /** Homepage cache payload produced by homepage.refresh. */
  homepagePayload: z.unknown().optional(),

  // Infobox ────────────────────────────────────────────────────────────────
  /** LLM-generated infobox data (post-process only). */
  infobox: z.unknown().optional(),

  // Headline image context (for prompt injection) ──────────────────────────
  /** Formatted description of the current article's headline image, or ""
   *  if none attached. Injected into generation/rewrite/refresh prompts. */
  headlineImageContext: z.string().optional(),

  // Random page ──────────────────────────────────────────────────────────────
  /** Title/slug the model chose for a random page (random.page workflow). */
  randomPageChoice: z
    .object({ slug: z.string(), title: z.string() })
    .optional(),

  // Image caption ──────────────────────────────────────────────────────────
  /** LLM-generated caption result for the image.caption workflow. */
  imageCaptionResult: z
    .object({
      description: z.string(),
      /** Per-article short caption generated from description + article context. */
      articleCaption: z.string().optional(),
    })
    .optional(),

  // Image generation ───────────────────────────────────────────────────────
  /** First-pass article-image preset selected for article.image_generate. */
  initialImagePromptKey: z.string().optional(),
  /** Single-sentence reason for the first-pass article-image preset selection. */
  initialImagePromptReason: z.string().optional(),
  /** Best article-image preset challenger to compare with the first-pass selection. */
  challengerImagePromptKey: z.string().optional(),
  /** Single-sentence reason for the article-image preset challenger. */
  challengerImagePromptReason: z.string().optional(),
  /** Concrete article-image preset selected for article.image_generate. */
  selectedImagePromptKey: z.string().optional(),
  /** Single-sentence reason for the final concrete article-image preset selection. */
  selectedImagePromptReason: z.string().optional(),
  /** Concrete image aspect ratio selected for article.image_generate. */
  selectedImageAspectRatioKey: z.string().optional(),
  /** Single-sentence reason for the selected image aspect ratio. */
  selectedImageAspectRatioReason: z.string().optional(),
  /** Generated headline image attachment result for article.image_generate. */
  imageGenerationResult: z
    .object({
      mediaId: z.string(),
      isNew: z.boolean(),
      width: z.number(),
      height: z.number(),
      backend: z.string(),
      model: z.string(),
      presetKey: z.string().optional(),
      aspectRatioKey: z.string().optional(),
      revisedPrompt: z.string().optional(),
    })
    .optional(),
});
export type PipelineState = z.infer<typeof PipelineStateSchema>;

/** Type-safe field name. All node `reads` / `writes` must be one of these. */
export type PipelineStateKey = keyof PipelineState;

/** Convenience: a "patch" emitted by a node — partial state replacing fields. */
export type PipelineStatePatch = Partial<PipelineState>;

/** Build an initial state object from a workflow input. */
export function initialPipelineState(input: WorkflowInput): PipelineState {
  return { input };
}
