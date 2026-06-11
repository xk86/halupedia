# How articles are resolved (and where slugs collide)

Status: **investigation notes — no behavior changes**. Written 2026-06 while
mapping why `Titles (with parentheses)` and `Titles with parentheses` share the
slug `titles-with-parentheses` yet resolve to distinct articles.

## TL;DR

- Articles are keyed by `articles.slug` (primary key), produced by `slugify()`.
- `slugify` erases all punctuation, so distinct titles can collide on one slug.
- Collisions mostly *work anyway* because resolution doesn't stop at the slug:
  the client smuggles the user's literal title in an `x-requested-title`
  header, and the server falls back to an exact-title lookup when the slug
  lookup misses or mismatches. That's the second of (at least) three
  resolution mechanisms — hence "3 different ways".

## The slug function

`slugify()` in [src/server/slug.ts](../src/server/slug.ts):

```
emoji → words, NFC normalize, lowercase,
[^letters/numbers]+ → "-", trim/collapse "-", cap at 120 chars
```

Collision sources:

- **Punctuation erased**: `Test (A)` and `Test A` → `test-a`. Same for colons,
  apostrophes, commas, quotes…
- **120-char truncation**: two long titles differing only after char 120.
- **Case/diacritics folding** (by design).

## Storage model

- `articles.slug` — primary key. `canonical_slug` — usually equal; updated by
  identity repair.
- `articles.title` — exact display title, *not* unique. Two articles can share
  a slugified form but differ by title; they then occupy **different** slugs
  only if they were created under different lookup slugs (see "how duplicates
  are born" below).
- `article_aliases(alias_slug → article_slug)` — manual/automatic redirects.
  Note: no index on `alias_slug` (table is scanned; fine while small).
- `deleted_articles` — tombstones; `is_disambiguation` flags disambig pages.

## Resolution cascade (`GET /api/page/:slug`)

Handler in [src/server/index.ts](../src/server/index.ts) (`/api/page/:slug`),
in order:

1. **URL segment → lookup slug.** `wikiSegmentToRequestedTitle()` +
   `slugify()` ([src/server/slug.ts](../src/server/slug.ts)). Wiki segments
   (`/wiki/Some_Title_(thing)`) preserve a safe punctuation set including
   parentheses, so the *segment* still distinguishes the two titles even
   though the *slug* doesn't.
2. **Path ① — exact slug + aliases.** `getArticleByLookup()`
   ([src/server/db.ts](../src/server/db.ts)): `articles.slug = ?`, then
   `article_aliases.alias_slug = ?`.
3. **Path ② — exact title.** If ① misses: `getArticleByTitle()` using the
   request's title — taken from the `x-requested-title` header (client sends
   the literal typed/linked title, percent-encoded), else `?title=`, else the
   title reconstructed from the URL segment. `WHERE title = ? LIMIT 1` — if
   two rows share an exact title, **first row wins, no tiebreaker**.
   On a hit, `repairStoredArticleIdentity()` may rewrite the stored
   slug/canonical_slug toward the requested one.
4. **Path ③ — compact-key fuzzy match.** `getArticleByEquivalentLookup()`:
   strips all hyphens from the slugified form (`title-with-parens` →
   `titlewithparens`) and compares against **every** article slug, title, and
   alias — a full O(n) table scan per miss. Resolves only when exactly one
   article matches; ambiguous → null (treated as "not found", which can
   trigger generation of yet another variant).
5. **Path ④ — SPA catch-all redirect.** The non-API `/wiki/*` handler 302s
   slug-style segments to the canonical title-style path before the SPA
   loads, using the same `isSlugStyleWikiSegment()` logic.

Separately, **in-article links** resolve through their own mechanisms in
[src/server/markdown.ts](../src/server/markdown.ts): `halu:` links carry a
target slug chosen at generation time, and `ref:` links are rewritten to
existing articles during link resolution (`resolve_links` /
`resolveLinksPostProcess` pipeline nodes). These bake a slug into the stored
markdown — a fourth place where a slug↔article mapping is fixed.

## Why colliding titles resolve to distinct articles

`Title (x)` lives at slug `title-x`… unless `Title x` already took it. What
actually happens:

- The two titles produce **identical slugs**, but the wiki URL segments differ
  (`Title_(x)` vs `Title_x`). When the slug row's stored `title` doesn't match
  the requested title, Path ① still returns it — *the slug owner wins* — but a
  request that arrives with the other exact title can hit Path ② and reach the
  other row **if that row exists under a different slug** (created e.g. via
  identity repair, generation-time `derive_identity` promotion, or an alias).
- So the system limps to correctness through the title header + repair
  functions, at the cost of: first-match-wins ties, occasional slug "theft" by
  `repairStoredArticleIdentity`, and the O(n) Path ③ scan on misses.

### How duplicates are born

`saveArticle` upserts on `slug`. A second article generated under an occupied
slug **overwrites** it unless the displaced-article handling in the admin
move/rename flow intervenes (see the displaced-article logic around the slug
admin endpoints in `index.ts`). Distinct rows for colliding titles only exist
when something (identity derivation, repair, manual alias) assigned one of
them a different slug first. That's why behavior looks inconsistent: it
depends on creation order and which code path created each row.

## Options for an eventual fix (none executed)

| Option | Sketch | Risk |
|---|---|---|
| **A. Alias-first canonicalization** | On collision at save time, keep both rows; give the newcomer a derived slug (`title-x-2`) and register aliases. Add an index on `alias_slug`. | Low. No URL breakage; needs collision check in `saveArticle` + prompt unchanged. |
| **B. Numbered suffixes at save** | Same as A but without aliasing the old form — newcomer simply gets `-2`. | Low/medium: links generated with the bare slug may point at the wrong article. |
| **C. Preserve parens/punctuation in `slugify`** | `title-with-parentheses` vs `title-(with-parentheses)`. | **Highest.** Every existing slug, stored `halu:`/`ref:` link, alias, chunk key, and external URL assumes current slugify. Requires full migration + alias backfill for every old slug. |
| **D. Opaque IDs as the DB key, slug as display/lookup** | URL-based system; slug becomes a non-unique lookup column. | **Very high** (the user's own assessment): schema migration, prompt changes, old-link catching. Don't do until A proves insufficient. |
| **E. Compact-key column** | Persist `compactLookupKey(slug)` in a column + index to kill Path ③'s O(n) scan. | Low, perf-only; orthogonal to the collision question. |

Recommendation if/when movement is wanted: **A + E**, leaving slugify and the
URL scheme untouched.
