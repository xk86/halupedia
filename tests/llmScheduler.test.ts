import test from "node:test";
import assert from "node:assert/strict";

import { HostScheduler } from "../src/server/llm";
import type { Logger } from "../src/server/logger";
import type { HostConfig } from "../src/server/types";

const noop: Logger = { debug() {}, info() {}, warn() {}, error() {} };

const host = (id: string, pref: number, max = 1, blacklist: string[] = []): HostConfig => ({
  id,
  base_url: `http://${id}/v1`,
  api_key: "k",
  max_in_flight: max,
  pref,
  blacklist,
});

const tick = () => new Promise((r) => setImmediate(r));

test("candidates: role-preferred first, then by ascending pref", () => {
  const s = new HostScheduler(noop);
  s.configure([host("a", 1), host("b", 0), host("c", 2)]);
  for (const id of ["a", "b", "c"]) s.setCapabilities(id, new Set(["m"]));
  assert.deepEqual(s.candidates(["a"], "m"), ["a", "b", "c"]);
  assert.deepEqual(s.candidates([], "m"), ["b", "a", "c"]);
});

test("candidates: blacklisted model excludes a host", () => {
  const s = new HostScheduler(noop);
  s.configure([host("a", 1), host("b", 0, 1, ["m"])]);
  s.setCapabilities("a", new Set(["m"]));
  s.setCapabilities("b", new Set(["m"]));
  assert.deepEqual(s.candidates([], "m"), ["a"]);
});

test("candidates: tolerates Ollama's implicit :latest tag", () => {
  const s = new HostScheduler(noop);
  s.configure([host("a", 0), host("b", 1)]);
  s.setCapabilities("a", new Set(["gemma4:latest"])); // config asks for "gemma4"
  s.setCapabilities("b", new Set(["gemma4"])); // config asks for "gemma4:latest"
  assert.deepEqual(s.candidates([], "gemma4"), ["a", "b"]);
  assert.deepEqual(s.candidates([], "gemma4:latest"), ["a", "b"]);
});

test("candidates: unknown (unprobed) capabilities are assumed usable", () => {
  const s = new HostScheduler(noop);
  s.configure([host("a", 0)]); // no setCapabilities -> models null
  assert.deepEqual(s.candidates([], "anything"), ["a"]);
});

test("dispatch spills to a fallback host when the preferred one is saturated", async () => {
  const s = new HostScheduler(noop);
  s.configure([host("a", 0, 1), host("b", 1, 1)]);
  s.setCapabilities("a", new Set(["m"]));
  s.setCapabilities("b", new Set(["m"]));

  let releaseA = () => {};
  const hold = new Promise<void>((r) => (releaseA = r));
  const p1 = s.dispatch("r", ["a"], "m", async (ep) => {
    assert.equal(ep.hostId, "a");
    await hold;
    return "a";
  });
  const p2 = s.dispatch("r", ["a"], "m", async (ep) => {
    assert.equal(ep.hostId, "b");
    return "b";
  });
  assert.equal(await p2, "b");
  releaseA();
  assert.equal(await p1, "a");
});

test("dispatch waits indefinitely, then is admitted when a slot frees", async () => {
  const s = new HostScheduler(noop);
  s.configure([host("a", 0, 1)]);
  s.setCapabilities("a", new Set(["m"]));

  let releaseA = () => {};
  const hold = new Promise<void>((r) => (releaseA = r));
  const p1 = s.dispatch("r", ["a"], "m", async () => {
    await hold;
    return 1;
  });
  let p2done = false;
  const p2 = s.dispatch("r", ["a"], "m", async () => 2).then((v) => {
    p2done = true;
    return v;
  });
  await tick();
  assert.equal(p2done, false); // parked, no host free
  releaseA();
  assert.equal(await p2, 2);
  assert.equal(await p1, 1);
});

test("dispatch re-queues to the next host on failure", async () => {
  const s = new HostScheduler(noop);
  s.configure([host("a", 0, 1), host("b", 1, 1)]);
  s.setCapabilities("a", new Set(["m"]));
  s.setCapabilities("b", new Set(["m"]));

  const seen: string[] = [];
  const res = await s.dispatch("r", ["a"], "m", async (ep) => {
    seen.push(ep.hostId);
    if (ep.hostId === "a") throw new Error("boom");
    return "ok";
  });
  assert.deepEqual(seen, ["a", "b"]);
  assert.equal(res, "ok");
});

test("dispatch does not fail over when the error is marked noFailover", async () => {
  const s = new HostScheduler(noop);
  s.configure([host("a", 0, 1), host("b", 1, 1)]);
  s.setCapabilities("a", new Set(["m"]));
  s.setCapabilities("b", new Set(["m"]));
  await assert.rejects(
    s.dispatch("r", ["a"], "m", async () => {
      const e = new Error("midstream") as Error & { noFailover?: boolean };
      e.noFailover = true;
      throw e;
    }),
    /midstream/,
  );
});

test("dispatch rejects when no host can serve the model", async () => {
  const s = new HostScheduler(noop);
  s.configure([host("a", 0)]);
  s.setCapabilities("a", new Set(["other"]));
  await assert.rejects(s.dispatch("r", ["a"], "m", async () => 1), /no configured host/);
});

test("configure can raise queue depth live and admit a parked waiter", async () => {
  const s = new HostScheduler(noop);
  s.configure([host("a", 0, 1)]);
  s.setCapabilities("a", new Set(["m"]));

  let releaseA = () => {};
  const hold = new Promise<void>((r) => (releaseA = r));
  const p1 = s.dispatch("r", ["a"], "m", async () => {
    await hold;
    return 1;
  });
  let p2done = false;
  const p2 = s.dispatch("r", ["a"], "m", async () => 2).then((v) => {
    p2done = true;
    return v;
  });
  await tick();
  assert.equal(p2done, false);
  // bump max_in_flight 1 -> 2; the parked request should be admitted immediately
  s.configure([host("a", 0, 2)]);
  assert.equal(await p2, 2);
  releaseA();
  assert.equal(await p1, 1);
});
