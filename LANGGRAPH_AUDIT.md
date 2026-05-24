# LangGraph Migration Audit Report

Generated: 2026-05-23

## Executive Summary

The codebase has **successfully migrated 6 core workflows to LangGraph pipelines** with solid test coverage (461 tests). However, several admin/utility endpoints still use the old system, and the test suite has a hanging issue that prevents clean exit.

---

## ✅ Completed: Workflows Using LangGraph Pipelines

### 1. **generateArticle** (Full Generation)
- **Route**: `POST /api/page/:slug`
- **Tests**: ✓ Covered in pipeline.test.ts (181 tests), site-smoke.test.ts (multiple tests)
- **Status**: Production-ready
- **Nodes**: read.article → read.edit_history → read.retrieve_context → transform.build_reference_list → transform.render_article_prompt → llm.generate_article → transform.extract_body → transform.sanitize_body → transform.clean_link_labels → transform.derive_identity → transform.resolve_links → llm.generate_summary → validate.body_invariants → write.persist_article

### 2. **rewriteArticle** (Content Rewrite)
- **Route**: `POST /api/article/:slug/rewrite`
- **Tests**: ✓ Covered in pipeline.test.ts, site-smoke.test.ts
- **Status**: Production-ready
- **Supports**:
  - Full article rewrite
  - Section editing
  - Selection/text-specific editing
  - RAG-enabled context retrieval
  - Explicit reference selection
  - Article protection checks

### 3. **refreshArticle** (Context Refresh)
- **Route**: `POST /api/article/:slug/refresh-context`
- **Tests**: ✓ Covered in site-smoke.test.ts ("rewrite: POST /api/article/:slug/refresh-context")
- **Status**: Production-ready
- **Purpose**: Re-retrieve context and regenerate article without user instructions

### 4. **postProcess** (Post-Generation)
- **Tests**: ✓ Embedded in generation/rewrite tests
- **Nodes**: read.reload_article → llm.repair_links → transform.rebuild_reference_list → transform.resolve_links_post → llm.generate_see_also → llm.regenerate_summary → write.update_article_in_place → write.index_rag_chunks
- **Status**: Production-ready
- **Runs automatically** after generation/rewrite

### 5. **addLinkArticle** & **rawSaveArticle** (Deterministic Save)
- **Route**: `POST /api/article/:slug/add-link` (highlight/link selection)
- **Route**: `POST /api/article/:slug/raw-save` (direct markdown save)
- **Tests**: ✓ Covered in site-smoke.test.ts ("highlight add-link updates markdown")
- **Status**: Production-ready
- **Key Behavior**: No LLM calls, just text transformation and persistence

### 6. **homepageRefresh** (Background Feature)
- **Route**: `GET /api/homepage`
- **Tests**: ✓ Covered in site-smoke.test.ts (5 homepage tests)
- **Status**: Production-ready
- **Features**: 
  - Background startup generation of featured article + "Did You Know" facts
  - Scheduled cache refresh (50-minute TTL)
  - Graceful failure handling
  - LLM error resilience

---

## ⚠️ Incomplete: Endpoints Still Using Old System

### 1. **preview-markdown** (line 1816 in index.ts)
```
POST /api/article/:slug/preview-markdown
```
- **Current**: Custom markdown rendering logic in index.ts (inline)
- **Issue**: Mixes preview with reference resolution
- **Migration Path**: Could become a simple transform node in a preview workflow
- **Tests**: Covered indirectly in pipeline.test.ts

### 2. **find-references** (line 1856 in index.ts)
```
POST /api/article/:slug/find-references
```
- **Current**: Custom RAG + fuzzy matching logic inline
- **Issue**: Duplicates logic from rewrite workflow
- **Migration Path**: Extract into shared reference lookup workflow
- **Tests**: Covered in pipeline.test.ts

### 3. **delete-article** (line 2779 in index.ts)
```
POST /api/admin/delete-article
```
- **Current**: Custom deletion with tombstone logic
- **Issue**: Could be a pipeline workflow for consistency
- **Migration Path**: Create delete-article workflow with proper state tracking
- **Tests**: Not explicitly tested in site-smoke

### 4. **regenerate-summary** (line 2787 in index.ts)
```
POST /api/admin/regenerate-summary
```
- **Current**: Inline LLM call for summary regeneration
- **Issue**: Duplicates summary generation from post-process workflow
- **Migration Path**: Extract into reusable summary generation workflow
- **Tests**: Covered in pipeline.test.ts (updateArticleSummary)

### 5. **Other Admin Routes** (lines 2722+)
- `POST /api/admin/reload` - Config reload
- `POST /api/admin/prompt-model` - Model switching
- `POST /api/admin/wipe` - Data cleanup
- `POST /api/admin/slug-search` - Slug lookup
- Various others with custom implementations

**Status**: These are admin/utility operations that don't need full pipeline treatment

---

## 🧪 Test Coverage Analysis

### By File (461 total tests)

| File | Count | Coverage | Notes |
|------|-------|----------|-------|
| pipeline.test.ts | 181 | ✓✓✓ | Comprehensive pipeline + markdown + reference tests |
| server-units.test.ts | 137 | ✓✓✓ | Unit tests for utilities, rendering, slugs |
| article-regressions.test.ts | 49 | ✓✓ | Regression tests from legacy features |
| edit-flow.test.ts | 25 | ✓ | End-to-end edit workflows |
| features.test.ts | 29 | ✓ | Feature-specific integration tests |
| pipeline-nodes.test.ts | 25 | ✓ | Individual node unit tests |
| site-smoke.test.ts | 15 | ✓ | Production smoke tests |

