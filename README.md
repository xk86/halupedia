# Halupedia

Halupedia is now a local-first fictional knowledge engine.

It runs entirely on your machine with:

- a local Hono server
- SQLite persistence
- a local OpenAI-compatible chat endpoint
- optional local embeddings
- Markdown as the canonical article format
- persistent hidden link hints and backlinks

## Local flow

When `/wiki/:slug` is requested and the article does not exist yet:

1. incoming hidden link hints are loaded from SQLite
2. optional retrieval context is assembled
3. the local LLM generates restricted Markdown
4. internal `halu:` links and hidden hints are extracted from Markdown
5. graph edges are persisted
6. Markdown is rendered to HTML
7. the article is cached permanently in SQLite

The graph grows over time, including edges to unwritten articles.

## Configuration

All runtime configuration is TOML-based:

- [config/app.toml](REPO_ROOT/config/app.toml)
- [config/llm.toml](REPO_ROOT/config/llm.toml)
- [config/prompts.toml](REPO_ROOT/config/prompts.toml)

Prompts are user-owned. The code only loads prompts, renders templates, injects context, calls the LLM, parses output, and persists graph state.

## Run locally

Requirements:

- Node.js 25+
- a local OpenAI-compatible chat endpoint
- optionally a local OpenAI-compatible embeddings endpoint

Install dependencies:

```bash
npm install
```

Run the app:

```bash
npm run dev
```

The client is built into `dist/`, and the local server serves it on `http://127.0.0.1:8787`.

## Notes

- Article source of truth is Markdown, not rendered HTML.
- Internal links must use `[visible text](halu:target-slug "hidden context hint")`.
- Hidden context hints are never rendered, but they are persisted and reused as future canon.
- RAG is optional and can be enabled through [config/app.toml](REPO_ROOT/config/app.toml) and [config/llm.toml](REPO_ROOT/config/llm.toml).
