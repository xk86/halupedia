# Prompt Configuration

Each `.toml` file in this directory defines a single prompt template. The filename (minus `.toml`) becomes the prompt key used in code (e.g., `article_refresh.toml` -> key `article_refresh`).

Headline-image style presets are a separate, differently-shaped config living in [`config/image_presets/`](../image_presets/) — they aren't prompts by the definition below (no `system`/`user` pair loaded by this directory's scanner) and have their own admin editor.

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
- `{{rag_context}}` - retrieved context from RAG (provenance details: [docs/rag-context-provenance.md](../../docs/rag-context-provenance.md))
- `{{link_hints}}` - incoming canonical references
- `{{related_titles}}` - existing related Halupedia topics
- `{{rules}}` - expands to the prompt's assembled rule-library text (see "Rule library" below)

## Adding a New Prompt

Create `config/prompts/my_prompt.toml` with `system` and `user` keys. It will be automatically loaded and accessible as `prompts.prompts.my_prompt` in server code. Register a human-readable description and call sites in `src/server/promptUsage.ts` so the admin Prompts pane and catalog below aren't stuck saying "user-defined prompt with no registered runtime description."

## Prompt Catalog

`src/server/promptUsage.ts` is the single source of truth for what each prompt does and where it's called from — every prompt key maps to a `description` and a `usedBy` list of call sites. That file is read directly by the admin **Prompts** pane, so browsing prompts there always reflects the current, live mapping rather than a hand-maintained copy that can drift out of sync with it (as this table once did).

A few prompts are worth calling out because their names collide or their status is easy to misread:

- **`link_selection.toml` (prompt) vs. `link_selection` (rule category).** The *prompt* file is legacy and unused (`promptUsage.ts` lists it with `usedBy: []` — anchor-text selection for the highlight-to-link flow is bounded code, not an LLM call). The *rule category* of the same name, in `config/rules/link_selection.toml`, is unrelated and very much live: it's imported by `link_suggestion.toml` to govern picking a compact canonical description for a new link target. Same name, two different things — don't infer one's status from the other.
- **`link_recheck.toml`, `link_repair.toml`, `comment.toml`** are likewise retained-but-unused legacy prompts (`promptUsage.ts` says so explicitly for each).
- **`shared/shared_rewrite_modes.toml`** is never invoked directly — see "Shared" below.

## Shared

Files under `shared/` are never invoked directly. Currently just `shared_rewrite_modes.toml`: its `system`/`user` are empty, and it exists only to carry a `[modes.*]` table through the prompt loader — those tables feed `config.prompts.rewriteModes` directly (selected by a `mode` variable in `article_refresh`/`article_rewrite`/`article_quick_edit`), not a set of rules to assemble.

## Rule library

Every prompt's `[rules]` table has two lists:

- `categories`: imported shared namespaces (`config/rules/*.toml`, cataloged in `config/rules/categories.toml`). Importing `"canon"` makes canon rules *available* for selection — it does not enable any rule by itself. `categories = ["*"]` imports every namespace in the library.
- `rules`: pathlike selectors resolved against imported categories:
  - `"category/id"` — exactly one rule
  - `"category/*"` — every rule currently in that category (and any added to it later)
  - either prefixed with `"!"` to exclude, e.g. `"!linking/min_five_internal_links"` after a `"linking/*"` wildcard

Exclusion selectors always resolve after every inclusion selector regardless of list order, and excluding a rule that inclusion never selected is a load-time error rather than a silent no-op — a stale or typo'd exclusion should fail loudly.

A rule can only be selected when its category is imported. There are no tier-range selectors (`category@2`) or bare-category selectors (`category` alone meaning "all of it") — a bare category name in `categories` only imports the namespace; use `category/*` in `rules` to actually select everything in it.

The assembled `{{rules}}` text is tier-major (hardest-to-break rules first). Within a tier, each category's rules are preceded by a heading naming the category and its one-line description from `categories.toml`, so the model has context on what a group of rules is scoped to rather than reading a flat bullet list.

`article_rewrite.toml`/`article_quick_edit.toml` additionally need a rule selection that varies per render call (full-article vs. section/selection scope), not just per prompt. `RenderRuntimeOptions.extraInclude` is an internal mechanism for this one dynamic case, used only from `renderRewritePromptNode`: it selects the `output_contract/full_article_*` or `output_contract/partial_scope_*` pair based on whether the edit is partial, and auto-imports whichever categories those selectors reference (since it's an internal call, not prompt-authored TOML, it isn't limited to the categories the prompt statically imports).

### Admin editor

The admin rule picker (Prompts pane) understands `category/*` as a "Select all" toggle per category. Individual rule checkboxes stay live while a category is wildcarded: unchecking one writes a `!category/id` exclusion alongside the wildcard rather than disabling the box, and re-checking it removes the exclusion. Turning "Select all" off converts the current *effective* selection into an explicit list — if any rules were excluded while wildcarded, those exclusions are kept (the deliberate choice wins); only when nothing was excluded does it fall back to restoring the exact pre-wildcard selection (or, if there wasn't one, the full list) — so a no-op toggle on/off round-trip never loses anything either way.
