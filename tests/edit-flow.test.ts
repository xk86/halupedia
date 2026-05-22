import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, saveArticle, getArticleByLookup, listArticleRevisions } from "../src/server/db";
import { loadConfig } from "../src/server/config";
import { createApp } from "../src/server/index";
import type { LlmClient } from "../src/server/llm";
import type { LogFields, Logger } from "../src/server/logger";
import { renderMarkdown, markdownToPlainText } from "../src/server/markdown";

interface CapturedLogEntry {
  level: "debug" | "info" | "warn" | "error";
  event: string;
  fields?: LogFields;
}

const TEST_CONFIG = loadConfig().app.tests;

function createMemoryLogger(entries: CapturedLogEntry[]): Logger {
  return {
    debug(event, fields) { entries.push({ level: "debug", event, fields }); },
    info(event, fields) { entries.push({ level: "info", event, fields }); },
    warn(event, fields) { entries.push({ level: "warn", event, fields }); },
    error(event, fields) { entries.push({ level: "error", event, fields }); },
  };
}

function seedArticle(databasePath: string, slug: string, title: string, body: string) {
  const markdown = `# ${title}\n\n${body}`;
  const db = openDatabase(databasePath);
  saveArticle(
    db,
    {
      slug,
      canonicalSlug: slug,
      title,
      markdown,
      html: renderMarkdown(markdown),
      plain_text: markdownToPlainText(markdown),
      generated_at: Date.now(),
    },
    [],
    [slug],
  );
  db.close();
  return markdown;
}

function createTestDb() {
  const root = mkdtempSync(join(tmpdir(), "halupedia-edit-test-"));
  const databasePath = join(root, TEST_CONFIG.database_path);
  return { root, databasePath };
}

class RewriteLlmClient implements LlmClient {
  chatCalls: Array<{ system: string; user: string }> = [];
  private rewriteBody: string;

  constructor(rewriteBody: string) {
    this.rewriteBody = rewriteBody;
  }

  private rewriteEnvelope(): string {
    return `---body\n${this.rewriteBody}\n---used-refs\n[]`;
  }

  private isArticleOp(system: string, user: string): boolean {
    return system.includes("Rewrite") || system.includes("Refresh") || user.includes("---body");
  }

  async chat(system: string, user: string): Promise<string> {
    if (this.isArticleOp(system, user)) {
      this.chatCalls.push({ system, user });
      return this.rewriteEnvelope();
    }
    return JSON.stringify({ items: [] });
  }

  async streamChat(
    system: string,
    user: string,
    onChunk: (delta: string, accumulated: string) => void,
  ): Promise<{ content: string; finishReason: string }> {
    // Only track article-operation calls; post-processing (see-also, summary) are not tracked.
    if (this.isArticleOp(system, user)) this.chatCalls.push({ system, user });
    const content = this.rewriteEnvelope();
    // Emit header first so parsePartialArticleFrame can start streaming body
    const header = "---body\n";
    onChunk(header, header);
    const rest = content.slice(header.length);
    onChunk(rest, content);
    return { content, finishReason: "stop" };
  }

  async embed(): Promise<number[][]> { return []; }
  async probeConnections(): Promise<void> {}
}

class DelayedRewriteLlmClient implements LlmClient {
  chatCalls = 0;
  readonly gate = Promise.withResolvers<void>();
  private rewriteBody: string;

  constructor(rewriteBody: string) {
    this.rewriteBody = rewriteBody;
  }

  async chat(): Promise<string> {
    this.chatCalls++;
    await this.gate.promise;
    return JSON.stringify({ items: [] });
  }

  async streamChat(
    _system: string,
    _user: string,
    onChunk: (delta: string, accumulated: string) => void,
  ): Promise<{ content: string; finishReason: string }> {
    const content = `---body\n${this.rewriteBody}\n---used-refs\n[]`;
    onChunk(content, content);
    return { content, finishReason: "stop" };
  }

  async embed(): Promise<number[][]> { return []; }
  async probeConnections(): Promise<void> {}
}

async function createTestServer(options: {
  databasePath: string;
  logger?: Logger;
  llmClient?: LlmClient;
}) {
  const { app, shutdown } = await createApp({
    databasePath: options.databasePath,
    skipLlmProbe: true,
    skipHomepagePrepare: true,
    logger: options.logger,
    llmClient: options.llmClient,
  });
  return {
    shutdown,
    request: (path: string, init?: RequestInit) =>
      app.fetch(new Request(`http://halupedia.test${path}`, init)),
  };
}

