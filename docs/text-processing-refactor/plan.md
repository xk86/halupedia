# Text Processing Refactor Plan
(Notice: this document reflects a plan that was implemented and may not currently reflect the state of the codebase.)

Status: first refactor pass implemented. This document records the target shape, completed extraction, and remaining follow-up work.

Goal: centralize server-side article text parsing, markdown normalization, link parsing, link rendering, reference-link conversion, section slicing, and selection mapping behind a small set of focused modules.

This plan intentionally disregards `docs/link-formats.md`. That file is stale and should not drive the new architecture.

## Target Architecture

Core rule: parse markdown links once, classify them once, then dispatch policy from that parsed representation.

Target flow:

```text
markdown input
-> normalize container noise
-> scan markdown structure and parse markdown links
-> classify each link target
-> apply context policy
-> rewrite to canonical stored markdown
-> emit clean markdown, link records, diagnostics, stats
-> save DB records and render HTML from clean markdown
```

This applies to:

- new model output
- rewrite/refresh output
- DYK facts
- summaries
- article markdown read from the live DB

The live DB contains old content. Valid old links should pass unchanged. Fallback or legacy forms should be quietly normalized and saved back when a write path touches them. Read paths should parse and report diagnostics; cleanup persistence should happen only through explicit save/repair flows so reads do not unexpectedly mutate state.

### One Link Parser

Add one server-side markdown link parser. Do not keep separate regexes for `halu:`, `ref:`, DYK links, reference links, wiki links, and generic markdown links.

The parser should recognize markdown links by structure:

```md
[label](target "optional title")
```

It should emit ranges and parsed fields:

```ts
interface ParsedMarkdownLink {
  raw: string;
  label: string;
  target: string;
  title?: string;
  start: number;
  end: number;
  targetStart: number;
  targetEnd: number;
}
```

Then classify target in one step:

```ts
type LinkKind =
  | "halu"
  | "ref"
  | "wiki"
  | "plain-slug"
  | "external"
  | "empty"
  | "unknown";
```

Supported stored forms:

```md
[label](halu:slug "hidden hint")
[label](ref:slug)
```

Quiet fallback inputs:

- `[label](/wiki/Title_or_slug)`
- `[label](slug-here)`
- wiki-looking absolute paths if they point at this app

These fallback forms are cleanup inputs only. Do not document them to prompts. If fallback syntax is advertised, models will propagate it.

External links are forbidden. They should not be rendered as outbound links and should not enter storage as live external links.

### Structural Diagnostics

Before link classification, scan markdown structure enough to detect likely malformed links:

- unmatched `[` or `]`
- unmatched link destination `(` or `)` after a bracket label
- link-looking text with `halu:` or `ref:` outside a valid markdown link
- unterminated optional title/hint

Use this as a diagnostic and repair signal. Do not delete arbitrary bracket or paren text. Text may be intentional prose, math, emoticons, examples, or punctuation.

Diagnostics should look like:

```ts
interface LinkDiagnostic {
  code:
    | "unclosed-label"
    | "unopened-label"
    | "unclosed-target"
    | "halu-outside-link"
    | "ref-outside-link"
    | "external-link"
    | "unsupported-target"
    | "missing-halu-hint"
    | "unknown-ref";
  start: number;
  end: number;
  severity: "debug" | "info" | "warn" | "error";
  message: string;
}
```

Malformed content should survive unless a deterministic rewrite is obviously safe or an explicit repair pass succeeds.

### Canonicalization Policy

The normalizer should return:

```ts
interface NormalizedMarkdown {
  markdown: string;
  links: NormalizedLink[];
  diagnostics: LinkDiagnostic[];
  stats: LinkStats;
  changed: boolean;
}
```

Context-specific policies decide what to do with parsed links:

- article body: allow `halu:` and valid `ref:`, rewrite fallback internal links, strip/inert external links.
- references: `ref:` only for verified source references.
- see-also: `halu:` only. See-also is graph-expanding/hallucinated, not a source reference.
- DYK: markdown string, parsed by the same pipeline. Prefer JSON model output later: `{ "fact": "..." }`.
- summaries: markdown string, parsed by the same pipeline. Summary policy may strip links if configured, but the input/output type is still markdown.
- prompt-provided article links/reference links: pass already formatted markdown strings to models, not raw fields that the model must format.

