# Prompt Configuration

Each `.toml` file in this directory defines a single prompt template. The filename (minus `.toml`) becomes the prompt key used in code (e.g., `article_refresh.toml` -> key `article_refresh`).

## File Structure

```toml
system = """
Your system prompt here."""

user = """
Your user prompt here, with {{template_vars}}."""
```

Both `system` and `user` keys must be present. Either may be empty (`""`).

## How It Works

The config loader scans this directory for all `.toml` files at startup. Each file is parsed and its `system`/`user` values become the prompt template, keyed by filename. No manifest or registry file is needed -- just add a `.toml` file here and it's available via `config.prompts.prompts[key]`.

## Template Variables

Prompts use `{{variable_name}}` placeholders that are substituted at runtime. Common variables:

- `{{requested_title}}` - the article title being generated/edited
- `{{current_article}}` - existing article content (for refresh/rewrite)
- `{{rag_context}}` - retrieved context from RAG
- `{{link_hints}}` - incoming canonical references
- `{{related_titles}}` - existing related Halupedia topics
- `{{rules}}` - expands to the prompt's assembled rule-library text (see "Rule library" below)

## Adding a New Prompt

Create `config/prompts/my_prompt.toml` with `system` and `user` keys. It will be automatically loaded and accessible as `prompts.prompts.my_prompt` in server code.

## Prompt Catalog

Every prompt currently shipped in this directory. Each entry says *what* the prompt asks the model to produce, *where* in the code it gets invoked, and *why* the system needs it.

### Article-body prompts (`heavy` model, streaming)

| File | Invoked at | Purpose |
|---|---|---|
| `article.toml` | `index.ts` — `buildArticleBody` (page generation path) | Initial generation of a brand-new article from a requested title + RAG context. Streams Markdown that becomes the article body. |
| `article_refresh.toml` | `index.ts` — `/api/article/:slug/refresh-context` handler | Re-write an existing article using newly-retrieved RAG context. Keeps the same topic, fixes link/ref syntax, and reincorporates current sources. |
| `article_rewrite.toml` | `index.ts` — `/api/article/:slug/rewrite` handler | Vibe-only rewrite. Conforms the article to its persistent canonical vibe without receiving one-off edit instructions. |
| `article_quick_edit.toml` | `index.ts` — `/api/article/:slug/rewrite` handler | One-off instructed rewrite. Applies `edit_instructions` once while preserving the persistent article vibe. |

### Post-processing & analysis (`heavy` or `light`)

| File | Invoked at | Purpose |
|---|---|---|
| `see_also.toml` | `index.ts` — `postProcessArticle` (background after generation) | Generate the algorithmic "See also" sidecar — related-topic suggestions that may or may not exist yet in the DB. |
| `link_recheck.toml` | `index.ts` — `verifyLinkQuality` (after generation) | Asks the model to inspect generated halu links for plausibility and suggest fixes. Skipped when there are no links. |
| `link_repair.toml` | `index.ts` — link-repair pass during generation/refresh | Fixes broken or malformed link syntax in the generated body (unmatched quotes, bracket mistakes, etc). |
| `article_summary.toml` | `index.ts` — admin summary regeneration; `summarizeRetrievedSource` | Produce or refresh the one-paragraph article summary stored in `articles.summary_markdown` and shown in backlinks/refs. |

### Selection-edit (highlight → add link) prompts (`light` model usually)

| File | Invoked at | Purpose |
|---|---|---|
| `link_selection.toml` | deprecated / unused | Selection refinement is bounded code in `/api/article/:slug/add-link`; do not call an LLM to choose anchor text. |
| `link_suggestion.toml` | `index.ts` — `generateLinkSuggestion` (called from `/api/article/:slug/add-link`) | Given a bounded selection + surrounding excerpt, returns `{slug, description}` JSON used to build the `[label](halu:slug "hint")` wrap. |

### Homepage / discovery (`light` model)

| File | Invoked at | Purpose |
|---|---|---|
| `did_you_know.toml` | `index.ts` — `generateDykFact` (homepage maintenance) | Generates a single "Did you know…" fact rotated on the homepage; output is forced to link back to its source article. |
| `random_page.toml` | `index.ts` — `/api/random` handler | Generates a brand-new random article slug+title pair to seed exploration when the random-page button is used. |

### Comment system (`light` model)

| File | Invoked at | Purpose |
|---|---|---|
| `identity.toml` | `comments.ts` — `generateIdentity` | Manufactures a fictional commenter (display name + username) when a new pseudo-user is needed for the local comment system. |
| `comment.toml` | `comments.ts` — comment generation | Produces a fictional reply comment in JSON, optionally responding to a parent comment. |

### Shared (template fragments, not invoked directly)

Files under `shared/` are NEVER invoked directly.

| File | Used by |
|---|---|
| `shared/shared_rewrite_modes.toml` | `{{rewrite_mode}}` blurb expanded into vibe rewrites, quick edits, and article refreshes. Its `[modes.*]` tables feed `config.prompts.rewriteModes` directly — a parameterized template selected by a `mode` variable, not a set of rules to assemble, so it's out of scope for the rule-library migration below. |