async function readNdjson(res: Response): Promise<any[]> {
  const text = await res.text();
  return text.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

function parseNdjson<T>(payload: string): T[] {
  return payload.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as T);
}

test("rewrite persists updated article to database", async (t) => {
  const { root, databasePath } = createTestDb();
  seedArticle(databasePath, "test-rewrite", "Test Rewrite", "Original content about widgets.");
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const rewrittenMarkdown = "# Test Rewrite\n\n**Test Rewrite** is a revised article about gadgets and gizmos.";
  const llm = new RewriteLlmClient(rewrittenMarkdown);
  const server = await createTestServer({ databasePath, llmClient: llm });

  const res = await server.request("/api/article/test-rewrite/rewrite?stream=1", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ instructions: "change widgets to gadgets" }),
  });
  assert.equal(res.status, 200);

  const packets = parseNdjson<Record<string, unknown>>(await res.text());
  const done = packets.find((p) => p.type === "done");
  assert.ok(done, "stream should emit a done event");
  assert.ok((done as any).article, "done event should include article");
  assert.match((done as any).article.markdown, /gadgets and gizmos/);

  const db = openDatabase(databasePath);
  const saved = getArticleByLookup(db, "test-rewrite");
  db.close();
  assert.ok(saved, "article should exist in DB after rewrite");
  assert.match(saved.markdown, /gadgets and gizmos/, "DB should have the rewritten content");
  assert.doesNotMatch(saved.markdown, /Original content/, "old content should be replaced");
  await server.shutdown();
});

test("rewrite with non-streaming mode persists correctly", async (t) => {
  const { root, databasePath } = createTestDb();
  seedArticle(databasePath, "test-nostream", "Test Nostream", "Original boring text.");
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const rewrittenMarkdown = "# Test Nostream\n\n**Test Nostream** is now exciting and thrilling.";
  const llm = new RewriteLlmClient(rewrittenMarkdown);
  const server = await createTestServer({ databasePath, llmClient: llm });

  const res = await server.request("/api/article/test-nostream/rewrite", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ instructions: "make it exciting" }),
  });
  assert.equal(res.status, 200);

  const contentType = res.headers.get("content-type") ?? "";
  if (contentType.includes("application/x-ndjson")) {
    const packets = parseNdjson<Record<string, unknown>>(await res.text());
    const done = packets.find((p) => p.type === "done");
    assert.ok(done);
    assert.match((done as any).article.markdown, /exciting and thrilling/);
  } else {
    const body = await res.json();
    assert.equal(body.cached, true);
    assert.match(body.article.markdown, /exciting and thrilling/);
  }

  const db = openDatabase(databasePath);
  const saved = getArticleByLookup(db, "test-nostream");
  db.close();
  assert.ok(saved);
  assert.match(saved.markdown, /exciting and thrilling/);
  await server.shutdown();
});

test("rewrite passes correct mode prompt to LLM", async (t) => {
  const { root, databasePath } = createTestDb();
  seedArticle(databasePath, "mode-test", "Mode Test", "Some content.");
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const llm = new RewriteLlmClient("# Mode Test\n\nRewritten.");
  const server = await createTestServer({ databasePath, llmClient: llm });

  await server.request("/api/article/mode-test/rewrite", {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({ instructions: "test", rewriteMode: "subtle" }),
  });

  const streamCall = llm.chatCalls.find((c) => c.system.includes("Rewrite Mode"));
  assert.ok(streamCall, "LLM should receive a system prompt with Rewrite Mode");
  assert.match(streamCall.system, /Preserve the existing tone/, "subtle mode prompt should be injected");
  assert.doesNotMatch(streamCall.system, /expanded.*creative license/i, "aggressive mode should not leak into subtle");

  llm.chatCalls.length = 0;
  await server.request("/api/article/mode-test/rewrite", {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({ instructions: "test", rewriteMode: "aggressive" }),
  });

  const aggressiveCall = llm.chatCalls.find((c) => c.system.includes("Rewrite Mode"));
  assert.ok(aggressiveCall);
  assert.match(aggressiveCall.system, /expanded.*creative license|restructure sections/i, "aggressive mode prompt should be injected");
  await server.shutdown();
});

