import test from "node:test";
import assert from "node:assert/strict";
import { parse } from "smol-toml";

import { setTomlTableValue, removeTomlTableKey, addTomlTable, replaceTomlArrayTables, tomlRender } from "../src/server/tomlEdit";

const SAMPLE = `# Gemma models require temperature of 1
[llm.host.cat-desktop]
base_url = "http://cat-desktop:11434/v1"
api_key = "ollama"
max_in_flight = 4
pref = 0

#[llm.host.madison-sylveon]
#base_url = "http://madison-sylveon:11434/v1"

[llm.chat]
hosts = ["cat-desktop"]
#model = "gemma3:4b-it-qat"
model = "gemma4"
temperature = 1
`;

test("tomlRender renders scalars and arrays", () => {
  assert.equal(tomlRender("a"), '"a"');
  assert.equal(tomlRender(4), "4");
  assert.equal(tomlRender(true), "true");
  assert.equal(tomlRender(["a", "b"]), '["a", "b"]');
});

test("setTomlTableValue replaces a value in place and preserves comments", () => {
  const next = setTomlTableValue(SAMPLE, "llm.chat", "model", "gemma4:e2b");
  // the active model line changed
  assert.match(next, /^model = "gemma4:e2b"$/m);
  // the operator's comments + commented-out alternates all survive
  assert.match(next, /# Gemma models require temperature of 1/);
  assert.match(next, /#model = "gemma3:4b-it-qat"/);
  assert.match(next, /#\[llm\.host\.madison-sylveon\]/);
  // and only the [llm.chat] model changed — host table untouched
  const parsed = parse(next) as any;
  assert.equal(parsed.llm.chat.model, "gemma4:e2b");
  assert.equal(parsed.llm.host["cat-desktop"].base_url, "http://cat-desktop:11434/v1");
});

test("setTomlTableValue writes array values", () => {
  const next = setTomlTableValue(SAMPLE, "llm.chat", "hosts", ["cat-desktop", "localhost"]);
  const parsed = parse(next) as any;
  assert.deepEqual(parsed.llm.chat.hosts, ["cat-desktop", "localhost"]);
});

test("setTomlTableValue inserts a missing key after the header", () => {
  const next = setTomlTableValue(SAMPLE, "llm.chat", "max_tokens", 9001);
  const parsed = parse(next) as any;
  assert.equal(parsed.llm.chat.max_tokens, 9001);
  // existing keys still present
  assert.equal(parsed.llm.chat.model, "gemma4");
});

test("setTomlTableValue appends a new table when absent", () => {
  const next = setTomlTableValue(SAMPLE, "llm.embeddings", "enabled", true);
  const parsed = parse(next) as any;
  assert.equal(parsed.llm.embeddings.enabled, true);
});

test("removeTomlTableKey removes only the active key", () => {
  const withContext = setTomlTableValue(SAMPLE, "llm.chat", "num_ctx", 32768);
  const next = removeTomlTableKey(withContext, "llm.chat", "num_ctx");
  const parsed = parse(next) as any;
  assert.equal(parsed.llm.chat.num_ctx, undefined);
  assert.match(next, /#model = "gemma3:4b-it-qat"/);
});

test("addTomlTable appends a host block, preserving the rest", () => {
  const next = addTomlTable(SAMPLE, "llm.host.host-b", {
    base_url: "http://host-b:11434/v1",
    api_key: "ollama",
    max_in_flight: 2,
    pref: 1,
    blacklist: ["gemma4"],
  });
  const parsed = parse(next) as any;
  assert.equal(parsed.llm.host["host-b"].base_url, "http://host-b:11434/v1");
  assert.deepEqual(parsed.llm.host["host-b"].blacklist, ["gemma4"]);
  // original host + comments intact
  assert.equal(parsed.llm.host["cat-desktop"].pref, 0);
  assert.match(next, /#model = "gemma3:4b-it-qat"/);
});

test("replaceTomlArrayTables replaces parent and nested child blocks", () => {
  const source = `title = "kept"\n\n[[local_rule]]\nid = "old"\n\n[[local_rule.examples]]\ndescription = "old"\ntext = "old"\n\n[other]\nenabled = true\n`;
  const next = replaceTomlArrayTables(source, "local_rule", [
    `[[local_rule]]\nid = "new"\ntier = 2\ntext = "new"`,
  ]);
  const parsed = parse(next) as any;
  assert.equal(parsed.title, "kept");
  assert.equal(parsed.other.enabled, true);
  assert.deepEqual(parsed.local_rule, [{ id: "new", tier: 2, text: "new" }]);
  assert.doesNotMatch(next, /description = "old"/);
});