The pipeline should probably reformat links before storage. Open to final confirmation, but the default should be canonical stored markdown only.

### Logging

Add noisy, dense, semi-hierarchical logs around parsing and normalization. Avoid dumping JSON arrays or padded JSON strings in logs.

Examples:

```text
text.pipeline.start slug=entry source=generation chars=8421
text.links.parsed total=9 halu=4 ref=2 wiki=1 plain_slug=1 external=1 malformed=0
text.links.rewrite wiki=1 plain_slug=1 external_removed=1 ref_resolved=2 halu_valid=4
text.refs.sidecar built=6 body=2 rag=3 prior=1 dropped=2
text.graph.extract links=6 halu=4 ref=2 deduped=1
text.pipeline.done slug=entry clean_chars=8012 changed=true
```

Per-link debug logs should be compact:

```text
text.link item=3 kind=plain-slug action=rewrite target=target-slug canonical=halu reason=fallback_slug
```

Reference lists in logs should be dense strings when needed:

```text
refs=source-a:body,source-b:rag,source-c:prior
```

Do not log raw full articles by default.

### Prompt Boundary

Prompt restructuring is out of scope for this pass.

Known future direction:

- prompt templates should become more flexibly configurable.
- models should receive canonical markdown strings for links.
- prompts should document only the supported syntax.
- fallback cleanup syntax is an implementation detail.

## Current Inventory

### `src/server/markdown.ts`

Current role: mixed core parser, normalizer, renderer, and article-text utility module.

Owns:

- `LINK_RE`: canonical regex for normalized `halu:` links.
- `buildHaluLink`: constructs markdown `halu:` links and sanitizes hidden hints.
- `normalizeHaluLinks`: repairs common malformed `halu:` syntax and converts bare bracket labels into `halu:` links.
- `fixSlugVisibleText`: replaces slug-like visible labels with title-like labels.
- Markdown renderer setup:
  - `markdown-it`
  - TeX block parsing
  - TeX inline parsing
  - `halu:` link rendering to `/wiki/...`
  - `ref:` link rendering to `/wiki/...`
  - non-internal link neutralization to `#`
- `normalizeMarkdown`: trims model output, strips fences, strips HTML/script/iframe, converts wikilinks, truncates duplicate H1 output.
- `extractInternalLinks`: extracts unique valid `halu:` links for graph storage.
- Section helpers:
  - `stripTopLevelSections`
  - `sectionSlice`
  - `listArticleSections`
  - `articleSectionMarkdown`
  - `replaceArticleSection`
- Article text helpers:
  - `summaryMarkdownFromArticle`
  - `firstParagraphMarkdownFromArticle`
  - `extractTitle`
  - `extractDisplayTitle`
  - `leadBoldsTitle`
  - `markdownToPlainText`
- Safety cleanup:
  - `stripFootnoteArtifacts`
  - `stripSelfLinks`

Notes:

- This file is the highest-value split target.
- It combines pure string transforms, parser rules, renderer side effects, and article-specific policy.
- `renderMarkdown` calls `normalizeHaluLinks`, so rendering currently mutates malformed link syntax implicitly.

### `src/server/referenceList.ts`

Current role: reference sidecar construction plus `ref:` markdown behavior.

Owns:

- Reference-list construction and ranking via `buildReferenceList`.
- Reference prompt formatting via `formatReferencesForPrompt`.
- Reference HTML rendering via `renderReferencesHtml`.
- `REF_LINK_RE`: local regex for markdown `ref:` links.
- `resolveRefLinks`: resolves `ref:N` and `ref:slug`, fills empty labels, collapses duplicate citations to plain text.
- `resolveReferenceTarget`.
- `collectReferenceLinkSlugs`.
- `linkMentionedReferencesInBody`: deterministic exact-title wrapping into `ref:` links while skipping existing markdown links/code.
- Existing-article link detection:
  - `findExistingArticleLinkReferences`
  - `findTitleMentionedArticles`
  - `findBodyReferencedArticles`
