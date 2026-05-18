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
- `{{shared_article_rules}}` - expands to the full `shared_article_rules` system prompt

## Adding a New Prompt

Create `config/prompts/my_prompt.toml` with `system` and `user` keys. It will be automatically loaded and accessible as `prompts.prompts.my_prompt` in server code.

## Prompt Catalog

Every prompt currently shipped in this directory. Each entry says *what* the prompt asks the model to produce, *where* in the code it gets invoked, and *why* the system needs it.

### Article-body prompts (`heavy` model, streaming)

| File | Invoked at | Purpose |
|---|---|---|
| `article.toml` | `index.ts` — `buildArticleBody` (page generation path) | Initial generation of a brand-new article from a requested title + RAG context. Streams Markdown that becomes the article body. |
| `article_refresh.toml` | `index.ts` — `/api/article/:slug/refresh-context` handler | Re-write an existing article using newly-retrieved RAG context. Keeps the same topic, fixes link/ref syntax, and reincorporates current sources. |
| `article_rewrite.toml` | `index.ts` — `/api/article/:slug/rewrite` handler | User-instructed rewrite. Applies free-form `edit_instructions` (full article or just a selected section), can operate in different `rewrite_mode`s. |

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
| `link_selection.toml` | `index.ts` — `generateLinkSelection` (called from `/api/article/:slug/add-link`) | When the user highlights a long passage, the model refines the selection down to a noun phrase suitable for wrapping in a halu link. Only runs when `shouldRefineSelection` decides the raw selection is too long. |
| `link_suggestion.toml` | `index.ts` — `generateLinkSuggestion` (called from `/api/article/:slug/add-link`) | Given a refined selection + surrounding excerpt, returns `{title, hint}` JSON used to build the `[label](halu:slug "hint")` wrap. |

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

Files under `shared/` are NEVER invoked directly. They expand inline anywhere `{{shared_*}}` appears in another prompt via `resolveSharedRefs` in `prompts.ts`.

| File | Used by |
|---|---|
| `shared/shared_tone.toml` | Tone rules expanded into `shared_article_rules`, `comment`, and others. |
| `shared/shared_article_rules.toml` | Full body of formatting + link + tone rules expanded into `article`, `article_refresh`, `article_rewrite`. |
| `shared/shared_link_format.toml` | Halu + ref link syntax rules expanded into `shared_article_rules` and `link_*` prompts. |
| `shared/shared_rewrite_modes.toml` | `{{rewrite_mode}}` blurb expanded into `article_rewrite` and `article_refresh`. |
| `shared/linking_guide.toml` | Reference material expanded into selection-edit prompts. |

## RAG Context Sources

Article-body prompts (`article`, `article_refresh`, `article_rewrite`) get THREE distinct streams of context. Each has its own provenance and is exposed under its own template variable so the model never has to guess where a fact came from. Logs use matching names so prompt-context provenance is traceable end-to-end.

| Template variable | Source table | Helper / function | What it is |
|---|---|---|---|
| `{{link_hints}}` | `article_links` | `listIncomingHints` → `formatIncomingHintsForPrompt` | Halu-style link templates from articles that link TO the target. Each line is `[label](halu:source-slug "hidden_hint")`. The `hidden_hint` is canon written by past generations — the strongest "what does the rest of the wiki already say about me" signal. |
| `{{rag_context}}` | `article_chunks` | `retrieveContext` | The actual prose chunks (or summaries, depending on `rag.mode`) retrieved by embedding/lexical similarity against the slug + hints. This is the topic-similarity stream. |
| `{{related_titles}}` | `article_chunks` **and** `article_links` | `formatRelatedTitlesForPrompt` | Bulleted titles, explicitly labeled by source. The block is split into "From RAG-retrieved chunks:" (topic-matched articles) and "From articles linking here (backlinks):" (graph-adjacent articles). Backlinks come from `listBacklinks`, which combines `article_links` rows with a live LIKE scan of article markdown as a fallback for stale or never-indexed links. |

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

`extractAllBodyLinks` (in `index.ts`) is the single chokepoint that keeps the table accurate; it scans BOTH `halu:` and `ref:slug` links at every save and update. `listBacklinks` additionally does a live LIKE scan as a fallback for legacy or out-of-band saves.

## Reference Link Canonical Form

Ref-citation links accept two input forms but always canonicalize to one:

| Input form | Status | Notes |
|---|---|---|
| `[text](ref:slug-name)` | **Canonical / preferred** | The slug is shown directly in `{{references_list}}` next to the title so the model can copy it without tracking ordinal numbers. This is what `resolveRefLinks` outputs to stored markdown. |
| `[text](ref:N)` | Accepted fallback | 1-based index into the reference list. Resolved into `ref:slug` at save time. Listed in `{{references_list}}` as "also reachable as ref:N" so legacy prompts and copy-paste from older articles keep working. |

`formatReferencesForPrompt` renders each line as `- ref:slug → Title  (also reachable as ref:N)`. Prompts (`article.toml`, `article_refresh.toml`, `shared_link_format.toml`) call out the slug form as the default. The numeric form is kept supported but de-emphasized so the model stops having to do ordinal arithmetic.