test("rewrite defaults to aggressive mode when no mode specified", async (t) => {
  const { root, databasePath } = createTestDb();
  seedArticle(databasePath, "default-mode", "Default Mode", "Content.");
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const llm = new RewriteLlmClient("# Default Mode\n\nRewritten.");
  const server = await createTestServer({ databasePath, llmClient: llm });

  await server.request("/api/article/default-mode/rewrite", {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({ instructions: "test" }),
  });

  const call = llm.chatCalls.find((c) => c.system.includes("Rewrite Mode"));
  assert.ok(call);
  assert.match(call.system, /expanded.*creative license|restructure sections/i, "default mode should be aggressive");
  await server.shutdown();
});

test("rewrite can include the last two edit prompts with timestamps", async (t) => {
  const { root, databasePath } = createTestDb();
  seedArticle(
    databasePath,
    "history-context",
    "History Context",
    "Lead paragraph.\n\n## Notes\n\nOriginal notes.",
  );
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const llm = new RewriteLlmClient("## Notes\n\nUpdated notes.");
  const server = await createTestServer({ databasePath, llmClient: llm });

  for (const instructions of ["first edit prompt", "second edit prompt"]) {
    const res = await server.request("/api/article/history-context/rewrite", {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ sectionId: "notes", instructions }),
    });
    assert.equal(res.status, 200);
    await res.json();
  }

  const res = await server.request("/api/article/history-context/rewrite", {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({
      sectionId: "notes",
      instructions: "third edit prompt",
      includeRecentEditHistory: true,
    }),
  });
  assert.equal(res.status, 200);
  await res.json();

  const rewritePrompt = llm.chatCalls
    .map((call) => call.user)
    .reverse()
    .find((user) => user.includes("third edit prompt"));
  assert.ok(rewritePrompt);
  assert.match(rewritePrompt, /Recent edit history, oldest to newest:/);
  assert.match(rewritePrompt, /\d{4}-\d{2}-\d{2}T.*\(section-rewrite\): first edit prompt/);
  assert.match(rewritePrompt, /\d{4}-\d{2}-\d{2}T.*\(section-rewrite\): second edit prompt/);
  assert.ok(
    rewritePrompt.indexOf("first edit prompt") < rewritePrompt.indexOf("second edit prompt"),
    "recent edit prompts should be chronological",
  );
  assert.doesNotMatch(rewritePrompt, /Initial history snapshot/);
  await server.shutdown();
});

test("post-process does not overwrite article edited after generation", async (t) => {
  const { root, databasePath } = createTestDb();
  seedArticle(
    databasePath,
    "race-test",
    "Race Test",
    '**Race Test** is about [Alpha](halu:alpha "hint"), [Beta](halu:beta "hint"), [Gamma](halu:gamma "hint"), [Delta](halu:delta "hint"), and [Epsilon](halu:epsilon "hint").',
  );
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const logEntries: CapturedLogEntry[] = [];
  const logger = createMemoryLogger(logEntries);

  const rewrittenBody = '# Race Test\n\n**Race Test** is rewritten with [Alpha](halu:alpha "hint"), [Beta](halu:beta "hint"), [Gamma](halu:gamma "hint"), [Delta](halu:delta "hint"), and [Epsilon](halu:epsilon "hint").';
  const llm = new DelayedRewriteLlmClient(rewrittenBody);
  const server = await createTestServer({ databasePath, llmClient: llm, logger });

  const res = await server.request("/api/article/race-test/rewrite?stream=1", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ instructions: "rewrite it" }),
  });
  const packets = parseNdjson<Record<string, unknown>>(await res.text());
  const done = packets.find((p) => p.type === "done");
  assert.ok(done, "rewrite should complete");

  const db = openDatabase(databasePath);
  const afterRewrite = getArticleByLookup(db, "race-test");
  assert.ok(afterRewrite);
  const rewriteTimestamp = afterRewrite.generated_at;

  const manualEdit = {
    ...afterRewrite,
    markdown: afterRewrite.markdown.replace("rewritten", "manually-edited"),
    generated_at: Date.now() + 1000,
  };
  saveArticle(db, manualEdit, [], ["race-test"], { operation: "manual-edit" });

  llm.gate.resolve();
  await new Promise((r) => setTimeout(r, 300));

  const final = getArticleByLookup(db, "race-test");
  db.close();
  assert.ok(final);
  assert.match(final.markdown, /manually-edited/, "manual edit should survive post-processing");
  assert.doesNotMatch(final.markdown, /See also/, "post-process should not have appended see-also to a stale article");

  const skipped = logEntries.filter((e) => e.event === "page.post_process_skipped");
  assert.ok(skipped.length > 0, "post-processing should be skipped for modified article");
  await server.shutdown();
});

