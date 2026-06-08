/**
 * Generate a slug-friendly emoji name lookup table from CLDR annotations.
 *
 * Slugs stay plain-alpha (no raw unicode/emoji) — but rather than just
 * dropping emoji and risking collisions ("Banana 🍌" and "Banana 🍍" both
 * reducing to "banana"), this extracts each emoji's short English
 * text-to-speech name ("🍌" -> "banana") from CLDR so slugify() can fold it
 * into the slug as a normal word. Titles keep the actual emoji untouched —
 * this table is for slugs only.
 *
 * Usage: node --import tsx/esm scripts/generate-emoji-names.ts
 */

import { writeFileSync } from "node:fs";
import { resolve } from "node:path";

const CLDR_URL = "https://raw.githubusercontent.com/unicode-org/cldr/main/common/annotations/en.xml";
const OUTPUT_PATH = resolve(import.meta.dirname, "../src/server/text/emojiNames.generated.json");

async function main() {
  console.log(`Fetching ${CLDR_URL}`);
  const res = await fetch(CLDR_URL);
  if (!res.ok) throw new Error(`fetch failed: ${res.status} ${res.statusText}`);
  const xml = await res.text();

  // <annotation cp="🍌" type="tts">banana</annotation>
  const ttsRegex = /<annotation cp="([^"]+)" type="tts">([^<]+)<\/annotation>/g;
  const table: Record<string, string> = {};
  let match: RegExpExecArray | null;
  while ((match = ttsRegex.exec(xml))) {
    const [, cp, name] = match;
    // Keep single-codepoint *pictographic* emoji only. CLDR also annotates
    // plain ASCII punctuation ("{" -> "open curly bracket", ":" -> "colon")
    // and digits — those already have well-defined slugify behaviour and
    // must not be rewritten. Multi-codepoint sequences (flags, skin tones,
    // ZWJ combos) are skipped too, so slugs stay short and predictable.
    if ([...cp].length !== 1 || !/\p{Extended_Pictographic}/u.test(cp)) continue;
    const slugWord = name
      .toLowerCase()
      .replace(/[^a-z0-9\s-]+/g, "")
      .trim()
      .replace(/\s+/g, "-");
    if (slugWord) table[cp] = slugWord;
  }

  const sorted = Object.fromEntries(Object.entries(table).sort(([a], [b]) => a.localeCompare(b)));
  writeFileSync(OUTPUT_PATH, `${JSON.stringify(sorted, null, 2)}\n`);
  console.log(`Wrote ${Object.keys(sorted).length} emoji names to ${OUTPUT_PATH}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
