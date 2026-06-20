/**
 * Regenerates src/client/paletteThemes.ts from the paletteui.xyz registry.
 *
 *   node --import tsx/esm scripts/fetch-palette-themes.ts
 *
 * Pulls every theme from the registry, drops the brand / TV-film / country
 * categories, and maps each shadcn `registry:theme` onto our ThemePreset shape
 * (surface<-card, accent<-ring). Output is committed; rerun to refresh.
 */
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";

const BASE = "https://www.paletteui.xyz";

// Site groupings we keep, in display order. Anything not listed here (brands,
// TV/film, countries) is intentionally excluded.
const CATEGORIES: Record<string, string[]> = {
  Neutral: ["zinc", "slate", "stone", "mono"],
  Bold: ["neo", "contrast", "oxide", "electric"],
  Warm: ["editorial", "terra", "sand", "rose"],
  Cool: ["midnight", "saas", "ocean", "frost"],
  Playful: ["candy", "emerald", "sunset"],
  Seasonal: ["spring", "summer", "autumn", "winter"],
  "Space & Retro": [
    "nebula",
    "mars",
    "aurora",
    "eclipse",
    "synthwave",
    "terminal",
    "polaroid",
    "pixel",
  ],
  Nature: ["sakura", "lavender", "reef", "redwood"],
};

const slugCategory = new Map<string, string>();
for (const [category, slugs] of Object.entries(CATEGORIES)) {
  for (const slug of slugs) slugCategory.set(slug, category);
}

const OKLCH = /^oklch\(\s*[\d.]+%?\s+[\d.]+\s+[-\d.]+(?:deg)?\s*\)$/i;
const clean = (v: string) =>
  v.trim().replace(/\s*\/\s*[\d.]+\s*\)/, ")");

type Vars = Record<string, string>;
type Palette = Record<string, string>;

function palette(m: Vars): Palette {
  const p: Palette = {
    background: clean(m.background),
    foreground: clean(m.foreground),
    surface: clean(m.card ?? m.background),
    muted: clean(m.muted),
    mutedForeground: clean(m["muted-foreground"]),
    border: clean(m.border),
    primary: clean(m.primary),
    primaryForeground: clean(m["primary-foreground"]),
    accent: clean(m.ring ?? m.primary),
    destructive: clean(m.destructive),
  };
  for (const [k, v] of Object.entries(p)) {
    if (!OKLCH.test(v)) throw new Error(`bad oklch ${k}=${v}`);
  }
  return p;
}

const esc = (s: string) => s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
const emit = (p: Palette) =>
  "{\n" +
  Object.entries(p)
    .map(([k, v]) => `      ${k}: "${v}",`)
    .join("\n") +
  "\n    }";

async function getJson(url: string): Promise<any> {
  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok) throw new Error(`${res.status} ${url}`);
  return res.json();
}

async function main() {
  const registry = await getJson(`${BASE}/r/registry.json`);
  const items: Array<{ name: string; title: string; description?: string }> =
    registry.items;
  const order = items.map((i) => i.name).filter((n) => slugCategory.has(n));
  const meta = new Map(items.map((i) => [i.name, i]));

  const themes = await Promise.all(
    order.map(async (name) => ({
      name,
      data: await getJson(`${BASE}/r/${name}.json`),
    })),
  );

  const out: string[] = [
    "// AUTO-GENERATED from https://www.paletteui.xyz (registry:theme items).",
    "// Curated OKLCH light/dark palettes (brands, TV/film, and country themes",
    "// excluded) mapped onto our ThemePreset shape: surface<-card, accent<-ring.",
    "// Do not hand-edit; regenerate via scripts/fetch-palette-themes.ts.",
    'import type { ThemePreset } from "./theme";',
    "",
    "export const PALETTE_UI_PRESETS: ThemePreset[] = [",
  ];
  for (const { name, data } of themes) {
    const info = meta.get(name)!;
    const cv = data.cssVars;
    out.push("  {");
    out.push(`    id: "pui-${name}",`);
    out.push(`    name: "${esc(info.title)}",`);
    out.push(`    description: "${esc(info.description ?? "")}",`);
    out.push(`    category: "${slugCategory.get(name)}",`);
    out.push(`    light: ${emit(palette(cv.light))},`);
    out.push(`    dark: ${emit(palette(cv.dark))},`);
    out.push("  },");
  }
  out.push("];", "");

  const target = resolve(import.meta.dirname, "../src/client/paletteThemes.ts");
  writeFileSync(target, out.join("\n"));
  console.log(`wrote ${order.length} presets to ${target}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