- Graph extraction for `ref:` links:
  - `extractRefLinksAsInternalLinks`
- Conversion:
  - `convertExistingArticleLinksToRefs`

Notes:

- This module has a deliberate late import from `markdown.ts` to avoid a circular dependency.
- The `ref:` parsing/conversion code belongs near text processing. The reference-list ranking code should stay separate.
- `renderReferencesHtml` currently manually builds HTML.

### `src/server/index.ts`

Current role: routes plus several local text/link helpers that should not stay route-local.

Text/link helpers currently embedded:

- `routeSlug`: route pathname to lookup slug.
- `articleLookupSlugFromInput`: admin/UI pasted wiki path to lookup slug.
- `validateLeadSubject`, `validateArticleSubject`, `articleSubjectMatchesRequested`: article subject validation by markdown heading and lead parsing.
- `cachedArticleNeedsRepair`: detects footnote artifacts, malformed derived sections, and duplicate see-also/body links.
- `rewriteArticleTitleHeading`: inserts or replaces H1.
- `sanitizeGeneratedBody`: composed cleanup of generated markdown body.
- `recheckArticleLinks`: LLM-backed link recheck from configured prompt.
- `repairMalformedHaluLinks`: LLM-backed second-pass malformed `halu:` repair.
- `rewriteArticleHtml`: post-render canonical-alias href rewrite.
- `extractAllBodyLinks`: combines `halu:` and `ref:` graph links.
- `formatRelatedTitlesForPrompt`: renders RAG/backlink title prompt block.
- Add-link helpers:
  - `stripSelectionDecorators`
  - `linkableSelectionCandidates`
  - `findBestWrapRange`
  - `normalizeSuggestedTargetSlug`
  - `generateLinkSuggestion`
- Main save/post-process flow composes most text behavior:
  - strip metadata sections
  - rewrite title
  - scrape body refs
  - build reference sidecar
  - resolve `ref:` links
  - link exact title mentions
  - convert existing `halu:` links to `ref:`
  - strip self-links
  - summarize
  - plain-text extraction
  - render HTML
  - extract graph links

Notes:

- `saveArticleImmediately` and `postProcessArticle` expose the real pipeline order.
- Refactor should extract helpers first, then replace route-local use sites with a pipeline API.
- Keep prompt text in TOML. `recheckArticleLinks`, `repairMalformedHaluLinks`, and link suggestion may call LLMs, but their prompt text must remain config-owned.

### `src/server/selectionUtils.ts`

Current role: rendered-selection-to-markdown mapping and candidate wrap ranges for add-link.

Owns:

- `normalizeSelectionText`
- inline markdown stripping with position map
- range expansion to surrounding markdown formatting
- `findSelectionRangeInMarkdown`
- large-selection threshold logic
- regex escaping
- existing markdown link range detection
- `findWrapRange`
- `extractSelectionExcerpt`

Notes:

- This belongs under the same text-processing umbrella, but can stay separate as `selection.ts`.
- It imports `markdownToPlainText`, creating a dependency from selection utilities back into renderer/plain-text extraction.

### `src/server/slug.ts`

Current role: slug/title/wiki path normalization.

Owns:

- `slugify`
- `normalizeCanonicalTitle`
- `slugToTitle`
- `titleToWikiSegment`
- `wikiSegmentToTitle`
- `isSlugStyleWikiSegment`
- `wikiSegmentToRequestedTitle`

Notes:

- This is already focused.
- Client has near-duplicate wiki segment logic in `src/client/wikiPath.ts`.
- A shared URL/title normalizer would reduce drift, but server/client import boundaries need care.

### `src/server/articleRender.ts`

Current role: sidecar-aware article display assembly and render cache.

Owns:

- `renderSeeAlsoSection`
- `assembleArticleMarkdownForRender`
- `renderArticleDisplayHtml`
- HTML cache helpers.

Notes:

