import test from "node:test";
import assert from "node:assert/strict";

import { OPTIONAL_OLLAMA_PARAMETER_KEYS } from "../src/ollamaOptions";
import { withLlmDefaults } from "../src/server/config";

test("optional Ollama parameter allowlist covers supported numeric options only", () => {
  assert.deepEqual(OPTIONAL_OLLAMA_PARAMETER_KEYS, [
    "num_ctx",
    "repeat_last_n",
    "repeat_penalty",
    "seed",
    "draft_num_predict",
    "top_k",
    "top_p",
    "min_p",
  ]);
  assert.equal(OPTIONAL_OLLAMA_PARAMETER_KEYS.includes("stop" as never), false);
});

test("LLM config accepts num_predict and inherits explicitly configured options", () => {
  const llm = withLlmDefaults({
    chat: {
      model: "test-model",
      num_predict: 1234,
      repeat_last_n: 64,
      repeat_penalty: 1.1,
      seed: 42,
      draft_num_predict: 4,
    },
  });

  assert.equal(llm.chat.max_tokens, 1234);
  assert.equal(llm.light.max_tokens, 1234);
  assert.equal(llm.light.repeat_last_n, 64);
  assert.equal(llm.light.repeat_penalty, 1.1);
  assert.equal(llm.light.seed, 42);
  assert.equal(llm.light.draft_num_predict, 4);
  assert.equal(llm.chat.num_ctx, undefined);
});
