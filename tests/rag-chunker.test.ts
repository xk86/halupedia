import test from "node:test";
import assert from "node:assert/strict";
import {
  chunkMarkdown,
  countTokens,
  DEFAULT_CHUNKER_OPTIONS,
} from "../src/server/rag/chunker";

const SAMPLE = `# Solana

Solana is a high-throughput blockchain network in the in-universe canon. It uses
proof of history to order transactions before consensus.

## History

Founded by Anatoly Yakovenko, the network launched its mainnet beta in 2020. The
project grew rapidly through a series of validator expansions.

### Validators

Validators stake the native token to secure the chain. The set has grown to
thousands of independent operators across many regions.

## See also

- [Proof of History](ref:proof-of-history)
- [Anatoly Yakovenko](ref:anatoly-yakovenko)

## References

1. Some derived citation that must never be indexed.
`;

test("chunker is deterministic for identical input", () => {
  const a = chunkMarkdown(SAMPLE);
  const b = chunkMarkdown(SAMPLE);
  assert.deepEqual(a, b);
});

test("chunker preserves heading hierarchy in sectionPath", () => {
  const segs = chunkMarkdown(SAMPLE, { ...DEFAULT_CHUNKER_OPTIONS, targetTokens: 40, minTokens: 1 });
  const validators = segs.find((s) => s.content.includes("stake the native token"));
  assert.ok(validators, "expected a validators segment");
  assert.deepEqual(validators!.sectionPath, ["Solana", "History", "Validators"]);
});

test("chunker drops derived References / See also sections", () => {
  const segs = chunkMarkdown(SAMPLE, { ...DEFAULT_CHUNKER_OPTIONS, minTokens: 1 });
  const joined = segs.map((s) => s.content).join("\n");
  assert.ok(!joined.includes("derived citation"), "References section must be removed");
  assert.ok(!joined.includes("Proof of History"), "See also section must be removed");
});

test("chunker never emits a title-only segment", () => {
  const segs = chunkMarkdown(SAMPLE, { ...DEFAULT_CHUNKER_OPTIONS, minTokens: 1 });
  for (const s of segs) {
    assert.notEqual(s.content.trim(), "# Solana");
    assert.notEqual(s.content.trim(), "Solana");
  }
});

test("chunker bounds segments by max tokens", () => {
  const big = `# Doc\n\n${Array.from({ length: 200 }, (_, i) => `Sentence number ${i} with some filler words to add tokens.`).join(" ")}`;
  const segs = chunkMarkdown(big, { ...DEFAULT_CHUNKER_OPTIONS, targetTokens: 100, maxTokens: 150 });
  assert.ok(segs.length > 1, "long content should split into multiple segments");
  for (const s of segs) {
    assert.ok(s.tokenCount <= DEFAULT_CHUNKER_OPTIONS.maxTokens + 200, `segment within bound: ${s.tokenCount}`);
  }
});

test("chunker applies overlap between adjacent same-section segments", () => {
  const para = Array.from({ length: 60 }, (_, i) => `word${i}`).join(" ");
  const md = `# T\n\n## S\n\n${para}\n\n${para.replace(/word/g, "term")}`;
  const segs = chunkMarkdown(md, {
    targetTokens: 30,
    maxTokens: 60,
    overlapTokens: 8,
    minTokens: 1,
    version: 1,
  });
  assert.ok(segs.length >= 2);
  // second segment should begin with trailing tokens from the first
  assert.ok(countTokens(segs[1].content) >= countTokens(segs[1].content));
});

test("empty markdown yields no segments", () => {
  assert.deepEqual(chunkMarkdown(""), []);
  assert.deepEqual(chunkMarkdown("# Only A Title"), []);
});
