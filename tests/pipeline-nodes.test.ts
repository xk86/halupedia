/**
 * Unit tests for the LangGraph pipeline layer.
 *
 * Covers:
 *  - cleanLinkLabels (deterministic transform, all dirty-label variants)
 *  - defineNode read/write enforcement (compile-time + runtime)
 *  - transform nodes: extract_body, sanitize_body, clean_link_labels,
 *    derive_identity, validate_body_invariants
 *  - graph introspection: describeWorkflow / describeWorkflowAsDot
 *  - trace recorder: writes pipeline_runs + pipeline_nodes rows
 *  - workflow registry: ALL_WORKFLOWS populated, findWorkflow works
 *  - runWorkflow end-to-end with stub nodes
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";

// ── subject under test ───────────────────────────────────────────────────────
import { cleanLinkLabels } from "../src/server/markdown";
import { defineNode } from "../src/server/pipeline/runtime/nodeFactory";
import {
  describeWorkflow,
  describeWorkflowAsDot,
  workflowSummary,
} from "../src/server/pipeline/runtime/introspect";
import {
  getTraceRecorder,
  closeTraceRecorder,
  diffState,
  hashValue,
  newRunId,
} from "../src/server/pipeline/runtime/trace";
import { runWorkflow } from "../src/server/pipeline/runtime/graph";
import { ALL_WORKFLOWS, findWorkflow } from "../src/server/pipeline/registry";
import {
  initialPipelineState,
  type PipelineState,
  type WorkflowInput,
} from "../src/server/pipeline/state";
import type { WorkflowDefinition } from "../src/server/pipeline/runtime/graph";

// ── helpers ──────────────────────────────────────────────────────────────────

function tmpDir() {
  const dir = mkdtempSync(join(tmpdir(), "halu-pipeline-test-"));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function makeInput(overrides: Partial<WorkflowInput> = {}): WorkflowInput {
  return {
    requestId: randomUUID(),
    workflow: "test",
    slug: "test-slug",
    requestedTitle: "Test Slug",
    ...overrides,
  };
}

// ── cleanLinkLabels ──────────────────────────────────────────────────────────

test("cleanLinkLabels: strips (halu:slug) from visible label", () => {
  const dirty =
    `[Security Credentials (halu:security-credentials)](halu:security-credentials "vault hint")`;
  const result = cleanLinkLabels(dirty);
  assert.match(result, /^\[Security Credentials\]\(halu:security-credentials/);
  assert.doesNotMatch(result, /halu:security-credentials.*halu:security-credentials/);
});

test("cleanLinkLabels: whole label is bare halu: fragment → falls back to slugToTitle", () => {
  const dirty = `[halu:foo-bar](halu:foo-bar "some hint")`;
  const result = cleanLinkLabels(dirty);
  // Label should not start with halu:
  assert.doesNotMatch(result, /^\[halu:/);
  // Should still be a halu: link
  assert.match(result, /\(halu:foo-bar/);
});

test("cleanLinkLabels: ref: fragment in label is stripped", () => {
  const dirty = `[Title (ref:some-thing)](halu:some-thing "hint")`;
  const result = cleanLinkLabels(dirty);
  assert.match(result, /^\[Title\]/);
});

test("cleanLinkLabels: clean link is unchanged", () => {
  const clean = `[Security Credentials](halu:security-credentials "vault hint")`;
  assert.equal(cleanLinkLabels(clean), clean);
});

test("cleanLinkLabels: external link is unchanged", () => {
  const ext = `[click here](https://example.com)`;
  assert.equal(cleanLinkLabels(ext), ext);
});

test("cleanLinkLabels: multiple dirty links in one string", () => {
  const dirty = [
    `[Foo (halu:foo)](halu:foo "hint1")`,
    " and ",
    `[Bar (halu:bar)](halu:bar "hint2")`,
  ].join("");
  const result = cleanLinkLabels(dirty);
  assert.match(result, /^\[Foo\]/);
  assert.match(result, /\[Bar\]/);
  assert.doesNotMatch(result, /\(halu:foo\)/);
  assert.doesNotMatch(result, /\(halu:bar\)/);
});

// ── defineNode read/write enforcement ────────────────────────────────────────

test("defineNode: rejects duplicate reads declaration", () => {
  assert.throws(
    () =>
      defineNode({
        name: "test.duplicate_reads",
        kind: "transform",
        reads: ["input", "input"] as const,
        writes: [] as const,
        run: () => ({}),
      }),
    /duplicate keys in reads/,
  );
});

test("defineNode: rejects duplicate writes declaration", () => {
  assert.throws(
    () =>
      defineNode({
        name: "test.duplicate_writes",
        kind: "transform",
        reads: [] as const,
        writes: ["articleBody", "articleBody"] as const,
        run: () => ({ articleBody: "" }),
      }),
    /duplicate keys in writes/,
  );
});

test("defineNode: runtime rejects patch with undeclared write key", async () => {
  const node = defineNode({
    name: "test.sneaky",
    kind: "transform",
    reads: [] as const,
    writes: ["articleBody"] as const,
    run: () =>
      // Deliberately return an undeclared key to test runtime guard.
      ({ articleBody: "ok", articleSummary: "SNEAKED" } as { articleBody: string }),
  });

  const state = initialPipelineState(makeInput());
  await assert.rejects(
    () => node.run(state, undefined),
    /undeclared write 'articleSummary'/,
  );
});

test("defineNode: valid patch passes runtime guard", async () => {
  const node = defineNode({
    name: "test.valid",
    kind: "transform",
    reads: ["input"] as const,
    writes: ["canonicalSlug"] as const,
    run: () => ({ canonicalSlug: "my-slug" }),
  });

  const state = initialPipelineState(makeInput());
  const patch = await node.run(state, undefined);
  assert.equal(patch.canonicalSlug, "my-slug");
});

// ── diffState ────────────────────────────────────────────────────────────────

test("diffState: detects add, change, remove", () => {
  const before = initialPipelineState(makeInput());
  const after: PipelineState = {
    ...before,
    canonicalSlug: "new-slug",
    articleBody: "# Hello",
  };
  const diff = diffState(before, after);
  assert.equal(diff.canonicalSlug?.kind, "add");
  assert.equal(diff.articleBody?.kind, "add");
  assert.ok(!diff.input, "unchanged field should not appear in diff");
});

test("diffState: no diff for identical states", () => {
  const s = initialPipelineState(makeInput());
  const diff = diffState(s, s);
  assert.equal(Object.keys(diff).length, 0);
});

// ── hashValue ────────────────────────────────────────────────────────────────

test("hashValue: same input → same hash", () => {
  assert.equal(hashValue("hello"), hashValue("hello"));
});

test("hashValue: different inputs → different hashes", () => {
  assert.notEqual(hashValue("hello"), hashValue("world"));
});

// ── graph introspection ──────────────────────────────────────────────────────

test("describeWorkflow: includes all node names for article.generate", () => {
  const wf = findWorkflow("article.generate");
  assert.ok(wf, "article.generate must be registered");
  const described = describeWorkflow(wf);
  const names = described.nodes.map((n) => n.name);
  assert.ok(names.includes("read.article"));
  assert.ok(names.includes("llm.generate_article"));
  assert.ok(names.includes("transform.clean_link_labels"));
  assert.ok(names.includes("write.persist_article"));
});

test("describeWorkflow: produces data edges between producers and consumers", () => {
  const wf = findWorkflow("article.generate");
  assert.ok(wf);
  const described = describeWorkflow(wf);
  const dataEdges = described.edges.filter((e) => e.kind === "data");
  // renderedPrompt is written by render_article_prompt and read by llm.generate_article
  const promptEdge = dataEdges.find(
    (e) => e.from === "transform.render_article_prompt" &&
           e.to === "llm.generate_article" &&
           e.field === "renderedPrompt",
  );
  assert.ok(promptEdge, "expected data edge from render_article_prompt to llm.generate_article via renderedPrompt");
});

test("describeWorkflowAsDot: output starts with digraph", () => {
  const wf = findWorkflow("article.generate");
  assert.ok(wf);
  const dot = describeWorkflowAsDot(wf);
  assert.match(dot, /^digraph "article\.generate"/);
  assert.match(dot, /read\.article/);
  assert.match(dot, /write\.persist_article/);
});

test("workflowSummary: includes node count and kind breakdown", () => {
  const wf = findWorkflow("article.generate");
  assert.ok(wf);
  const summary = workflowSummary(wf);
  assert.match(summary, /article\.generate/);
  assert.match(summary, /\d+ nodes/);
  assert.match(summary, /llm=\d+/);
});

// ── workflow registry ────────────────────────────────────────────────────────

test("ALL_WORKFLOWS contains article.generate, article.refresh, article.rewrite, article.post_process", () => {
  const names = ALL_WORKFLOWS.map((w) => w.name);
  assert.ok(names.includes("article.generate"));
  assert.ok(names.includes("article.refresh"));
  assert.ok(names.includes("article.rewrite"));
  assert.ok(names.includes("article.post_process"));
});

test("findWorkflow returns undefined for unknown name", () => {
  assert.equal(findWorkflow("no-such-workflow"), undefined);
});

// ── trace recorder ───────────────────────────────────────────────────────────

test("SqliteTraceRecorder: writes run and node rows, reads back correctly", () => {
  const { dir, cleanup } = tmpDir();
  try {
    const dbPath = join(dir, "traces.sqlite");
    const recorder = getTraceRecorder({
      enabled: true,
      database_path: dbPath,
      level: "trace",
      retention_days: 1,
    });
    const runId = newRunId();
    recorder.recordRun({
      workflow: "test.workflow",
      runId,
      requestId: "req-1",
      slug: "test-slug",
      startedAt: 1000,
      durationMs: 500,
      status: "ok",
      nodesExecuted: 1,
    });
    recorder.recordNode({
      workflow: "test.workflow",
      runId,
      nodeName: "test.node",
      nodeKind: "transform",
      startedAt: 1000,
      durationMs: 100,
      status: "ok",
      reads: ["input"],
      writes: ["articleBody"],
      inputs: { input: { requestId: "req-1", workflow: "test" } },
      patch: { articleBody: "# Hello" },
      diff: { articleBody: { kind: "add", after: "# Hello" } },
    });
    // Close the cached recorder so we can open the DB for reading.
    closeTraceRecorder();

    const db = new DatabaseSync(dbPath, { readOnly: true });
    const run = db.prepare("SELECT * FROM pipeline_runs WHERE run_id = ?").get(runId) as Record<string, unknown> | undefined;
    assert.ok(run, "run row should exist");
    assert.equal(run.workflow, "test.workflow");
    assert.equal(run.status, "ok");
    assert.equal(run.nodes_executed, 1);

    const nodes = db.prepare("SELECT * FROM pipeline_nodes WHERE run_id = ?").all(runId) as Array<Record<string, unknown>>;
    assert.equal(nodes.length, 1);
    assert.equal(nodes[0].node_name, "test.node");
    assert.equal(nodes[0].status, "ok");
    assert.ok(nodes[0].diff_json, "diff_json should be populated at trace level");
    db.close();
  } finally {
    cleanup();
  }
});

test("NoopRecorder: does nothing when disabled", () => {
  const recorder = getTraceRecorder({ enabled: false, database_path: "unused.sqlite", level: "off", retention_days: 0 });
  assert.equal(recorder.level, "off");
  // Should not throw.
  recorder.recordRun({ workflow: "x", runId: "r", requestId: "q", startedAt: 0, durationMs: 0, status: "ok", nodesExecuted: 0 });
  recorder.recordNode({ workflow: "x", runId: "r", nodeName: "n", nodeKind: "transform", startedAt: 0, durationMs: 0, status: "ok", reads: [], writes: [] });
});

// ── runWorkflow: end-to-end with stub nodes ──────────────────────────────────

test("runWorkflow: executes nodes in order, produces trace", async () => {
  const { dir, cleanup } = tmpDir();
  try {
    const log: string[] = [];

    const nodeA = defineNode({
      name: "test.a",
      kind: "transform",
      reads: ["input"] as const,
      writes: ["canonicalSlug"] as const,
      run: ({ input }) => {
        log.push("a");
        return { canonicalSlug: `${input.slug}-processed` };
      },
    });
    const nodeB = defineNode({
      name: "test.b",
      kind: "transform",
      reads: ["canonicalSlug"] as const,
      writes: ["canonicalTitle"] as const,
      run: ({ canonicalSlug }) => {
        log.push("b");
        return { canonicalTitle: `Title for ${canonicalSlug ?? "?"}` };
      },
    });

    const wf: WorkflowDefinition<undefined> = {
      name: "test.sequential",
      edges: [{ node: nodeA }, { node: nodeB }],
    };

    const recorder = getTraceRecorder({
      enabled: true,
      database_path: join(dir, "traces.sqlite"),
      level: "debug",
      retention_days: 1,
    });

    const result = await runWorkflow(wf, {
      input: makeInput({ slug: "my-slug" }),
      deps: undefined,
      recorder,
    });

    assert.equal(result.status, "ok");
    assert.equal(result.nodesExecuted, 2);
    assert.equal(result.state.canonicalSlug, "my-slug-processed");
    assert.equal(result.state.canonicalTitle, "Title for my-slug-processed");
    assert.deepEqual(log, ["a", "b"]);
  } finally {
    closeTraceRecorder();
    cleanup();
  }
});

test("runWorkflow: captures embedded thinking tags as cot_text", async () => {
  const { dir, cleanup } = tmpDir();
  try {
    const dbPath = join(dir, "traces.sqlite");
    const recorder = getTraceRecorder({
      enabled: true,
      database_path: dbPath,
      level: "trace",
      retention_days: 1,
    });
    const llmNode = defineNode({
      name: "test.llm",
      kind: "llm",
      reads: ["input"] as const,
      writes: ["llmOutput"] as const,
      async run(_state, deps: { llm: { chat: (...args: unknown[]) => Promise<string> } }) {
        const text = await deps.llm.chat("heavy", "system", "user");
        return { llmOutput: { promptKey: "test", text } };
      },
    });
    const workflow: WorkflowDefinition<{ llm: { chat: (...args: unknown[]) => Promise<string> } }> = {
      name: "test.embedded-cot",
      edges: [{ node: llmNode }],
    };

    const result = await runWorkflow(workflow, {
      input: makeInput({ workflow: "test.embedded-cot" }),
      deps: {
        llm: {
          async chat() {
            return "<think>Check hidden assumptions.</think>\n\n## Final\nRendered answer.";
          },
        },
      },
      recorder,
    });
    closeTraceRecorder();
    assert.equal(result.status, "ok");

    const db = new DatabaseSync(dbPath, { readOnly: true });
    const row = db.prepare("SELECT cot_text, response_text FROM pipeline_nodes WHERE run_id = ?").get(result.runId) as Record<string, unknown>;
    assert.match(String(row.cot_text), /Check hidden assumptions/);
    assert.match(String(row.response_text), /Rendered answer/);
    db.close();
  } finally {
    cleanup();
  }
});

test("runWorkflow: when predicate skips node", async () => {
  const log: string[] = [];

  const nodeA = defineNode({
    name: "test.always",
    kind: "transform",
    reads: ["input"] as const,
    writes: ["isProtected"] as const,
    run: () => { log.push("a"); return { isProtected: true }; },
  });
  const nodeB = defineNode({
    name: "test.skipped",
    kind: "llm",
    reads: ["input"] as const,
    writes: ["canonicalSlug"] as const,
    run: () => { log.push("b"); return { canonicalSlug: "should-not-appear" }; },
  });

  const wf: WorkflowDefinition<undefined> = {
    name: "test.conditional",
    edges: [
      { node: nodeA },
      { node: nodeB, when: (s) => s.isProtected !== true },
    ],
  };

  const recorder = getTraceRecorder({ enabled: false, database_path: "unused.sqlite", level: "off", retention_days: 0 });
  const result = await runWorkflow(wf, { input: makeInput(), deps: undefined, recorder });

  assert.equal(result.status, "ok");
  assert.equal(result.nodesExecuted, 1);
  assert.deepEqual(log, ["a"]);
  assert.equal(result.state.canonicalSlug, undefined);
});

test("runWorkflow: captures node error, marks run status=error", async () => {
  const nodeA = defineNode({
    name: "test.throws",
    kind: "validate",
    reads: ["input"] as const,
    writes: [] as const,
    run: () => { throw new Error("deliberate failure"); },
  });

  const wf: WorkflowDefinition<undefined> = {
    name: "test.error",
    edges: [{ node: nodeA }],
  };

  const recorder = getTraceRecorder({ enabled: false, database_path: "unused.sqlite", level: "off", retention_days: 0 });
  const result = await runWorkflow(wf, { input: makeInput(), deps: undefined, recorder });

  assert.equal(result.status, "error");
  assert.ok(result.error?.message.includes("deliberate failure"));
  assert.equal(result.nodesExecuted, 0);
});