test("rewrite returns 404 for non-existent article", async (t) => {
  const { root, databasePath } = createTestDb();
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const llm = new RewriteLlmClient("whatever");
  const server = await createTestServer({ databasePath, llmClient: llm });

  const res = await server.request("/api/article/nonexistent/rewrite", {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({ instructions: "rewrite" }),
  });
  assert.equal(res.status, 404);
  await server.shutdown();
});

test("rewrite returns 400 for missing instructions", async (t) => {
  const { root, databasePath } = createTestDb();
  seedArticle(databasePath, "no-instr", "No Instr", "Content.");
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const llm = new RewriteLlmClient("whatever");
  const server = await createTestServer({ databasePath, llmClient: llm });

  const res = await server.request("/api/article/no-instr/rewrite", {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({}),
  });
  assert.equal(res.status, 400);
  await server.shutdown();
});

test("rewrite creates a revision entry in history", async (t) => {
  const { root, databasePath } = createTestDb();
  seedArticle(databasePath, "history-test", "History Test", "Original text.");
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const llm = new RewriteLlmClient("# History Test\n\nRevised text.");
  const server = await createTestServer({ databasePath, llmClient: llm });

  await server.request("/api/article/history-test/rewrite", {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({ instructions: "revise it" }),
  });

  const historyRes = await server.request("/api/article/history-test/history");
  assert.equal(historyRes.status, 200);
  const historyBody = await historyRes.json();
  assert.ok(historyBody.revisions.length >= 2, "should have at least the seed + rewrite revisions");

  const rewriteRevision = historyBody.revisions.find(
    (r: any) => r.operation === "rewrite",
  );
  assert.ok(rewriteRevision, "should have a rewrite operation revision");
  assert.match(rewriteRevision.instructions, /revise it/, "revision should capture the instructions");
  await server.shutdown();
});

test("section rewrite only modifies the targeted section", async (t) => {
  const { root, databasePath } = createTestDb();
  const fullBody = [
    "# Section Test",
    "",
    "Lead paragraph stays.",
    "",
    "## History",
    "",
    "Old history content.",
    "",
    "## Culture",
    "",
    "Culture section stays.",
  ].join("\n");
  const db = openDatabase(databasePath);
  saveArticle(
    db,
    {
      slug: "section-test",
      canonicalSlug: "section-test",
      title: "Section Test",
      markdown: fullBody,
      html: renderMarkdown(fullBody),
      plain_text: markdownToPlainText(fullBody),
      generated_at: Date.now(),
    },
    [],
    ["section-test"],
  );
  db.close();
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const llm = new RewriteLlmClient("## History\n\nNew history content with details.");
  const server = await createTestServer({ databasePath, llmClient: llm });

  const res = await server.request("/api/article/section-test/rewrite", {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({ instructions: "expand history", sectionId: "history" }),
  });
  assert.equal(res.status, 200);
  const body = await res.json();

  assert.match(body.article.markdown, /Lead paragraph stays/, "lead should be preserved");
  assert.match(body.article.markdown, /New history content/, "history section should be updated");
  assert.match(body.article.markdown, /Culture section stays/, "culture section should be preserved");
  assert.doesNotMatch(body.article.markdown, /Old history content/, "old history should be gone");
  await server.shutdown();
});

test("rewrite with rag passes context to LLM", async (t) => {
  const { root, databasePath } = createTestDb();
  seedArticle(databasePath, "rag-test", "Rag Test", "Some content for rag test.");
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const llm = new RewriteLlmClient("# Rag Test\n\nRewritten with context.");
  const server = await createTestServer({ databasePath, llmClient: llm });

  const res = await server.request("/api/article/rag-test/rewrite", {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({
      instructions: "improve it",
      ragEnabled: true,
      ragQuery: "related topics",
    }),
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.match(body.article.markdown, /Rewritten with context/);
  await server.shutdown();
});

test("streaming rewrite emits start, progress, and done events in order", async (t) => {
  const { root, databasePath } = createTestDb();
  seedArticle(databasePath, "stream-order", "Stream Order", "Original.");
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const llm = new RewriteLlmClient("# Stream Order\n\nStreamed rewrite.");
  const server = await createTestServer({ databasePath, llmClient: llm });

  const res = await server.request("/api/article/stream-order/rewrite?stream=1", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ instructions: "rewrite" }),
  });

  const packets = parseNdjson<Record<string, unknown>>(await res.text());
  const types = packets.map((p) => p.type);

  assert.equal(types[0], "start", "first event should be start");
  assert.ok(types.includes("progress"), "should have progress events");
  assert.equal(types[types.length - 1], "done", "last event should be done");
  assert.ok(types.indexOf("start") < types.indexOf("progress"), "start before progress");
  assert.ok(types.indexOf("progress") < types.indexOf("done"), "progress before done");
  await server.shutdown();
});

