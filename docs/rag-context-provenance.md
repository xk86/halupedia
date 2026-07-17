# RAG Context Provenance

Article-body prompts (`article`, `article_refresh`, `article_rewrite`, `article_quick_edit`) get THREE distinct streams of context. Each has its own provenance and is exposed under its own template variable so the model never has to guess where a fact came from. Logs use matching names so prompt-context provenance is traceable end-to-end.

| Template variable | Source table | Helper / function | What it is |
|---|---|---|---|
| `{{link_hints}}` | `article_links` | `listIncomingHints` → `formatIncomingHintsForPrompt` | Halu-style link templates from articles that link TO the target. Each line is `[label](halu:source-slug "hidden_hint")`. The `hidden_hint` is canon written by past generations — the strongest "what does the rest of the wiki already say about me" signal. |
| `{{rag_context}}` | LanceDB `rag_text_documents` | profile-based `rag.retrieve` | Retrieved typed documents mapped into article evidence for the prompt. Document kinds include body, summary, infobox, link hints, image text, and ontology facts according to the active retrieval profile. |
| `{{related_titles}}` | LanceDB candidates **and** `article_links` | `formatRelatedTitlesForPrompt` | Bulleted titles from retrieved document candidates plus graph-adjacent backlink titles. Evidence inclusion and linkability remain separate. |

## Per-source log fields

When the article-body path runs, `build.article_rag_retrieved` logs the breakdown so each context stream is auditable:

| Log field | Source | Meaning |
|---|---|---|
| `rag_chunk_sources` | `retrieveContext` | Count of chunks picked above `reference_min_score`. |
| `rag_chunk_titles` | `retrieveContext` → `formatRelatedTitlesForPrompt` | Unique titles from RAG chunks appearing in `related_titles`. |
| `backlink_titles` | `listBacklinks` → `formatRelatedTitlesForPrompt` | Unique titles from `article_links` (and live scan) appearing in `related_titles`. |
| `incoming_link_hints` | `listIncomingHints` | Count of `article_links` rows that became `{{link_hints}}` entries. |
| `related_titles_total` | merged | Sum of unique titles after deduping across both sources. |

## Why `article_links` correctness matters beyond the backlinks UI

`article_links` is the substrate for TWO context streams (`{{link_hints}}` AND the backlinks half of `{{related_titles}}`) plus the visible backlinks panel. A missing or stale row degrades:

1. The visible "Referenced by" sidebar.
2. The hidden-hint canon the LLM gets when generating the target article.
3. The graph-adjacent titles offered as inspiration alongside RAG chunks.

`extractAllBodyLinks` (in `src/server/referenceList.ts`) is the single chokepoint that keeps the table accurate; it scans BOTH `halu:` and `ref:slug` links at every save and update. `listBacklinks` additionally does a live LIKE scan as a fallback for legacy or out-of-band saves.

See [link-formats.md](link-formats.md) for the `halu:`/`ref:` link syntax itself and the reference canonical-form rules.
