# Migrating a running instance to the ontology rework

This guide is for an instance currently running on `main` (pre-ontology-rework)
that needs to move onto this branch (`rag-rework`). It covers what changed, why
each step is necessary, and the exact commands to run, in order.

## What changed, in one paragraph

The ontology layer (`config/ontology.toml` + `src/server/ontology/*`) was
reworked: the controlled vocabulary gained an `arity` field (unary `is_a`
classification vs binary relations), inference metadata
(`symmetric`/`inverse`/`transitive`), and many more entity types and label
mappings (vocab bumped through `version = 3`). Extraction now recognizes every
internal link form (`ref:`, `halu:`, the loose `Name (halu:slug)` shorthand)
and re-wraps linked objects as proper `[Title](ref:slug)` links instead of
leaking raw markers into fact text. Every entity now gets an explicit `is_a`
fact. The previously-dead LLM-assisted extraction path is now wired up (new
`config/prompts/ontology.toml`, cached per-article by content+vocab hash), and
a new inference pass derives symmetric/inverse/transitive relations with
decayed confidence. None of this is retroactive — it only affects rows
produced by re-extraction, so **the corpus must be rebuilt** for existing
articles to pick up the new fact shapes.

### Fact-quality changes in the latest revisions

Later commits on this branch tightened how facts are shaped and presented to
the model. These are the changes most visible in the rebuilt corpus:

- **Infobox attributes keep their label.** An infobox row whose label isn't a
  core predicate (e.g. `Hypothesis`, `Nature`, `Key Function`) used to collapse
  to a generic `related_to` fact, discarding the label and falsely implying a
  relation. It's now kept verbatim as the predicate and renders as an attribute
  (`<Title> — Nature: <value>`). `related_to` is reserved for the vocabulary's
  own use. A trailing colon on such labels (`Nature:`) is trimmed.
- **Fact text is sanitized at the source.** Stray markup — emphasis (`*x*`),
  inline code, and the bare `[brackets]` the model emits without a link target —
  is stripped before a value becomes a fact, so malformed markup can't reach the
  model and compound into worse output downstream. Provenance columns are
  untouched.
- **Literal objects that name a real article become links.** A relation object
  stored as a bare literal that matches an existing article title/slug now
  renders as `[Title](ref:slug)`; descriptive literals that match nothing stay
  plain text (no dangling links).
- **Prose body is guaranteed context space.** Retrieval reserves a token budget
  for `article_body` chunks so compact summary/infobox/ontology docs can't crowd
  prose out entirely under a tight budget.
- **LLM extraction is crash-proof.** Truncated (`finish_reason=length`) or
  otherwise malformed model JSON is repaired (`jsonrepair`) and salvaged, and
  non-string fields are coerced/skipped — a bad response no longer aborts an
  article's extraction. The deterministic infobox pass always runs regardless,
  so the LLM stays strictly additive.

## Pre-flight: back up first

This changes the primary SQLite database schema (new columns/tables) and the
LanceDB corpus on disk. Both are cheap to back up and you cannot easily
un-migrate a live database once new columns are written to it.

```bash
# Adjust paths if your config overrides the defaults.
cp data/halupedia.sqlite data/halupedia.sqlite.bak-pre-ontology-rework
cp -r data/rag.lance data/rag.lance.bak-pre-ontology-rework   # if it exists
```

## Step 1 — stop the running instance

The background RAG drainer runs on a 2s timer inside the server process and
will start enqueuing/embedding against a half-migrated schema if left running
during a code swap. Stop the server (however you normally run it — `pm2`,
`systemd`, a foreground process, etc.) before touching code or the database.

## Step 2 — pull the branch and install dependencies

```bash
git fetch origin
git checkout rag-rework   # or merge/rebase it into your deploy branch
pnpm install               # smol-toml / existing deps unchanged, but be safe
```

If your deploy process builds a bundle (`pnpm run build` / `dist/`), rebuild
it now, before restarting anything.

## Step 3 — decide on `rag.ontology_llm_extraction`

This is a new config key in `[rag]` (`config/app.toml` / `.example`). It
defaults to `true` in `config/app.toml` shipped on this branch (`false` in the
`.example` template — examples default conservative). When enabled, every
article reindex fires **one additional light-model call** the first time an
article's content or the vocabulary changes (cached after that in the new
`ontology_llm_cache` table — unchanged articles never re-hit the model).

**Caveats before turning it on:**
- It requires your `light` LLM role to be configured and reachable
  (`[llm.light]` in `config/llm.toml`). If `light` isn't configured, extraction
  calls will fail per-article; failures are caught,
  logged (`ontology.llm_extraction_failed`), cached as empty, and **do not**
  block deterministic indexing — but you'll get no LLM-derived facts and a
  log line per article until you fix the model config.
- The first full corpus rebuild after enabling this will make one light-model
  call per live article. For a large wiki this can take a while and cost
  real tokens/compute — consider running the rebuild during low traffic.
- It is respected by both the live drainer (`src/server/index.ts` startup)
  and the offline scripts (`rag:rebuild` / `rag:process-jobs` / `rag:check`)
  as of `c2d4afdb` — earlier commits on this branch only wired it into the
  live server, so if you're migrating from a mid-branch checkout, pull to at
  least that commit.

If you'd rather roll out deterministic-only first and enable the LLM pass
later, set:

```toml
[rag]
ontology_llm_extraction = false
```

in your `config/app.toml`, then flip it to `true` and re-run `rag:rebuild`
whenever you're ready (see Step 6 — the version/content hash caching means
turning it on later just means the *next* rebuild does the LLM pass, nothing
needs to be redone twice).

