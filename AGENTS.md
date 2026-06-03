# AGENTS

This file is for future Codex and Claude sessions working in this fork of Halupedia. Treat it as the local operating manual for the project as it exists here, not as a generic upstream summary.

Never commit examples copied from local databases, debug logs, traces, or generated articles. Local content may contain private, noisy, or deliberately odd material that must not become public test data, docs, or prompt guidance.

Avoid named examples when modifying prompts unless a test explicitly requires them. Preserve the existing prompt tone and scope. Do not add source-code prompt instructions when the text belongs in TOML config.
## Mission

Halupedia is a local-first fictional encyclopedia engine.

Core properties of this fork:

- The server is local and runs on Hono.
- Persistence is SQLite via `node:sqlite`.
- Articles are canonically stored as Markdown, with rendered HTML cached alongside them.
- The knowledge graph is built from internal `halu:` links plus their hidden hints.
- Retrieval is optional, local, and backed by stored article chunks.
- Prompt behavior is intended to be user-owned through TOML config, not buried in source.

## Current Architecture

### Server

- Entry point: [src/server/index.ts](src/server/index.ts)
- Config loading: [src/server/config.ts](src/server/config.ts)
- Persistence and schema bootstrapping: [src/server/db.ts](src/server/db.ts)
- LLM transport: [src/server/llm.ts](src/server/llm.ts)
- Prompt lookup and template rendering: [src/server/prompts.ts](src/server/prompts.ts)
- Retrieval and chunk indexing: [src/server/retrieval.ts](src/server/retrieval.ts)
- Markdown parsing/rendering/link extraction lives under `src/server/markdown.ts`.

The main article flow today is:

1. Resolve slug and canonical path handling.
2. Check SQLite cache for an existing article or alias.
3. Load incoming hidden hints from `article_links`.
4. Optionally retrieve related chunk context from `article_chunks`.
5. Render prompt templates from `config/prompts/`.
6. Call the local OpenAI-compatible endpoint.
7. Normalize Markdown, extract `halu:` links, persist article + graph edges + aliases.
8. Render HTML and serve JSON or NDJSON streaming responses.

### Client

- SPA entry: [src/client/App.tsx](src/client/App.tsx)
- Other major UI modules are already split into `Admin`, `AllEntries`, `SearchResults`, `Sidebar`, and `Comments`.
- The client consumes `/api/page/:slug`, `/api/search`, `/api/index`, and admin/article mutation endpoints.
- Article generation supports streaming NDJSON; the client incrementally updates rendered HTML during generation.

### Data Model

Primary tables in SQLite:

- `articles`: canonical article record, Markdown source of truth, rendered HTML cache, plain text, canonical slug.
- `article_links`: graph edges with visible label and hidden hint.
- `article_aliases`: alternate lookup slugs pointing at canonical articles.
- `article_chunks`: retrieval chunks and optional embeddings.
- `users`, `comments`, `votes`: local discussion system.

Design intent:

- Hidden hints are canon and are reused as future context.
- Backlinks include unwritten targets, so the graph can grow before articles exist.
- Markdown is the durable representation; HTML is derived/cacheable.

## Config Surfaces

Runtime config is TOML-based:

- [config/app.toml.example](config/app.toml.example)
- [config/llm.toml.example](config/llm.toml.example)
- [config/prompts/](config/prompts/)

Important local rule for this fork:

- Anywhere a prompt is prompting, the user must be able to configure it in TOML.
- Do not hardcode new model-facing prompt instructions in TypeScript.
- If a feature needs new prompt text, add it under `config/prompts/`, wire it through typed config, and cover it with tests.
- Keep source code responsible for template selection, variable injection, validation, transport, and parsing, not for owning prompt content.

Related note:

- `src/server/config.ts` and `src/server/types.ts` currently type only a subset of `config/llm.toml`. For example, `top_k` and `top_p` exist in the file today but are not wired through the typed config or request payload. If extending LLM settings, update types, config loading, transport, and tests together.

## Working Rules For Future Edits

- Always write tests for behavior changes.
- Prefer adding or updating tests in [tests/site-smoke.test.ts](tests/site-smoke.test.ts) and [tests/article-regressions.test.ts](tests/article-regressions.test.ts), or add a new focused test file if the concern is distinct.
- Do not ship behavior changes that only "seem obvious" without executable coverage.
- Modularize code. Do not keep inflating `src/server/index.ts` or `src/client/App.tsx` when a concern can be extracted into a focused module.
- Preserve Markdown as the article source of truth.
- Preserve `halu:` link semantics and hidden-hint persistence unless a change explicitly revisits that contract.
- Preserve local-first assumptions. Do not introduce unnecessary hosted-service dependencies.
- Keep configuration user-editable. If a user might reasonably want to tune it, prefer TOML configuration over source edits.

## Preferred Change Strategy

- First inspect existing modules and fit new code into the current boundaries.
- When debugging a behavior bug, first trace the current logic path that produces it, then write tests that capture that understanding before writing any patch.
- Prefer deterministic application logic over asking a language model to infer something an algorithm can decide. If someone has already done the hard part of the algorithmic work, reuse or adapt that logic instead of delegating it to the model.
- If adding prompt-driven behavior, create or extend prompt keys under `config/prompts/` instead of embedding instructions inline.
- If adding config, update `src/server/types.ts`, `src/server/config.ts`, and any affected runtime call sites together.
- If adding server logic that is independently testable, extract a helper/module instead of growing one large route handler.
- If adding client behavior, prefer small components or utilities over expanding monolithic state/effect blocks.

## Verification Expectations

Before finishing work when code changes were made:

- Run the relevant tests at minimum.
- Run the full test suite when the change spans routing, persistence, prompt handling, or rendering.
- If config or prompt wiring changed, include regression coverage for missing keys, rendering behavior, or request payload effects as appropriate.

## Practical Commands

- Install: `npm install`
- Dev: `npm run dev`
- Build: `npm run build`
- Typecheck: `npm run typecheck`
- Test: `npm test`

Default expectation for future Codex work in this repo: make the smallest coherent change, keep it modular, expose prompt text through TOML, and leave behind tests that prove the behavior.