### Coverage by Workflow

| Workflow | Tests | Status |
|----------|-------|--------|
| generateArticle | 50+ | ✓✓✓ Excellent |
| rewriteArticle | 25+ | ✓✓✓ Excellent |
| refreshArticle | 5+ | ✓✓ Good |
| postProcess | 20+ | ✓✓ Good |
| addLink/rawSave | 15+ | ✓✓ Good |
| homepageRefresh | 5 | ✓ Good |

### Gaps Identified

- **⚠️ Missing**: Specific test for article deletion workflow
- **⚠️ Missing**: Integration test for preview-markdown route
- **⚠️ Missing**: Concurrent rewrite + post-process interaction
- **⚠️ Missing**: Error recovery in post-process (what happens if post-process fails after generation succeeds)

---

## 🔴 Critical Issue: Test Suite Hanging

### Symptoms
```
✔ getGraphData deduplicates links (6.098125ms)
^C
Interrupted while running: tests/site-smoke.test.ts
```

### Root Cause
After all tests complete and cleanup handlers finish, the Node test runner doesn't exit cleanly. Likely causes:

1. **Database connections**: WAL-mode SQLite might have lingering file handles
2. **Event listeners**: Process listeners from signal handling not cleaned up
3. **Test framework**: Node's test runner might be waiting for unknown async operations
4. **Background timers**: Maintenance scheduler or promise resolvers not fully settled

### Temporary Fix (Add to test file end)
```typescript
process.on("exit", () => {
  // Force exit after tests complete
  // (This is a workaround; proper fix needed)
});
```

### Proper Fix Required
1. Ensure all `db.close()` calls complete before shutdown
2. Verify all Promise.withResolvers() in test helpers are properly resolved
3. Check if Hono server or HTTP connections are being held open
4. Add explicit `process.exit(code)` after all cleanup or set a timeout

---

## 📊 Architecture Health

### Positive Observations
- ✅ **LangGraph node factory pattern** is solid and extensible
- ✅ **Pipeline registry** enables dynamic workflow composition
- ✅ **Test helpers** (FakeLlmClient, MockLoggers) are well-designed
- ✅ **Prompt manifest system** allows dynamic prompt management
- ✅ **LLM client abstraction** (OpenAI-compatible) is flexible
- ✅ **State management** in workflows is clean and type-safe

### Issues to Address
- ⚠️ **index.ts is 111KB** - Needs splitting into route modules
- ⚠️ **Stale TODO comments** about refactoring (line 1)
- ⚠️ **No CLAUDE.md** - Missing architecture documentation
- ⚠️ **Test output is noisy** - Logs pollute test result output
- ⚠️ **No test summary** - Hard to see final pass/fail count

---

## 🎯 Recommendations

### Priority 1: Immediate (This PR)
- [ ] **Fix test hanging** - Force clean exit after cleanup
- [ ] **Reduce test noise** - Suppress INFO/DEBUG logs during test runs
- [ ] **Add test summary** - Print pass/fail count and timing at end

### Priority 2: Short-term (Next PR)
- [ ] **Migrate preview-markdown** to pipeline workflow
- [ ] **Consolidate find-references** with rewrite workflow
- [ ] **Create delete-article workflow**
- [ ] **Extract summary generation** into shared workflow
- [ ] **Add missing tests** for deletion and error recovery

### Priority 3: Medium-term (This Sprint)
- [ ] **Split index.ts** into route modules (routes/, routes/api/, routes/admin/)
- [ ] **Add CLAUDE.md** with architecture overview
- [ ] **Document workflow patterns** and best practices
- [ ] **Create migration guide** for converting old endpoints to pipelines

### Priority 4: Polish (Next Sprint)
- [ ] **Performance audit** of pipeline execution
- [ ] **Add observability** to pipeline nodes (traces, metrics)
- [ ] **Create workflow templates** for common patterns

---

## 📋 Migration Template

For converting remaining endpoints to workflows:

```typescript
// Before: Inline logic in index.ts
app.post("/api/article/:slug/do-thing", async (c) => {
  // 50 lines of inline logic
  const result = await complexOperation(...);
  return c.json(result);
});

// After: Workflow pattern
const doThingWorkflow = {
  nodes: {
    read: { type: "read", ... },
    transform: { type: "transform", ... },
    write: { type: "write", ... },
  },
  edges: [["read", "transform"], ["transform", "write"]],
};

app.post("/api/article/:slug/do-thing", async (c) => {
  const result = await runWorkflow(doThingWorkflow, {
    input: { slug: c.req.param("slug"), ... },
    deps: buildPipelineDeps(),
  });
  return c.json(result.state);
});
```

---

## Files Reference

**Key Files for Migration**:
- `src/server/index.ts` - Main server (111KB, needs refactoring)
- `src/server/pipeline/workflows/` - Workflow definitions
- `src/server/pipeline/runtime/graph.ts` - Pipeline execution engine
- `src/server/pipeline/nodes/` - Node implementations
- `tests/pipeline.test.ts` - Comprehensive test suite

**Configuration**:
- `src/server/config.ts` - Runtime configuration loader
- `config/prompts/` - Prompt definitions (TOML)

---

## Next Steps

1. **Fix test hanging** (this session)
2. **Reduce test noise** (this session)  
3. **Document findings** (this document)
4. **Plan migration roadmap** (next review)