test("rewrite sanitizes generated body (strips References/See also)", async (t) => {
  const { root, databasePath } = createTestDb();
  seedArticle(databasePath, "sanitize-test", "Sanitize Test", "Content.");
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const badRewrite = [
    "# Sanitize Test",
    "",
    "Good content here.",
    "",
    "## References",
    "",
    "- Some reference that should be stripped",
    "",
    "## See also",
    "",
    "- Some see also that should be stripped",
  ].join("\n");

  const llm = new RewriteLlmClient(badRewrite);
  const server = await createTestServer({ databasePath, llmClient: llm });

  const res = await server.request("/api/article/sanitize-test/rewrite", {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({ instructions: "rewrite" }),
  });

  const body = await res.json();
  assert.doesNotMatch(body.article.markdown, /Some reference that should be stripped/,
    "References section from LLM output should be stripped before save");
  assert.match(body.article.markdown, /Good content here/, "body content should survive");
  await server.shutdown();
});

test("selection edit replaces selected text in article", async (t) => {
  const { root, databasePath } = createTestDb();
  const originalBody = "The sky is blue and the grass is green. Birds sing in the morning.";
  seedArticle(databasePath, "test-sel-edit", "Test Selection Edit", originalBody);
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const llm = new RewriteLlmClient("the ocean is turquoise");

  const server = await createTestServer({ databasePath, llmClient: llm });
  const res = await server.request("/api/article/test-sel-edit/rewrite", {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({
      instructions: "make it about the ocean",
      selectedText: "The sky is blue",
    }),
  });
  assert.equal(res.status, 200);
  const body = await res.json() as any;
  assert.ok(body.article.markdown.includes("the ocean is turquoise"),
    "replacement text should be spliced in");
  assert.ok(body.article.markdown.includes("Birds sing in the morning"),
    "non-selected text should be preserved");
  assert.ok(!body.article.markdown.includes("The sky is blue"),
    "original selected text should be replaced");

  assert.ok(llm.chatCalls.length > 0, "should have called the LLM");
  const rewriteCall = llm.chatCalls.find((c) => c.system.includes("Rewrite"));
  assert.ok(rewriteCall, "should call with rewrite prompt");
  assert.ok(rewriteCall!.user.includes("The sky is blue"),
    "prompt should include selected text");
  await server.shutdown();
});

test("selection edit returns 400 when selected text not found in article", async (t) => {
  const { root, databasePath } = createTestDb();
  seedArticle(databasePath, "test-sel-miss", "Test Selection Miss", "Actual article content.");
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const llm = new RewriteLlmClient("replacement");
  const server = await createTestServer({ databasePath, llmClient: llm });
  const res = await server.request("/api/article/test-sel-miss/rewrite", {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({
      instructions: "fix it",
      selectedText: "text that does not exist in the article",
    }),
  });
  assert.equal(res.status, 422);
  const body = await res.json() as any;
  assert.ok(body.error, "should return an error message");
  assert.equal(llm.chatCalls.length, 0, "should not call LLM when selection not found");
  await server.shutdown();
});

test("selection edit streaming replaces selected text", async (t) => {
  const { root, databasePath } = createTestDb();
  const originalBody = "Alpha bravo charlie delta echo.";
  seedArticle(databasePath, "test-sel-stream", "Test Selection Stream", originalBody);
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const llm = new RewriteLlmClient("BRAVO CHARLIE");
  const server = await createTestServer({ databasePath, llmClient: llm });
  const res = await server.request("/api/article/test-sel-stream/rewrite?stream=1", {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/x-ndjson" },
    body: JSON.stringify({
      instructions: "capitalize",
      selectedText: "bravo charlie",
    }),
  });
  assert.equal(res.status, 200);
  const packets = parseNdjson<Record<string, unknown>>(await res.text());
  const done = packets.find((p) => p.type === "done") as any;
  assert.ok(done, "should get a done event");
  assert.ok(done.article.markdown.includes("BRAVO CHARLIE"),
    "streamed result should contain replacement");
  assert.ok(done.article.markdown.includes("Alpha"),
    "surrounding text should be preserved");
  assert.ok(!done.article.markdown.includes("bravo charlie"),
    "original selection should be replaced");
  await server.shutdown();
});

