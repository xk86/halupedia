import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { getTraceRecorder, closeTraceRecorder } from "../src/server/pipeline/runtime/trace";
import { beginAgentRun } from "../src/server/agent/trace";

function tmpDbPath(t: { after: (fn: () => void) => void }): string {
  const dir = mkdtempSync(join(tmpdir(), "halu-agent-trace-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return join(dir, "traces.sqlite");
}

test("beginAgentRun writes a pipeline_runs row and one pipeline_nodes row per LLM turn", (t) => {
  const dbPath = tmpDbPath(t);
  const recorder = getTraceRecorder({
    enabled: true,
    database_path: dbPath,
    level: "trace",
    retention_days: 1,
  });

  const handle = beginAgentRun({
    recorder,
    workflow: "agent.chat",
    requestId: "req-1",
    slug: "solana",
    origin: "http",
  });
  handle.onLlmCall({
    role: "heavy",
    system: "You are a research assistant.",
    user: "What is Solana?",
    response: '{"thought":"searching","action":{"tool":"research","args":{"query":"solana"}}}',
    durationMs: 42,
  });
  handle.onLlmCall({
    role: "heavy",
    system: "You are a research assistant.",
    user: "Tool result: ...",
    response: '{"thought":"done","final":"Solana is a blockchain."}',
    durationMs: 17,
  });
  handle.finish("ok");
  closeTraceRecorder();

  const db = new DatabaseSync(dbPath, { readOnly: true });
  const run = db
    .prepare("SELECT * FROM pipeline_runs WHERE run_id = ?")
    .get(handle.runId) as Record<string, unknown> | undefined;
  assert.ok(run, "run row should exist");
  assert.equal(run?.workflow, "agent.chat");
  assert.equal(run?.slug, "solana");
  assert.equal(run?.status, "ok");
  assert.equal(run?.nodes_executed, 2);

  const nodes = db
    .prepare("SELECT * FROM pipeline_nodes WHERE run_id = ? ORDER BY id ASC")
    .all(handle.runId) as Array<Record<string, unknown>>;
  assert.equal(nodes.length, 2);
  assert.equal(nodes[0].node_name, "agent.chat.turn_1");
  assert.match(nodes[0].prompt_text as string, /You are a research assistant\./);
  assert.match(nodes[0].response_text as string, /searching/);
  assert.equal(nodes[1].node_name, "agent.chat.turn_2");
  assert.match(nodes[1].response_text as string, /Solana is a blockchain\./);
  db.close();
});

test("a spawned research run links to its parent chat run", (t) => {
  const dbPath = tmpDbPath(t);
  const recorder = getTraceRecorder({
    enabled: true,
    database_path: dbPath,
    level: "trace",
    retention_days: 1,
  });

  const parent = beginAgentRun({
    recorder,
    workflow: "agent.chat",
    requestId: "req-2",
    origin: "http",
  });
  const child = beginAgentRun({
    recorder,
    workflow: "agent.research",
    requestId: "req-2",
    parentRunId: parent.runId,
    origin: "agent_tool",
  });
  child.onLlmCall({ role: "light", system: "sys", user: "usr", response: "ok", durationMs: 5 });
  child.finish("ok");
  parent.finish("ok");
  closeTraceRecorder();

  const db = new DatabaseSync(dbPath, { readOnly: true });
  const childRow = db
    .prepare("SELECT * FROM pipeline_runs WHERE run_id = ?")
    .get(child.runId) as Record<string, unknown> | undefined;
  assert.equal(childRow?.parent_run_id, parent.runId);
  assert.equal(childRow?.origin, "agent_tool");
  db.close();
});

test("finish(\"error\") records the failure on the run row", (t) => {
  const dbPath = tmpDbPath(t);
  const recorder = getTraceRecorder({
    enabled: true,
    database_path: dbPath,
    level: "trace",
    retention_days: 1,
  });
  const handle = beginAgentRun({ recorder, workflow: "agent.research", requestId: "req-3" });
  handle.finish("error", new Error("boom"));
  closeTraceRecorder();

  const db = new DatabaseSync(dbPath, { readOnly: true });
  const run = db
    .prepare("SELECT * FROM pipeline_runs WHERE run_id = ?")
    .get(handle.runId) as Record<string, unknown> | undefined;
  assert.equal(run?.status, "error");
  assert.equal(run?.error_message, "boom");
  db.close();
});
