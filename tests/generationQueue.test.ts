import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/server/index";
import { loadConfig } from "../src/server/config";
import type { LlmRouter } from "../src/server/llm";

const TEST_CONFIG = loadConfig().app.tests;

class GatedLlmClient implements LlmRouter {
  streamCallCount = 0;
  readonly generationStarted = Promise.withResolvers<void>();
  readonly gate = Promise.withResolvers<void>();

  async chat(): Promise<string> {
    return JSON.stringify({ items: [] });
  }

  async streamChat(
    _role: "heavy" | "light",
    _system: string,
    _user: string,
    onChunk: (delta: string, accumulated: string) => void,
    options?: {
      onReasoningDelta?: (delta: string, accumulated: string) => void;
    },
  ): Promise<{ content: string; finishReason: string }> {
    this.streamCallCount++;
    this.generationStarted.resolve();
    options?.onReasoningDelta?.("Inspecting context.", "Inspecting context.");
    onChunk("# Gated", "# Gated");
    await this.gate.promise;
    const content = [
      "# Gated Article\n\n",
      '**Gated Article** is an entry with [Alpha](halu:alpha "Alpha hint"), ',
      '[Beta](halu:beta "Beta hint"), [Gamma](halu:gamma "Gamma hint"), ',
      '[Delta](halu:delta "Delta hint"), and [Epsilon](halu:epsilon "Epsilon hint").',
    ].join("");
    onChunk(content, content);
    return { content, finishReason: "stop" };
  }

  async embed(): Promise<number[][]> {
    return [];
  }

  async probeConnections(): Promise<void> {}
}

test("article generation queue waits before starting additional LLM work", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "halupedia-generation-queue-"));
  const databasePath = join(root, TEST_CONFIG.database_path);
  const llm = new GatedLlmClient();
  const { app, shutdown } = await createApp({
    databasePath,
    skipLlmProbe: true,
    skipHomepagePrepare: true,
    llmClient: llm,
  });
  const request = (path: string) => app.fetch(new Request(`http://halupedia.test${path}`));
  t.after(async () => {
    llm.gate.resolve();
    await shutdown();
    rmSync(root, { recursive: true, force: true });
  });

  const req1 = request("/api/page/First_Queued_Article");
  await llm.generationStarted.promise;
  assert.equal(llm.streamCallCount, 1);

  const req2 = request("/api/page/Second_Queued_Article");
  await new Promise((r) => setTimeout(r, 50));

  const queueRes = await request("/api/admin/generation-queue");
  assert.equal(queueRes.status, 200);
  const queue = (await queueRes.json()) as any;
  assert.equal(queue.maxInFlight, 1);
  assert.equal(queue.active, 1);
  assert.equal(queue.queued, 1);
  assert.equal(queue.items.length, 2);

  const first = queue.items.find((item: any) => item.slug === "first-queued-article");
  const second = queue.items.find((item: any) => item.slug === "second-queued-article");
  assert.equal(first.state, "llm");
  assert.equal(first.views[0].node, "llm.generate_article");
  assert.equal(first.views[0].reasoning, "Inspecting context.");
  assert.equal(first.views[0].response, "# Gated");
  assert.equal(typeof first.startedAt, "number");
  assert.ok(first.activeMs >= 0);
  assert.equal(second.state, "queued");
  assert.equal(second.startedAt, undefined);
  assert.ok(second.queuedMs >= 0);
  assert.equal(llm.streamCallCount, 1);

  llm.gate.resolve();
  await Promise.all([req1.then((res) => res.text()), req2.then((res) => res.text())]);
  assert.ok(llm.streamCallCount >= 2);
});