test("selection edit creates a revision entry", async (t) => {
  const { root, databasePath } = createTestDb();
  seedArticle(databasePath, "test-selection-revision", "Test Selection Revision", "Some old text here.");
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const llm = new RewriteLlmClient("Some new text here");
  const server = await createTestServer({ databasePath, llmClient: llm });
  const res = await server.request("/api/article/test-selection-revision/rewrite", {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({
      instructions: "update the text",
      selectedText: "old text",
    }),
  });
  assert.equal(res.status, 200);

  const historyRes = await server.request("/api/article/test-selection-revision/history");
  assert.equal(historyRes.status, 200);
  const history = await historyRes.json() as any;
  assert.ok(history.revisions.length >= 2, "should have seed + edit revisions");
  const latest = history.revisions[0];
  assert.equal(latest.operation, "selection-edit", "operation should be selection-edit");
  await server.shutdown();
});

test("post-process body updates are folded into the active rewrite revision", async (t) => {
  const { root, databasePath } = createTestDb();
  t.after(() => rmSync(root, { recursive: true, force: true }));

  seedArticle(databasePath, "ref-article", "Ref Article", "Reference source content.");
  seedArticle(databasePath, "target-article", "Target Article", "Original target body.");

  const rewrittenMarkdown = [
    "# Target Article",
    "",
    'Target Article cites [Ref Article](halu:ref-article "reference context").',
  ].join("\n");
  const llm = new RewriteLlmClient(rewrittenMarkdown);
  const server = await createTestServer({ databasePath, llmClient: llm });

  const res = await server.request("/api/article/target-article/rewrite", {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({ instructions: "refresh the body" }),
  });
  assert.equal(res.status, 200);
  await server.shutdown();

  const db = openDatabase(databasePath);
  const saved = getArticleByLookup(db, "target-article");
  const revisions = listArticleRevisions(db, "target-article");
  db.close();
  assert.ok(saved, "article should exist in DB");
  assert.match(saved.markdown, /\[Ref Article\]\(ref:ref-article\)/);
  assert.match(revisions[0].markdown, /\[Ref Article\]\(ref:ref-article\)/);
  assert.deepEqual(
    revisions.map((revision) => revision.operation),
    ["rewrite", "update"],
  );
});

