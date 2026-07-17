# Halupedia Link Formats

This document defines the two primary internal link formats used within the Halumedia engine and how they differ in purpose and usage.

## 1. Halu Links (`halu:`)

**Purpose:** Used to represent "hallucinated" or predicted links to articles that **do not yet exist** in the database. They act as seeds for future article creation.

- **Format:** `[Title](halu:slug "hidden hint")`
- **Components:**
    - **Title:** The human-readable title of the proposed article.
    - **Slug:** The canonical, slugified identifier for the proposed article.
    - **Hidden Hint:** An optional, descriptive string (wrapped in quotes) that provides context or "hints" to the LLM about what that article should contain.
- **Usage:**
    - **LLM Generation:** During article generation, the LLM uses these links to suggest related topics.
    - **Injection:** When generating new content, the system injects existing `halu:` links from the context to guide the model.
    - **Parsing:** The engine parses these during the normalization process to extract the slug and hint for the knowledge graph.
- **Key Behavior:** These links are "hallucinated" in the sense that the target article is a prediction, not a verified entry in the `articles` table.

## 2. Reference Links (`ref:`)

**Purpose:** Used to link to **existing, verified articles** in the database. These are used for citations, references, and the "See also" section.

- **Format:** `[Title](ref:slug)` or short-hand `[Text](ref:N)` (where N is an index in the reference list).
- **Components:**
    - **Title:** The human-readable title of the existing article.
    - **Slug:** The canonical, slugified identifier of an article that **must** exist in the `articles` table.
- **Usage:**
    - **References Section:** When an article is generated, the system identifies `halu:` links that point to existing articles and converts them into `ref:` links in the "References" section.
    - **Prompting:** The system builds a list of available references (e.g., "1. Title (slug)") and provides this list to the LLM in the prompt. The LLM can then use the shorthand `[text](ref:1)` to cite them.
    - **Parsing:** The `resolveRefLinks` utility expands short-hand `ref:N` or `ref:slug` links into durable, slug-based links.
- **Key Behavior:** Unlike `halu:` links, every `ref:` link target is a guaranteed entry in the database.

## Summary Comparison

| Feature | `halu:` Links | `ref:` Links |
| :--- | :--- | :--- |
| **Target Status** | Predicted / Non-existent | Existing / Verified |
| **Primary Role** | Topic seeding & hints | Citations & References |
| **Contains Hints?** | Yes (via ) | No (target is the article itself) |
| **LLM usage** | Suggesting new connections | Cinting known information |
| **Format Example** | `[Apple](halu:apple "A fruit")` | `[Apple](ref:apple)` |

## Reference Link Canonical Form

Ref-citation links accept two input forms but always canonicalize to one:

| Input form | Status | Notes |
|---|---|---|
| `[text](ref:slug-name)` | **Canonical / preferred** | The slug is shown directly in `{{references_list}}` next to the title so the model can copy it without tracking ordinal numbers. This is what `resolveRefLinks` outputs to stored markdown. |
| `[text](ref:N)` | Accepted fallback | 1-based index into the reference list. Resolved into `ref:slug` at save time. Listed in `{{references_list}}` as "also reachable as ref:N" so legacy prompts and copy-paste from older articles keep working. |

`formatReferencesForPrompt` renders each line as `- ref:slug → Title  (also reachable as ref:N)`. Prompts (`article.toml`, `article_refresh.toml`, and the `linking` rule category) call out the slug form as the default. The numeric form is kept supported but de-emphasized so the model stops having to do ordinal arithmetic.