### Rule library

Every prompt has migrated off the old `{{shared_*}}` template fragments and onto the flat, tiered rule library under `config/rules/` — see `src/server/rules/`. A prompt's `[rules]` table has two explicit lists:

- `categories`: shared groups included in full. Adding `"canon"` makes every Canon foundations rule available to the prompt.
- `rules`: rare individual additions written as `"category/rule_id"` when including the whole category would be too broad.

Prompt files do not use tier ranges, exclusions, or inline rule blocks. Rule wording lives in one independently editable flat file under `config/rules/`; prompt files only choose the categories they need. The prompt's `{{rules}}` template variable marks where the assembled rule text is inserted, but the admin UI handles that detail and does not expose it as a user-facing placeholder.

`article_rewrite.toml`/`article_quick_edit.toml` additionally need a rule selection that varies per render call (full-article vs. section/selection scope), not just per prompt. `RenderRuntimeOptions.extraInclude` remains an internal mechanism for this one dynamic case: `renderRewritePromptNode` selects the `output_contract/full_article_*` or `output_contract/partial_scope_*` pair based on whether the edit is partial.

## RAG Context Sources

Article-body prompts (`article`, `article_refresh`, `article_rewrite`, `article_quick_edit`) get THREE distinct streams of context. Each has its own provenance and is exposed under its own template variable so the model never has to guess where a fact came from. Logs use matching names so prompt-context provenance is traceable end-to-end.

| Template variable | Source table | Helper / function | What it is |
|---|---|---|---|
| `{{link_hints}}` | `article_links` | `listIncomingHints` → `formatIncomingHintsForPrompt` | Halu-style link templates from articles that link TO the target. Each line is `[label](halu:source-slug "hidden_hint")`. The `hidden_hint` is canon written by past generations — the strongest "what does the rest of the wiki already say about me" signal. |
| `{{rag_context}}` | LanceDB `rag_text_documents` | profile-based `rag.retrieve` | Retrieved typed documents mapped into article evidence for the prompt. Document kinds include body, summary, infobox, link hints, image text, and ontology facts according to the active retrieval profile. |
| `{{related_titles}}` | LanceDB candidates **and** `article_links` | `formatRelatedTitlesForPrompt` | Bulleted titles from retrieved document candidates plus graph-adjacent backlink titles. Evidence inclusion and linkability remain separate. |

### Per-source log fields

When the article-body path runs, `build.article_rag_retrieved` logs the breakdown so each context stream is auditable:

| Log field | Source | Meaning |
|---|---|---|
| `rag_chunk_sources` | `retrieveContext` | Count of chunks picked above `reference_min_score`. |
| `rag_chunk_titles` | `retrieveContext` → `formatRelatedTitlesForPrompt` | Unique titles from RAG chunks appearing in `related_titles`. |
| `backlink_titles` | `listBacklinks` → `formatRelatedTitlesForPrompt` | Unique titles from `article_links` (and live scan) appearing in `related_titles`. |
| `incoming_link_hints` | `listIncomingHints` | Count of `article_links` rows that became `{{link_hints}}` entries. |
| `related_titles_total` | merged | Sum of unique titles after deduping across both sources. |

### Why `article_links` correctness matters beyond the backlinks UI

`article_links` is the substrate for TWO context streams (`{{link_hints}}` AND the backlinks half of `{{related_titles}}`) plus the visible backlinks panel. A missing or stale row degrades:

1. The visible "Referenced by" sidebar.
2. The hidden-hint canon the LLM gets when generating the target article.
3. The graph-adjacent titles offered as inspiration alongside RAG chunks.

`extractAllBodyLinks` (in `src/server/referenceList.ts`) is the single chokepoint that keeps the table accurate; it scans BOTH `halu:` and `ref:slug` links at every save and update. `listBacklinks` additionally does a live LIKE scan as a fallback for legacy or out-of-band saves.

## Reference Link Canonical Form

Ref-citation links accept two input forms but always canonicalize to one:

| Input form | Status | Notes |
|---|---|---|
| `[text](ref:slug-name)` | **Canonical / preferred** | The slug is shown directly in `{{references_list}}` next to the title so the model can copy it without tracking ordinal numbers. This is what `resolveRefLinks` outputs to stored markdown. |
| `[text](ref:N)` | Accepted fallback | 1-based index into the reference list. Resolved into `ref:slug` at save time. Listed in `{{references_list}}` as "also reachable as ref:N" so legacy prompts and copy-paste from older articles keep working. |

`formatReferencesForPrompt` renders each line as `- ref:slug → Title  (also reachable as ref:N)`. Prompts (`article.toml`, `article_refresh.toml`, and the `linking` rule category) call out the slug form as the default. The numeric form is kept supported but de-emphasized so the model stops having to do ordinal arithmetic.