test("refresh-context converts existing article links into footnote references", async (t) => {
  const { root, databasePath } = createTestDb();
  t.after(() => rmSync(root, { recursive: true, force: true }));

  seedArticle(databasePath, "source-article", "Source Article", "Reference source content.");
  const generatedBody = 'Generated body cites [Source Article](halu:source-article "source context").';
  seedArticle(databasePath, "generated-article", "Generated Article", generatedBody);

  // LLM returns the same body — refresh always runs LLM but when the content is
  // unchanged the normalization pipeline still converts halu links to ref links.
  const fullOriginalMarkdown = `# Generated Article\n\n${generatedBody}`;
  const llm = new RewriteLlmClient(fullOriginalMarkdown);
  const server = await createTestServer({ databasePath, llmClient: llm });

  const res = await server.request("/api/article/generated-article/refresh-context", {
    method: "POST",
  });
  assert.equal(res.status, 200);
  const body = await res.json() as any;
  assert.match(body.article.body, /\[Source Article\]\(ref:source-article\)/);
  assert.doesNotMatch(body.article.html, /class="ref-link"/);
  assert.doesNotMatch(body.article.html, /class="ref-num"/);
  assert.match(body.article.html, /<section class="article-references">/);
  assert.match(body.article.html, /<ol>/);
  assert.doesNotMatch(body.article.html, /<h2>References<\/h2><ul>/);
  assert.deepEqual(body.referenceStatus.missing, []);
  assert.deepEqual(body.referenceStatus.unformatted, []);

  const db = openDatabase(databasePath);
  const saved = getArticleByLookup(db, "generated-article");
  db.close();
  assert.ok(saved, "article should exist in DB");
  assert.match(saved.markdown, /\[Source Article\]\(ref:source-article\)/);
  assert.doesNotMatch(saved.markdown, /\(halu:source-article/);
  await server.shutdown();
});

test("refresh-context streams and cleans dangling inline reference markers", async (t) => {
  const { root, databasePath } = createTestDb();
  t.after(() => rmSync(root, { recursive: true, force: true }));

  seedArticle(databasePath, "individual-entropy", "Individual Entropy", "Reference source content.");
  seedArticle(databasePath, "the-communist-manifesto", "The Communist Manifesto", "Reference source content.");
  const generatedBody2 = [
    "Individual entropy rises quickly (ref:individual-entropy).",
    'The handbook is *The Communist Manifesto*halu:the-communist-manifesto "a handbook entry".',
  ].join("\n\n");
  seedArticle(databasePath, "generated-article", "Generated Article", generatedBody2);

  // LLM returns the same body — the normalization pipeline then cleans the dangling markers.
  const llm = new RewriteLlmClient(`# Generated Article\n\n${generatedBody2}`);
  const server = await createTestServer({ databasePath, llmClient: llm });

  const res = await server.request("/api/article/generated-article/refresh-context?stream=1", {
    method: "POST",
    headers: { accept: "application/x-ndjson" },
  });
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type") ?? "", /application\/x-ndjson/);
  const events = await readNdjson(res);
  assert.equal(events[0].type, "start");
  assert.ok(events.some((event) => event.type === "status"));
  const done = events.find((event) => event.type === "done");
  assert.ok(done, "stream should finish with done event");
  assert.match(done.article.body, /\[Individual entropy\]\(ref:individual-entropy\) rises quickly\./);
  assert.match(
    done.article.body,
    /\*\[The Communist Manifesto\]\(ref:the-communist-manifesto\)\*/,
  );
  assert.doesNotMatch(done.article.body, / \((?:ref|halu):individual-entropy\)/);
  assert.doesNotMatch(done.article.body, /Manifesto\*halu:/);

  const db = openDatabase(databasePath);
  const saved = getArticleByLookup(db, "generated-article");
  db.close();
  assert.ok(saved, "article should exist in DB");
  assert.match(saved.markdown, /\[Individual entropy\]\(ref:individual-entropy\)/);
  assert.doesNotMatch(saved.markdown, /halu:the-communist-manifesto/);
  await server.shutdown();
});

test("refresh-context streams exactly one persisted revision without post-process feedback", async (t) => {
  const { root, databasePath } = createTestDb();
  t.after(() => rmSync(root, { recursive: true, force: true }));

  seedArticle(databasePath, "generated-article", "Generated Article", "Original body.");
  const db = openDatabase(databasePath);
  saveArticle(
    db,
    {
      slug: "source-article",
      canonicalSlug: "source-article",
      title: "Source Article",
      markdown: "# Source Article\n\nReference source content.",
      html: renderMarkdown("# Source Article\n\nReference source content."),
      plain_text: markdownToPlainText("# Source Article\n\nReference source content."),
      generated_at: Date.now(),
    },
    [{ targetSlug: "generated-article", visibleLabel: "Generated Article", hiddenHint: "source context" }],
    ["source-article"],
  );
  db.close();

  const rewrittenMarkdown = [
    "# Generated Article",
    "",
    'Generated Article now cites [Source Article](halu:source-article "source context").',
  ].join("\n");
  const llm = new RewriteLlmClient(rewrittenMarkdown);
  const server = await createTestServer({ databasePath, llmClient: llm });

  const res = await server.request("/api/article/generated-article/refresh-context?stream=1", {
    method: "POST",
    headers: { accept: "application/x-ndjson" },
  });
  assert.equal(res.status, 200);
  const events = await readNdjson(res);
  const types = events.map((event) => event.type);
  assert.ok(types.includes("progress"), "refresh rewrite should emit progress events");
  assert.ok(types.indexOf("progress") < types.indexOf("done"), "progress before done");
  const done = events.find((event) => event.type === "done");
  assert.ok(done, "stream should finish with done event");

  const checkDb = openDatabase(databasePath);
  const revisions = listArticleRevisions(checkDb, "generated-article");
  checkDb.close();
  assert.deepEqual(
    revisions.map((revision) => revision.operation),
    ["refresh-context-rewrite", "update"],
  );
  assert.equal(llm.chatCalls.length, 1, "refresh should not invoke link recheck or post-process LLM passes");
  await server.shutdown();
});

/* ─────────────────────────────────────────────────────────────────
   find-references endpoint
   ───────────────────────────────────────────────────────────────── */

test("find-references: fuzzy title lookup returns matching articles", async (t) => {
  const { root, databasePath } = createTestDb();
  t.after(() => rmSync(root, { recursive: true, force: true }));

  // Seed two articles that can be found by fuzzy match
  seedArticle(databasePath, "glow-fruit", "Glow Fruit", "A luminous orchard product.");
  seedArticle(databasePath, "night-bloom", "Night Bloom", "Blooms at dusk.");
  seedArticle(databasePath, "main-article", "Main Article", "The article being edited.");

  const llm = new RewriteLlmClient("# Main Article\n\nUpdated body.");
  const server = await createTestServer({ databasePath, llmClient: llm });
  t.after(() => server.shutdown());

  const res = await server.request("/api/article/main-article/find-references", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ fuzzyTitles: "Glow Fruit, Night Bloom" }),
  });

  assert.equal(res.status, 200, `expected 200 got ${res.status}`);
  const body = await res.json() as { articles: Array<{ slug: string; title: string }> };
  assert.ok(Array.isArray(body.articles));
  // Both articles should be found
  assert.ok(body.articles.some((a) => a.slug === "glow-fruit"), "should find Glow Fruit");
  assert.ok(body.articles.some((a) => a.slug === "night-bloom"), "should find Night Bloom");
});

