import emojiNames from "./emojiNames.generated.json" with { type: "json" };

const NAMES: Record<string, string> = emojiNames as Record<string, string>;

/**
 * Replace emoji with their short CLDR text-to-speech names ("🍌" -> " banana ")
 * so slugify() can fold them into a plain-alpha slug as ordinary words instead
 * of dropping them — "Banana 🍌" and "Banana 🍍" should not collide on
 * "banana". Unrecognised symbols are left as-is for slugify's normal handling.
 *
 * Display titles are never passed through this — only slug derivation.
 *
 * Imported as a static JSON module (rather than read from disk at runtime) so
 * this stays bundler-friendly: slugify() is reachable from client code via
 * markdown.ts -> summaryHtml.ts, and Node built-ins like node:fs get
 * externalized (and break) in that browser bundle.
 */
export function emojiToSlugWords(input: string): string {
  let out = "";
  for (const ch of input) {
    const name = NAMES[ch];
    out += name ? ` ${name} ` : ch;
  }
  return out;
}