## Step 4 — start the server once to run schema migrations

The SQLite migrations (new `entity_relations.inferred_from` column, new
`ontology_llm_cache` table) run automatically on database open
(`src/server/db.ts`) — there is no separate migration command. Simply
starting the server (or running any `rag:*` script, which also opens the
database) applies them:

```bash
npm run server   # or however you normally start it; Ctrl-C once it's up
```

Confirm in the logs there's no startup error. If you see
`rag.startup_corpus_stale` — that's expected right now (see Step 6) and not a
migration failure; it means the vocabulary hash changed and the corpus needs
rebuilding.

## Step 5 — stop the server again before rebuilding

The offline rebuild (Step 6) rewrites the RAG text-document table from
scratch; running it while the live server is also draining jobs against the
same LanceDB path is unsupported and can race. Stop the server.

## Step 6 — rebuild the RAG corpus

This is the mandatory step. The vocabulary version bump invalidates every prior
`ontology_fact` document's shape (new predicates, `is_a` facts, link
formatting, inferred relations) — old rows in LanceDB are stale, not wrong in
a way that self-heals.

> **Note:** the corpus config hash tracks the embedding model, chunker version,
> and `ontology.toml` hash — **not** the extraction/rendering *code*. So a
> code-only fix to fact shaping (the fact-quality changes above) does **not**
> flip the hash, and `rag:check` will report OK even though the corpus predates
> the fix. After pulling code-level fact changes, re-run `rag:rebuild`
> explicitly; don't rely on the stale-corpus signal to prompt you. A clean
> cutover from `main` (no LanceDB corpus yet) gets everything on the first
> build, so this only matters for incremental upgrades within the branch.

```bash
npm run rag:rebuild
```

What this does: drops and rebuilds the `rag_text_documents` table from
scratch (full rebuild, not per-article), re-runs deterministic + (if enabled)
LLM ontology extraction for every live article, re-embeds everything, and
writes fresh corpus metadata. Expect this to take noticeably longer than a
normal rebuild if `ontology_llm_extraction = true`, proportional to your
article count and light-model latency.

For a quick sanity check on a single article before committing to a full
rebuild:

```bash
npm run rag:rebuild -- --slug some-article-slug
```

(Single-slug rebuilds merge into the existing corpus rather than dropping the
whole table — useful for spot-checking the new fact shapes without a full
rebuild.)

If you want to see what would happen without writing anything:

```bash
npm run rag:rebuild -- --dry-run
```

## Step 7 — verify

```bash
npm run rag:check
```

`rag:check` reports document counts by kind and flags a stale/incomplete
corpus. Confirm `ontology_fact` counts are non-zero and the run reports no
pending jobs.

Spot-check a fact-heavy article's `ontology_fact` documents look right — in
particular:
- linked objects render as `[Title](ref:slug)`, not raw `(halu:...)` tails
- an `is_a` line/predicate is present for the article's entity
- infobox attributes read as `<Label>: <value>` (e.g. `Nature: …`), **not** a
  wall of `is related to: <sentence>` — if you still see the latter, that
  article wasn't re-extracted (see the config-hash note in Step 6)
- fact text is clean: no stray `*emphasis*`, backticks, or bare `[brackets]`
- (if LLM extraction is on) some relations exist for articles with little or
  no infobox, which previously had almost no facts at all

A single-article spot check without a script:

```bash
npm run rag:rebuild -- --slug some-fact-heavy-slug
```

then confirm the run reports `pending jobs=0` and no `ontology.llm_extraction_failed`
lines (a `finish_reason=length` on the light model is fine now — it's repaired
and salvaged, not fatal).

The admin `RagTesterPane` (Admin page, "New RAG pipeline tester" — now
collapsed by default, click to expand) lets you run a live retrieval query
against `ontology_fact` documents and inspect provenance without writing a
script.

## Step 8 — restart the server for real

```bash
npm run server   # or your normal process manager command
```

The live background drainer will keep the corpus current from here — no
further manual rebuilds needed unless the vocabulary version changes again in
the future (watch for that same `rag.startup_corpus_stale` signal).

## Rollback

If something goes wrong after Step 6, the fastest rollback is: stop the
server, restore the two backups from the pre-flight step, and check out the
previous commit/branch:

```bash
cp data/halupedia.sqlite.bak-pre-ontology-rework data/halupedia.sqlite
rm -rf data/rag.lance
cp -r data/rag.lance.bak-pre-ontology-rework data/rag.lance
git checkout <previous-ref>
npm run server
```

The new SQLite columns/tables are additive (no data loss on the old schema),
so restoring the backup is safe even if the running instance had already
written new-schema rows.

## Summary checklist

- [ ] Back up `data/halupedia.sqlite` and `data/rag.lance`
- [ ] Stop the running server
- [ ] `git checkout rag-rework && pnpm install` (+ rebuild bundle if applicable)
- [ ] Decide `rag.ontology_llm_extraction` on/off in `config/app.toml`; confirm
      `[llm.light]` is configured if turning it on
- [ ] Start the server once (applies DB schema migrations), then stop it again
- [ ] `npm run rag:rebuild` (full rebuild — mandatory, vocab version bumped;
      re-run after any code-only fact-shaping fix — the config hash won't force it)
- [ ] `npm run rag:check` — confirm non-zero `ontology_fact` counts, no
      pending jobs
- [ ] Spot-check a fact-heavy article: attribute-style facts (`Label: value`),
      clean text, `[Title](ref:slug)` links, no `is related to: <sentence>` walls
- [ ] Restart the server
