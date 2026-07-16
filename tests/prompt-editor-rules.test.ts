import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import { readPromptFile, writePromptFile } from "../src/server/promptEditor";

// promptEditor.ts resolves config/prompts relative to process.cwd() captured
// at import time, so these tests write a real (throwaway) file under the
// actual config/prompts/ directory rather than chdir'ing into a temp dir.
const TEST_KEY = "__test_prompt_editor_rules__";
const TEST_PATH = resolve(process.cwd(), "config", "prompts", `${TEST_KEY}.toml`);

function cleanup() {
  if (existsSync(TEST_PATH)) rmSync(TEST_PATH);
}

test("readPromptFile parses rules and local_rule; writePromptFile round-trips a rules edit", (t) => {
  t.after(cleanup);
  writeFileSync(
    TEST_PATH,
    `system = """{{rules}}"""\nuser = """u"""\n\n[rules]\ninclude = ["tone"]\n\n[[local_rule]]\nid = "x"\ntier = 2\ntext = "Do the thing."\n`,
  );

  const before = readPromptFile("runnable", TEST_KEY);
  assert.deepEqual(before?.rules, { include: ["tone"] });
  assert.deepEqual(before?.localRules, [{ id: "x", tier: 2, text: "Do the thing." }]);

  const err = writePromptFile("runnable", TEST_KEY, "{{rules}}", "u", {
    include: ["tone", "canon"],
    exclude: ["tone/no_whimsy"],
  });
  assert.equal(err, null);

  const after = readPromptFile("runnable", TEST_KEY);
  assert.deepEqual(after?.rules, { include: ["tone", "canon"], exclude: ["tone/no_whimsy"] });
  // local_rule is untouched by a rules-only write.
  assert.deepEqual(after?.localRules, [{ id: "x", tier: 2, text: "Do the thing." }]);
});

test("writePromptFile removes exclude when omitted on a later save", (t) => {
  t.after(cleanup);
  writeFileSync(
    TEST_PATH,
    `system = """s"""\nuser = """u"""\n\n[rules]\ninclude = ["tone"]\nexclude = ["tone/no_whimsy"]\n`,
  );

  const err = writePromptFile("runnable", TEST_KEY, "s", "u", { include: ["tone"] });
  assert.equal(err, null);

  const after = readPromptFile("runnable", TEST_KEY);
  assert.deepEqual(after?.rules, { include: ["tone"] });
});