- This is already close to the desired boundary.
- `renderSeeAlsoSection` uses raw markdown link construction instead of `buildHaluLink`.
- `renderArticleDisplayHtml` depends on `resolveRefLinks`, `collectReferenceLinkSlugs`, `renderReferencesHtml`, and `renderMarkdown`.

### `src/server/linkHints.ts`

Current role: incoming graph hint prompt formatting.

Owns:

- `formatIncomingHintsForPrompt`

Notes:

- Uses `buildHaluLink`.
- Prompt formatting can stay separate, but it should consume a centralized link builder.

### `src/server/dyk.ts`

Current role: Did You Know generation and fact cleanup.

Owns:

- local `MARKDOWN_LINK_RE`
- `normalizeDykLinks`: converts `halu:` links to plain slug links.
- `hasMarkdownLink`
- `ensureDykHasSourceLink`
- `normalizeHomepageFact`
- generation prompt wiring.

Notes:

- This contains another local markdown-link regex.
- DYK should stop having a separate parser. It should use the same server-side markdown link parser and a DYK-specific policy.
- The model should eventually return JSON, likely `{ "fact": "Markdown string" }`, so trailing source-link regressions and unrelated-link regressions can be rejected/rewritten deterministically.

### `src/server/summary.ts`

Current role: summary cleanup and lead-copy detection.

Owns:

- `collapseSummaryText`
- `normalizeSummaryMarkdown`
- `summaryLooksLikeLeadCopy`

Notes:

- Similar link/image/heading stripping exists in `summaryMarkdownFromArticle`.
- Good target for shared plain-text/collapse helpers.

### `src/server/editReferences.ts`

Current role: deprecated heuristic parsing for referenced article lookup in edit text.

Owns:

- wiki path scanning.
- exact title mention scanning.
- fuzzy title matching.
- tokenization and Levenshtein scoring.

Notes:

- Header says scheduled for removal.
- Do not build new refactor dependencies on this file.
- If migration needs temporary compatibility, isolate it as legacy code.

### `src/client/wikiPath.ts`

Current role: client-side wiki path normalization.

Owns:

- `toWikiSegment`
- `articleInputToWikiSegment`

Notes:

- Duplicates parts of `src/server/slug.ts`.
- Could become shared client-safe code if we add a `src/shared/text` or `src/shared/wikiPath` module.

### `src/client/summaryHtml.ts`

Current role: render markdown summaries on the client.

Owns:

- wrapper paragraph stripping around `renderMarkdown`.

Notes:

- Imports server markdown code into the client bundle.
- That is convenient but couples client rendering to server-only concerns such as KaTeX and article link policy.

### `docs/link-formats.md`

Current role: existing public-ish format documentation.

Notes:

- Disregard for this refactor. It is stale/incomplete:
  - says `halu:` hidden hint is optional, but `extractInternalLinks` skips missing hints.
  - says `ref:` targets are guaranteed database entries, but `renderMarkdown` will render a slug-derived wiki path without DB validation.
  - says `ref:` is used for "See also"; current code stores see-also sidecar metadata and renders it as `halu:` markdown.
  - has at least one typo.
- Rewrite it later after the new parser and canonicalization rules are settled.

## Current Pipeline

Current problem: the flow is fragmented. Link parsing, markdown cleanup, reference conversion, DB graph extraction, rendering, DYK cleanup, and summary cleanup each use overlapping local logic. The refactor should replace this with one parse/classify/normalize pipeline.

### Generated article body

1. LLM returns raw markdown.
2. `normalizeMarkdown` strips fences/HTML, converts wikilinks, truncates duplicate H1.
3. `sanitizeGeneratedBody` strips model-generated References/See also, strips footnote artifacts, fixes slug-like visible labels.
4. `resolveRefLinks` resolves preliminary `ref:N` or `ref:slug` references.
5. `saveArticleImmediately`:
   - derives canonical identity.
   - strips metadata sections again.
   - rewrites H1.
   - scans body for existing article references.
   - builds sidecar reference list.
   - resolves refs again.
   - links exact title mentions.
   - converts `halu:` links to existing articles into `ref:` links.
   - strips self-links.
   - derives summary and plain text.
   - renders HTML.
   - extracts graph links.