test("find-references: wiki path in fuzzy list is resolved", async (t) => {
  const { root, databasePath } = createTestDb();
  t.after(() => rmSync(root, { recursive: true, force: true }));

  seedArticle(databasePath, "glow-fruit", "Glow Fruit", "A luminous orchard product.");
  seedArticle(databasePath, "main-article", "Main Article", "The article being edited.");

  const llm = new RewriteLlmClient("# Main Article\n\nUpdated.");
  const server = await createTestServer({ databasePath, llmClient: llm });
  t.after(() => server.shutdown());

  // Wiki-path input should resolve via existing parsing logic
  const res = await server.request("/api/article/main-article/find-references", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ fuzzyTitles: "wiki/Glow_Fruit" }),
  });

  assert.equal(res.status, 200);
  const body = await res.json() as { articles: Array<{ slug: string }> };
  assert.ok(body.articles.some((a) => a.slug === "glow-fruit"), "wiki path should resolve to article");
});

test("find-references: returns 404 for unknown article slug", async (t) => {
  const { root, databasePath } = createTestDb();
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const server = await createTestServer({ databasePath });
  t.after(() => server.shutdown());

  const res = await server.request("/api/article/nonexistent/find-references", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ fuzzyTitles: "anything" }),
  });
  assert.equal(res.status, 404);
});

/* ─────────────────────────────────────────────────────────────────
   rewrite with explicit referenceSlugs
   ───────────────────────────────────────────────────────────────── */

test("rewrite with explicit referenceSlugs passes them as context", async (t) => {
  const { root, databasePath } = createTestDb();
  t.after(() => rmSync(root, { recursive: true, force: true }));

  seedArticle(databasePath, "ref-article", "Ref Article", "Reference content here.");
  seedArticle(databasePath, "target", "Target", "Original content.");

  // Capture what the LLM receives so we can verify reference context is present
  let capturedUser = "";
  const llm: LlmClient = {
    async chat() { return "{}"; },
    async streamChat(_s: string, user: string, onChunk: (d: string, a: string) => void) {
      capturedUser = user;
      const content = "# Target\n\nRewritten with context.";
      onChunk(content, content);
      return { content, finishReason: "stop" };
    },
    async embed() { return []; },
    async probeConnections() {},
  };

  const server = await createTestServer({ databasePath, llmClient: llm });
  t.after(() => server.shutdown());

  const res = await server.request("/api/article/target/rewrite?stream=1", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      instructions: "improve it",
      referenceSlugs: ["ref-article"],
    }),
  });

  assert.equal(res.status, 200);
  const packets = parseNdjson<Record<string, unknown>>(await res.text());
  const done = packets.find((p) => p.type === "done");
  assert.ok(done, "should get done event");
  // The LLM prompt should contain context from the referenced article
  assert.match(capturedUser, /Reference content here/, "referenced article content should be in prompt");
});