6. `postProcessArticle`:
   - strips metadata sections defensively.
   - repairs malformed `halu:` occurrences through configured prompt.
   - generates see-also candidates.
   - rebuilds reference sidecar.
   - resolves/rewrites refs.
   - strips self-links.
   - regenerates summary.
   - re-renders HTML and graph links.

### Rewrite / refresh body

Same primitives as generation, with extra section replacement:

- selected rewrites use `findSelectionRangeInMarkdown`.
- section rewrites use `articleSectionMarkdown` and `replaceArticleSection`.
- rewrite/refresh both call `sanitizeGeneratedBody`, `resolveRefLinks`, and `saveArticleImmediately`.

### Add link

1. Client sends selected text.
2. Server normalizes selection.
3. `findBestWrapRange` tries cleaned candidates through `findWrapRange`.
4. LLM suggests target slug/description through configured prompt.
5. Server wraps selected range with `buildHaluLink`.
6. Server strips self-links, extracts links, renders HTML, and saves.

### Render / response

1. Stored body markdown is read from the live DB.
2. Read path parses it with the same parser used for new model output.
3. Valid links pass unchanged.
4. Legacy/fallback links produce diagnostics and a normalized candidate.
5. Cleanup is saved only when the caller is in a write/repair flow.
6. Stored or normalized body markdown is rendered with `renderMarkdown`.
7. `renderMarkdown` currently normalizes `halu:` links before rendering.
8. `markdown-it` link renderer maps:
   - `halu:` to `/wiki/<visible text>`
   - `ref:` to `/wiki/<slug-derived title>`
   - `/wiki/` stays as-is
   - other links to `#`
9. `rewriteArticleHtml` rewrites hrefs from alias-ish target paths to canonical target paths.
10. Sidecar References and See also are assembled by `articleRender.ts` in newer display paths.

Target change: render should consume clean parsed/canonical markdown. Rendering should not be the first time malformed links are discovered.

## Proposed Module Boundaries

Target package shape:

```text
src/server/text/
  markdownLinkParser.ts
  markdownStructure.ts
  markdownNormalize.ts
  articleSections.ts
  articleText.ts
  links/
    haluLinks.ts
    refLinks.ts
    graphLinks.ts
    linkNormalize.ts
    linkPolicy.ts
    linkRepair.ts
  references/
    referenceList.ts
    referenceRender.ts
  selection.ts
  wikiPath.ts
  titleMatch.ts
  fuzzyMatch.ts
  markdownRenderer.ts
```

Suggested ownership:

- `markdownLinkParser.ts`: one parser for all markdown links. Emits ranges, label, target, optional title, kind, diagnostics.
- `markdownStructure.ts`: bracket/paren structural scan. Emits diagnostics only; does not delete text.
- `linkNormalize.ts`: rewrites fallback internal links to canonical stored forms and rejects external links according to policy.
- `linkPolicy.ts`: context rules for article body, DYK, summary, references, and see-also.
- `markdownRenderer.ts`: `markdown-it` setup, TeX rendering, link rendering rules, `renderMarkdown`.
- `markdownNormalize.ts`: container cleanup, fence stripping, HTML stripping, duplicate-H1 truncation, generated-body sanitization, footnote artifact stripping. Link rewriting should call the shared parser/normalizer.
- `articleSections.ts`: section scanning, section stripping, section replacement, section listing.
- `articleText.ts`: title extraction, display title extraction, lead checks, summary/first paragraph/plain text collapse.
- `links/haluLinks.ts`: build and validate canonical `halu:` links. Avoid owning an independent parser.
- `links/refLinks.ts`: resolve and validate canonical `ref:` links. Avoid owning an independent parser.
- `links/graphLinks.ts`: convert normalized links into `article_links`, canonical href rewriting, body reference scraping.
- `links/linkRepair.ts`: LLM-backed recheck/repair wrappers. This module takes prompt config and LLM clients. It does not own prompt text.
- `references/referenceList.ts`: keep ranking/building sidecar references here.
- `references/referenceRender.ts`: `formatReferencesForPrompt`, `renderReferencesHtml`, maybe see-also markdown render. Prompt-facing reference links should be prebuilt markdown strings.
- `selection.ts`: current `selectionUtils.ts`, with dependency on shared plain-text helpers instead of renderer if possible.
- `wikiPath.ts`: server wiki segment helpers. Later decide whether a client-safe shared module is worth it.
- `titleMatch.ts`: deterministic title mention and wiki path matching split out from `editReferences.ts`.
- `fuzzyMatch.ts`: fuzzy token/scoring helpers split out from `editReferences.ts`.

## Migration Order

1. Add characterization tests before moving code.
   - No behavior changes.
   - Cover markdown link parsing, malformed `halu:` normalization, `ref:` resolution, fallback `/wiki/` and plain-slug rewrites, external-link rejection, title mention linking, section replacement, plain-text extraction, DB-read cleanup candidates, and render href behavior.
2. Add the new parser and structural diagnostic layer behind tests.
   - Parse all markdown links with ranges.
   - Classify `halu:`, `ref:`, `/wiki/`, plain slug, external, empty, and unknown targets.
   - Emit bracket/paren diagnostics without deleting text.
3. Add link policy and canonicalization helpers.
   - Preserve valid canonical links.
   - Quietly rewrite fallback internal links.
   - Reject or inert external links.
   - Do not advertise fallback forms to prompts.
4. Move pure section helpers out of `markdown.ts`.
   - Lowest risk.
   - Keep re-exports from `markdown.ts` temporarily.
5. Move title/summary/plain-text helpers.
   - Keep compatibility exports.
   - Decide whether `markdownToPlainText` should use rendered HTML or token/plain parser. Preserve behavior first.
6. Move `halu:` helpers.
   - Replace standalone regex parsing with shared parsed-link data.
   - Keep compatibility behavior while tests prove equivalence.
7. Move `ref:` helpers out of `referenceList.ts`.
   - Break the current circular import pressure.
   - Keep sidecar ranking code independent from markdown parsing.
   - Make `referenceList.ts` consume normalized link data.
8. Split title/fuzzy matchers out of `editReferences.ts`.
   - Keep legacy callers on a compatibility module until removed.
9. Move renderer setup.
   - Renderer should consume link helper functions rather than owning link parsing details.
10. Extract route-local helpers from `index.ts`.
   - Start with `sanitizeGeneratedBody`, `rewriteArticleTitleHeading`, `extractAllBodyLinks`, `rewriteArticleHtml`.
   - Then migrate LLM-backed link repair/recheck.
11. Route DYK and summaries through the same server-side markdown parser.
12. Add DB read-clean-save flow.
   - Read paths parse and log diagnostics.
   - Write/repair paths persist canonical cleanup.
13. Remove compatibility re-exports once call sites are updated.
14. Rewrite `docs/link-formats.md` after behavior is captured and any intended semantic changes are explicit.

## Suggested Public API

Prefer a small facade for application code:

```ts
parseMarkdownLinks(markdown: string): ParsedMarkdownLinkResult
normalizeMarkdownLinks(markdown: string, context: LinkPolicyContext): NormalizedMarkdown
normalizeGeneratedMarkdown(raw: string, context: LinkPolicyContext): NormalizedMarkdown
sanitizeArticleBody(markdown: string, context: LinkPolicyContext): NormalizedMarkdown
renderArticleBodyMarkdown(markdown: string): string
extractArticleLinks(clean: NormalizedMarkdown, selfSlug: string, db: DatabaseSync): ParsedInternalLink[]
resolveArticleReferenceLinks(clean: NormalizedMarkdown, refs: ReferenceList): NormalizedMarkdown
convertExistingInternalLinksToRefs(db: DatabaseSync, clean: NormalizedMarkdown, selfSlug: string): NormalizedMarkdown
listArticleSections(markdown: string): ArticleSection[]
replaceArticleSection(markdown: string, sectionId: string, replacement: string): string
markdownToPlainText(markdown: string): string
```

Keep lower-level functions exported only where tests or focused modules need them.

## Invariants To Preserve

- Stored article source remains Markdown.
- Derived References and See also sections stay sidecar-rendered, not baked into body markdown.
- Prompt text stays in TOML.
- Prompt-facing article/reference links should be passed as already-formatted markdown strings where possible.
- Prompts should document only canonical syntax.
- `halu:` links with valid hidden hints feed `article_links`.
- `ref:` links to existing articles also feed `article_links`.
- See-also uses `halu:` semantics, not `ref:`.
- Self-links are stripped before save.
- Existing article `halu:` links convert to `ref:` links during save/post-process.
- `renderMarkdown` disables raw HTML and does not linkify external URLs.
- External links are not supported.
- Non-internal links render inert or are stripped according to policy.
- Link repair must never process References/See also sections.
- Refactor must preserve current path generation and canonical href rewriting.
- DB-read markdown is parsed too. Valid links pass; legacy/fallback forms become cleanup candidates.
- Bracket/paren structural failures are diagnostics and repair signals, not automatic deletion.

## Risk Areas

- Regex behavior around malformed `halu:` links is nuanced.
- `renderMarkdown` normalizes links as a side effect. Moving this could change rendered output.
- `markdownToPlainText` currently renders HTML first. A direct markdown parser may differ.
- `ref:` links are partially validated by sidecar flows, but the renderer itself does not validate against DB.
- `referenceList.ts` mixes reference ranking with markdown parsing. Split carefully to avoid circular imports.
- Client imports server markdown renderer through `summaryHtml.ts`.
- `docs/link-formats.md` does not fully match current behavior.
- Live DB cleanup can accidentally churn content if read paths persist changes. Keep mutation explicit.
- Structural bracket/paren checks can false-positive on intentional prose. Treat them as diagnostics unless repair is explicit.
- DYK has known regressions around trailing source links and unrelated links. JSON output plus shared parser/policy should address this later.
- Prompt template architecture is disliked but out of scope. Do not mix parser refactor with prompt-system redesign.

## Test Gates

Minimum after each move:

```sh
npm test -- tests/server-units.test.ts
npm test -- tests/article-regressions.test.ts
```

Run full suite after route-local pipeline moves:

```sh
npm test
```

Add focused tests for:

- `normalizeGeneratedMarkdown` preserves current stripping/truncation.
- `sanitizeArticleBody` strips metadata and footnote artifacts.
- markdown link parser emits correct ranges and classifications for `halu:`, `ref:`, `/wiki/`, plain slug, external, empty, and unknown targets.
- structural diagnostics detect unclosed markdown links and `halu:`/`ref:` outside valid links without deleting surrounding prose.
- `normalizeHaluLinks` compatibility preserves current malformed-link repairs during transition.
- `extractHaluLinks` ignores missing hints and dedupes by target slug.
- `resolveRefLinks` preserves duplicate-collapse semantics.
- `convertExistingInternalLinksToRefs` preserves non-existing `halu:` links.
- `extractArticleLinks` combines `halu:` and `ref:` without duplicates.
- section replacement preserves lead and `##` sections.
- renderer maps `halu:`, `ref:`, `/wiki/`, and external links exactly as today.
- DYK facts use the shared parser and reject/strip unrelated links.
- summaries use the shared parser even when summary policy removes links.
- DB-read legacy markdown produces cleanup candidates without implicit mutation.

## Open Decisions

- Whether `renderMarkdown` should keep normalizing links during compatibility, or callers should be required to pass clean markdown.
- Whether markdown-link parsing should use `markdown-it` tokens, a small local scanner, or both. Requirement: ranges and malformed diagnostics.
- Whether server/client wiki path logic should be shared. Current focus is server-side parsing.
- Whether `markdownToPlainText` should remain HTML-based for compatibility.
- Exact persistence trigger for DB-read cleanup candidates.
- Exact DYK JSON schema and how strict to be on one-link policy.
- Whether link canonicalization should always rewrite before storage. Current bias: yes.
- Whether stale docs should be updated before or after the refactor. Current bias: after.
