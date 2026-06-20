import type { CSSProperties } from "react";
import { PALETTE_UI_PRESETS } from "./paletteThemes";

export type ThemeMode = "system" | "light" | "dark";
export type ThemeVariant = "light" | "dark";

export interface ThemePalette {
  background: string;
  foreground: string;
  surface: string;
  muted: string;
  mutedForeground: string;
  border: string;
  primary: string;
  primaryForeground: string;
  accent: string;
  destructive: string;
}

export interface ThemeSettings {
  version: 1;
  mode: ThemeMode;
  presetId: string;
  /** User-authored, editable themes. Stock presets stay read-only. */
  customThemes: ThemePreset[];
  articleFont: string;
  uiFont: string;
  fixedFont: string;
  radius: number;
  fontScale: number;
  light: ThemePalette;
  dark: ThemePalette;
}

export const MIN_FONT_SCALE = 0.85;
export const MAX_FONT_SCALE = 1.4;

export interface ThemePreset {
  id: string;
  name: string;
  description: string;
  /** Menu grouping label (e.g. "Built-in", "Neutral", "Space & Retro"). */
  category?: string;
  light: ThemePalette;
  dark: ThemePalette;
}

export const THEME_STORAGE_KEY = "halupedia-user-settings";

export type FontCategory = "Serif" | "Sans" | "Mono";

export interface FontOption {
  value: string;
  label: string;
  category: FontCategory;
  stack: string;
}

// Real, named font families. Stacks fall back gracefully, but the first entry
// is the family actually shown so the picker label matches what renders.
export const FONT_OPTIONS: readonly FontOption[] = [
  {
    value: "eb-garamond",
    label: "EB Garamond",
    category: "Serif",
    stack: '"EB Garamond", "Iowan Old Style", Palatino, Georgia, serif',
  },
  {
    value: "georgia",
    label: "Georgia",
    category: "Serif",
    stack: 'Georgia, "Times New Roman", serif',
  },
  {
    value: "palatino",
    label: "Palatino",
    category: "Serif",
    stack: '"Palatino Linotype", Palatino, "Book Antiqua", Georgia, serif',
  },
  {
    value: "baskerville",
    label: "Baskerville",
    category: "Serif",
    stack: 'Baskerville, "Baskerville Old Face", Georgia, serif',
  },
  {
    value: "times-new-roman",
    label: "Times New Roman",
    category: "Serif",
    stack: '"Times New Roman", Times, serif',
  },
  {
    value: "inter",
    label: "Inter",
    category: "Sans",
    stack: "Inter, ui-sans-serif, system-ui, sans-serif",
  },
  {
    value: "system-ui",
    label: "System UI",
    category: "Sans",
    stack: 'system-ui, -apple-system, "Segoe UI", sans-serif',
  },
  {
    value: "helvetica-neue",
    label: "Helvetica Neue",
    category: "Sans",
    stack: '"Helvetica Neue", Helvetica, Arial, sans-serif',
  },
  {
    value: "avenir-next",
    label: "Avenir Next",
    category: "Sans",
    stack: '"Avenir Next", Avenir, "Segoe UI", sans-serif',
  },
  {
    value: "verdana",
    label: "Verdana",
    category: "Sans",
    stack: "Verdana, Geneva, sans-serif",
  },
  {
    value: "sf-mono",
    label: "SF Mono",
    category: "Mono",
    stack: '"SF Mono", "SFMono-Regular", ui-monospace, monospace',
  },
  {
    value: "menlo",
    label: "Menlo",
    category: "Mono",
    stack: "Menlo, Monaco, monospace",
  },
  {
    value: "monaco",
    label: "Monaco",
    category: "Mono",
    stack: "Monaco, Menlo, monospace",
  },
  {
    value: "courier-new",
    label: "Courier New",
    category: "Mono",
    stack: '"Courier New", Courier, monospace',
  },
] as const;

export const FONT_CATEGORIES: FontCategory[] = ["Serif", "Sans", "Mono"];

const halupediaLight: ThemePalette = {
  background: "oklch(0.943 0.027 90.9)",
  foreground: "oklch(0.214 0.015 66.9)",
  surface: "oklch(0.975 0.012 90.9)",
  muted: "oklch(0.904 0.039 90.7)",
  mutedForeground: "oklch(0.478 0.040 73.8)",
  border: "oklch(0.725 0.056 85.5)",
  primary: "oklch(0.214 0.015 66.9)",
  primaryForeground: "oklch(0.943 0.027 90.9)",
  accent: "oklch(0.408 0.110 33.0)",
  destructive: "oklch(0.430 0.145 29.0)",
};

const halupediaDark: ThemePalette = {
  background: "oklch(0.197 0.005 67.5)",
  foreground: "oklch(0.929 0.029 89.6)",
  surface: "oklch(0.246 0.013 78.0)",
  muted: "oklch(0.285 0.018 78.0)",
  mutedForeground: "oklch(0.686 0.047 83.8)",
  border: "oklch(0.442 0.042 81.7)",
  primary: "oklch(0.929 0.029 89.6)",
  primaryForeground: "oklch(0.197 0.005 67.5)",
  accent: "oklch(0.706 0.109 43.0)",
  destructive: "oklch(0.650 0.150 29.0)",
};

export const THEME_PRESETS: ThemePreset[] = [
  {
    id: "halupedia",
    name: "Halupedia",
    description: "Warm parchment, ink, and oxblood.",
    category: "Built-in",
    light: halupediaLight,
    dark: halupediaDark,
  },
  {
    id: "neutral",
    name: "Neutral",
    description: "A standard grayscale UI palette.",
    category: "Built-in",
    light: {
      background: "oklch(0.985 0.000 89.9)",
      foreground: "oklch(0.205 0.000 89.9)",
      surface: "oklch(1 0 0)",
      muted: "oklch(0.967 0.001 286.4)",
      mutedForeground: "oklch(0.556 0.000 89.9)",
      border: "oklch(0.920 0.004 286.3)",
      primary: "oklch(0.205 0.000 89.9)",
      primaryForeground: "oklch(0.985 0.000 89.9)",
      accent: "oklch(0.488 0.243 264.4)",
      destructive: "oklch(0.577 0.245 27.3)",
    },
    dark: {
      background: "oklch(0.141 0.004 285.8)",
      foreground: "oklch(0.985 0.000 89.9)",
      surface: "oklch(0.210 0.006 285.9)",
      muted: "oklch(0.274 0.005 286.0)",
      mutedForeground: "oklch(0.712 0.013 286.1)",
      border: "oklch(0.370 0.012 285.8)",
      primary: "oklch(0.985 0.000 89.9)",
      primaryForeground: "oklch(0.205 0.000 89.9)",
      accent: "oklch(0.707 0.165 254.6)",
      destructive: "oklch(0.704 0.191 22.2)",
    },
  },
  {
    id: "slate",
    name: "Slate",
    description: "Cool blue-gray surfaces and crisp contrast.",
    category: "Built-in",
    light: {
      background: "oklch(0.984 0.003 247.9)",
      foreground: "oklch(0.208 0.040 265.8)",
      surface: "oklch(1 0 0)",
      muted: "oklch(0.929 0.013 255.5)",
      mutedForeground: "oklch(0.446 0.037 257.3)",
      border: "oklch(0.711 0.035 256.8)",
      primary: "oklch(0.279 0.037 260.0)",
      primaryForeground: "oklch(0.984 0.003 247.9)",
      accent: "oklch(0.546 0.215 262.9)",
      destructive: "oklch(0.577 0.245 27.3)",
    },
    dark: {
      background: "oklch(0.208 0.040 265.8)",
      foreground: "oklch(0.984 0.003 247.9)",
      surface: "oklch(0.279 0.037 260.0)",
      muted: "oklch(0.330 0.039 258.0)",
      mutedForeground: "oklch(0.711 0.035 256.8)",
      border: "oklch(0.446 0.037 257.3)",
      primary: "oklch(0.929 0.013 255.5)",
      primaryForeground: "oklch(0.208 0.040 265.8)",
      accent: "oklch(0.707 0.165 254.6)",
      destructive: "oklch(0.704 0.191 22.2)",
    },
  },
  {
    id: "solarized",
    name: "Solarized",
    description: "The familiar low-contrast Solarized palette.",
    category: "Built-in",
    light: {
      background: "oklch(0.974 0.026 90.1)",
      foreground: "oklch(0.568 0.029 221.9)",
      surface: "oklch(0.931 0.026 92.4)",
      muted: "oklch(0.905 0.030 92.0)",
      mutedForeground: "oklch(0.654 0.020 205.3)",
      border: "oklch(0.698 0.016 196.8)",
      primary: "oklch(0.309 0.052 219.7)",
      primaryForeground: "oklch(0.974 0.026 90.1)",
      accent: "oklch(0.654 0.134 85.7)",
      destructive: "oklch(0.581 0.173 39.5)",
    },
    dark: {
      background: "oklch(0.267 0.049 219.8)",
      foreground: "oklch(0.931 0.026 92.4)",
      surface: "oklch(0.309 0.052 219.7)",
      muted: "oklch(0.360 0.045 219.0)",
      mutedForeground: "oklch(0.654 0.020 205.3)",
      border: "oklch(0.523 0.028 219.1)",
      primary: "oklch(0.931 0.026 92.4)",
      primaryForeground: "oklch(0.267 0.049 219.8)",
      accent: "oklch(0.654 0.134 85.7)",
      destructive: "oklch(0.581 0.173 39.5)",
    },
  },
  // 35 curated palettes from paletteui.xyz (brands/TV/countries excluded).
  ...PALETTE_UI_PRESETS,
];

/** Preset categories in display order, each with its presets. */
export const THEME_PRESET_GROUPS: Array<{
  category: string;
  presets: ThemePreset[];
}> = (() => {
  const order: string[] = [];
  const byCategory = new Map<string, ThemePreset[]>();
  for (const preset of THEME_PRESETS) {
    const category = preset.category ?? "Other";
    if (!byCategory.has(category)) {
      byCategory.set(category, []);
      order.push(category);
    }
    byCategory.get(category)!.push(preset);
  }
  return order.map((category) => ({
    category,
    presets: byCategory.get(category)!,
  }));
})();

function clonePalette(palette: ThemePalette): ThemePalette {
  return { ...palette };
}

export function settingsFromPreset(
  preset: ThemePreset,
  current?: ThemeSettings,
): ThemeSettings {
  return {
    version: 1,
    mode: current?.mode ?? "system",
    presetId: preset.id,
    customThemes: current?.customThemes ?? [],
    articleFont: current?.articleFont ?? "eb-garamond",
    uiFont: current?.uiFont ?? "inter",
    fixedFont: current?.fixedFont ?? "sf-mono",
    radius: current?.radius ?? 3,
    fontScale: current?.fontScale ?? 1,
    light: clonePalette(preset.light),
    dark: clonePalette(preset.dark),
  };
}

/** True when `id` names a built-in (read-only) preset. */
export function isStockPreset(id: string): boolean {
  return THEME_PRESETS.some((preset) => preset.id === id);
}

/** Stock presets followed by the user's custom themes. */
export function allPresets(settings: ThemeSettings): ThemePreset[] {
  return [...THEME_PRESETS, ...settings.customThemes];
}

export function findPreset(
  settings: ThemeSettings,
  id: string,
): ThemePreset | undefined {
  return allPresets(settings).find((preset) => preset.id === id);
}

function nextCustomId(settings: ThemeSettings): string {
  const taken = new Set(allPresets(settings).map((preset) => preset.id));
  let n = settings.customThemes.length + 1;
  let id = `custom-${n}`;
  while (taken.has(id)) id = `custom-${++n}`;
  return id;
}

/**
 * Fork the current palette into a new, editable custom theme and select it.
 * Returns the updated settings plus the new theme's id.
 */
export function createCustomTheme(
  settings: ThemeSettings,
  name: string,
  description: string,
): { settings: ThemeSettings; id: string } {
  const id = nextCustomId(settings);
  const theme: ThemePreset = {
    id,
    name,
    description,
    category: "Custom",
    light: clonePalette(settings.light),
    dark: clonePalette(settings.dark),
  };
  return {
    id,
    settings: {
      ...settings,
      presetId: id,
      customThemes: [...settings.customThemes, theme],
    },
  };
}

/**
 * Ensure the active theme is an editable custom. If a stock preset is selected,
 * copy it into a new custom theme first (matching the "edit forks a copy"
 * behavior). Returns settings whose `presetId` points at a custom theme.
 */
export function ensureEditableCustom(settings: ThemeSettings): ThemeSettings {
  if (settings.customThemes.some((theme) => theme.id === settings.presetId)) {
    return settings;
  }
  const base = THEME_PRESETS.find((preset) => preset.id === settings.presetId);
  return createCustomTheme(
    settings,
    base ? `${base.name} (custom)` : "Custom theme",
    base?.description ?? "Your custom palette.",
  ).settings;
}

/** Apply a single color change, forking to a custom theme when needed. */
export function withColorChange(
  settings: ThemeSettings,
  variant: ThemeVariant,
  key: keyof ThemePalette,
  value: string,
): ThemeSettings {
  const base = ensureEditableCustom(settings);
  const palette = { ...base[variant], [key]: value };
  return writeActivePalette(base, variant, palette);
}

/** Replace a whole variant palette, forking to a custom theme when needed. */
export function withPaletteReset(
  settings: ThemeSettings,
  variant: ThemeVariant,
  palette: ThemePalette,
): ThemeSettings {
  const base = ensureEditableCustom(settings);
  return writeActivePalette(base, variant, clonePalette(palette));
}

function writeActivePalette(
  settings: ThemeSettings,
  variant: ThemeVariant,
  palette: ThemePalette,
): ThemeSettings {
  return {
    ...settings,
    [variant]: palette,
    customThemes: settings.customThemes.map((theme) =>
      theme.id === settings.presetId ? { ...theme, [variant]: palette } : theme,
    ),
  };
}

/** Update the selected custom theme's name and/or description. */
export function updateCustomMeta(
  settings: ThemeSettings,
  patch: { name?: string; description?: string },
): ThemeSettings {
  return {
    ...settings,
    customThemes: settings.customThemes.map((theme) =>
      theme.id === settings.presetId ? { ...theme, ...patch } : theme,
    ),
  };
}

/** Delete a custom theme; if it was selected, fall back to the first stock preset. */
export function deleteCustomTheme(
  settings: ThemeSettings,
  id: string,
): ThemeSettings {
  const customThemes = settings.customThemes.filter((theme) => theme.id !== id);
  if (settings.presetId !== id) return { ...settings, customThemes };
  return { ...settingsFromPreset(THEME_PRESETS[0], settings), customThemes };
}

/** The JSON envelope used to share a single theme. */
export interface SharedTheme {
  halupedia: "theme";
  version: 1;
  name: string;
  description: string;
  light: ThemePalette;
  dark: ThemePalette;
}

export function serializeTheme(
  name: string,
  description: string,
  light: ThemePalette,
  dark: ThemePalette,
): string {
  const shared: SharedTheme = {
    halupedia: "theme",
    version: 1,
    name,
    description,
    light: clonePalette(light),
    dark: clonePalette(dark),
  };
  return JSON.stringify(shared, null, 2);
}

/** Parse and validate shared-theme JSON. Returns null when unrecognizable. */
export function parseSharedTheme(text: string): SharedTheme | null {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isRecord(value) || value.halupedia !== "theme") return null;
  if (!isRecord(value.light) || !isRecord(value.dark)) return null;
  const name = typeof value.name === "string" ? value.name : "Imported theme";
  const description =
    typeof value.description === "string" ? value.description : "";
  return {
    halupedia: "theme",
    version: 1,
    name,
    description,
    light: validPalette(value.light, DEFAULT_THEME_SETTINGS.light),
    dark: validPalette(value.dark, DEFAULT_THEME_SETTINGS.dark),
  };
}

/** Add an imported theme as a new custom theme and select it. */
export function importSharedTheme(
  settings: ThemeSettings,
  shared: SharedTheme,
): { settings: ThemeSettings; id: string } {
  const id = nextCustomId(settings);
  const theme: ThemePreset = {
    id,
    name: shared.name,
    description: shared.description,
    category: "Custom",
    light: clonePalette(shared.light),
    dark: clonePalette(shared.dark),
  };
  return {
    id,
    settings: {
      ...settings,
      presetId: id,
      customThemes: [...settings.customThemes, theme],
      light: clonePalette(shared.light),
      dark: clonePalette(shared.dark),
    },
  };
}

export const DEFAULT_THEME_SETTINGS = settingsFromPreset(THEME_PRESETS[0]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function validFont(value: unknown, fallback: string): string {
  return typeof value === "string" &&
    FONT_OPTIONS.some((font) => font.value === value)
    ? value
    : fallback;
}

function validPalette(value: unknown, fallback: ThemePalette): ThemePalette {
  if (!isRecord(value)) return clonePalette(fallback);
  return Object.fromEntries(
    Object.entries(fallback).map(([key, defaultValue]) => [
      key,
      typeof value[key] === "string" && value[key] ? value[key] : defaultValue,
    ]),
  ) as unknown as ThemePalette;
}

export function normalizeThemeSettings(value: unknown): ThemeSettings {
  if (!isRecord(value)) return settingsFromPreset(THEME_PRESETS[0]);
  const mode =
    value.mode === "light" || value.mode === "dark" || value.mode === "system"
      ? value.mode
      : DEFAULT_THEME_SETTINGS.mode;
  const customThemes = Array.isArray(value.customThemes)
    ? value.customThemes.filter(isRecord).map((theme, index) => ({
        id: typeof theme.id === "string" ? theme.id : `custom-${index + 1}`,
        name: typeof theme.name === "string" ? theme.name : "Custom theme",
        description:
          typeof theme.description === "string" ? theme.description : "",
        category: "Custom",
        light: validPalette(theme.light, DEFAULT_THEME_SETTINGS.light),
        dark: validPalette(theme.dark, DEFAULT_THEME_SETTINGS.dark),
      }))
    : [];
  // Migrate the legacy single "custom" marker into a real, named custom theme
  // so older saves keep their edited palette as something editable.
  let presetId =
    typeof value.presetId === "string"
      ? value.presetId
      : DEFAULT_THEME_SETTINGS.presetId;
  if (
    presetId === "custom" &&
    !customThemes.some((theme) => theme.id === "custom")
  ) {
    customThemes.push({
      id: "custom",
      name: "Custom theme",
      description: "Your custom palette.",
      category: "Custom",
      light: validPalette(value.light, DEFAULT_THEME_SETTINGS.light),
      dark: validPalette(value.dark, DEFAULT_THEME_SETTINGS.dark),
    });
  }
  return {
    version: 1,
    mode,
    presetId,
    customThemes,
    articleFont: validFont(
      value.articleFont,
      DEFAULT_THEME_SETTINGS.articleFont,
    ),
    uiFont: validFont(value.uiFont, DEFAULT_THEME_SETTINGS.uiFont),
    fixedFont: validFont(value.fixedFont, DEFAULT_THEME_SETTINGS.fixedFont),
    radius:
      typeof value.radius === "number" && Number.isFinite(value.radius)
        ? Math.min(24, Math.max(0, value.radius))
        : DEFAULT_THEME_SETTINGS.radius,
    fontScale:
      typeof value.fontScale === "number" && Number.isFinite(value.fontScale)
        ? Math.min(MAX_FONT_SCALE, Math.max(MIN_FONT_SCALE, value.fontScale))
        : DEFAULT_THEME_SETTINGS.fontScale,
    light: validPalette(value.light, DEFAULT_THEME_SETTINGS.light),
    dark: validPalette(value.dark, DEFAULT_THEME_SETTINGS.dark),
  };
}

export function loadThemeSettings(
  storage: Pick<Storage, "getItem"> = window.localStorage,
): ThemeSettings {
  try {
    const stored = storage.getItem(THEME_STORAGE_KEY);
    if (stored) return normalizeThemeSettings(JSON.parse(stored));
    const legacyMode = storage.getItem("halupedia-theme");
    return {
      ...settingsFromPreset(THEME_PRESETS[0]),
      mode: legacyMode === "dark" ? "dark" : "system",
    };
  } catch {
    return settingsFromPreset(THEME_PRESETS[0]);
  }
}

export function persistThemeSettings(
  settings: ThemeSettings,
  storage: Pick<Storage, "setItem" | "removeItem"> = window.localStorage,
): void {
  storage.setItem(THEME_STORAGE_KEY, JSON.stringify(settings));
  storage.removeItem("halupedia-theme");
}

export function resolveThemeMode(
  mode: ThemeMode,
  systemDark: boolean,
): ThemeVariant {
  return mode === "system" ? (systemDark ? "dark" : "light") : mode;
}

function fontStack(id: string): string {
  return (
    FONT_OPTIONS.find((font) => font.value === id)?.stack ??
    FONT_OPTIONS[0].stack
  );
}

function mix(color: string, opacity: number): string {
  return `color-mix(in oklch, ${color} ${opacity}%, transparent)`;
}

export function themeVariables(
  settings: ThemeSettings,
  variant: ThemeVariant,
): Record<string, string> {
  const p = settings[variant];
  const base: Record<string, string> = {
    "--article-font": fontStack(settings.articleFont),
    "--ui-font": fontStack(settings.uiFont),
    "--fixed-font": fontStack(settings.fixedFont),
    "--serif": "var(--article-font)",
    "--sans": "var(--ui-font)",
    "--mono": "var(--fixed-font)",
    "--radius": `${settings.radius}px`,
    "--font-scale": String(settings.fontScale),
    "--parchment": p.background,
    "--parchment-deep": p.muted,
    "--ink": p.foreground,
    "--ink-soft": `color-mix(in oklch, ${p.foreground} 82%, ${p.background})`,
    "--ink-fade": p.mutedForeground,
    "--rule": p.border,
    "--accent": p.accent,
    "--accent-hover": `color-mix(in oklch, ${p.accent} 82%, ${p.foreground})`,
    "--blockquote-bg": p.muted,
    "--link-underline": mix(p.accent, 32),
    "--accent-wash-soft": mix(p.accent, 7),
    "--accent-wash": mix(p.accent, 11),
    "--accent-wash-strong": mix(p.accent, 27),
    "--rule-dotted": mix(p.border, 70),
    "--rule-soft": mix(p.border, 58),
    "--control-border": mix(p.border, 72),
    "--control-border-strong": p.border,
    "--control-surface": p.surface,
    "--control-surface-strong": p.muted,
    "--control-surface-soft": `color-mix(in oklch, ${p.surface} 65%, ${p.muted})`,
    "--control-surface-focus": p.surface,
    "--panel-border": p.border,
    "--panel-surface": p.surface,
    "--panel-surface-soft": `color-mix(in oklch, ${p.surface} 72%, ${p.background})`,
    "--panel-surface-strong": p.surface,
    "--input-surface": p.surface,
    "--input-surface-focus": p.surface,
    "--input-surface-strong": p.surface,
    "--overlay-bg": p.foreground,
    "--overlay-dim": mix(p.foreground, 46),
    "--overlay-border": mix(p.primaryForeground, 20),
    "--shadow-soft": "transparent",
    "--shadow-strong": "transparent",
    "--danger": p.destructive,
    "--danger-hover": `color-mix(in oklch, ${p.destructive} 84%, ${p.foreground})`,
    "--danger-alt": p.destructive,
    "--danger-text": p.primaryForeground,
    "--accent-border-soft": mix(p.accent, 28),
    "--accent-border": mix(p.accent, 38),
    "--accent-border-strong": mix(p.accent, 54),
    "--accent-surface-soft": mix(p.accent, 8),
    "--warning-border": p.accent,
    "--warning-bg": mix(p.accent, 18),
    "--selection-bg": mix(p.accent, 28),
    "--success": "oklch(0.58 0.12 145)",
    "--success-glow": "transparent",
    "--success-glow-fade": "transparent",
    "--sidebar-accent-border": mix(p.accent, 44),
    "--background": p.background,
    "--foreground": p.foreground,
    "--card": p.surface,
    "--card-foreground": p.foreground,
    "--popover": p.surface,
    "--popover-foreground": p.foreground,
    "--primary": p.primary,
    "--primary-foreground": p.primaryForeground,
    "--secondary": p.muted,
    "--secondary-foreground": p.foreground,
    "--muted": p.muted,
    "--muted-foreground": p.mutedForeground,
    "--destructive": p.destructive,
    "--destructive-foreground": p.primaryForeground,
    "--border": p.border,
    "--input": p.border,
    "--ring": p.accent,
  };
  // Tailwind's @theme bridge is non-inline, so utilities compile to
  // `var(--color-*)` whose value is resolved once at :root. To theme a scoped
  // container (e.g. the day/night preview), mirror every source token as
  // `--color-<name>: var(--<name>)` so the utilities re-resolve per element.
  for (const key of Object.keys(base)) {
    if (!key.startsWith("--color-")) {
      const colorKey = `--color-${key.slice(2)}`;
      if (!(colorKey in base)) base[colorKey] = `var(${key})`;
    }
  }
  return base;
}

export function themePreviewStyle(
  settings: ThemeSettings,
  variant: ThemeVariant,
): CSSProperties {
  return {
    ...themeVariables(settings, variant),
    colorScheme: variant,
  } as CSSProperties;
}

export function applyThemeSettings(
  settings: ThemeSettings,
  systemDark: boolean,
  root: HTMLElement = document.documentElement,
): ThemeVariant {
  const variant = resolveThemeMode(settings.mode, systemDark);
  root.dataset.theme = variant;
  root.style.colorScheme = variant;
  // Scale every rem-based size by adjusting the root font-size. body uses 1rem
  // so the whole document follows.
  root.style.fontSize = `${(settings.fontScale * 100).toFixed(3)}%`;
  for (const [name, value] of Object.entries(
    themeVariables(settings, variant),
  )) {
    root.style.setProperty(name, value);
  }
  return variant;
}

export function hexToOklch(hex: string): string {
  const normalized = hex.replace(/^#/, "");
  if (!/^[0-9a-f]{6}$/i.test(normalized)) return "oklch(0 0 0)";
  const srgb = [0, 2, 4].map(
    (offset) => Number.parseInt(normalized.slice(offset, offset + 2), 16) / 255,
  );
  const [r, g, b] = srgb.map((value) =>
    value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4,
  );
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  const lightness = 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s;
  const a = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
  const bb = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
  const chroma = Math.hypot(a, bb);
  const hue = (Math.atan2(bb, a) * 180) / Math.PI;
  return `oklch(${lightness.toFixed(3)} ${chroma.toFixed(3)} ${((hue + 360) % 360).toFixed(1)})`;
}

export function oklchToHex(color: string): string {
  const match = color.match(
    /oklch\(\s*([\d.]+)%?\s+([\d.]+)\s+([\d.-]+)(?:deg)?\s*\)/i,
  );
  if (!match) return "#000000";
  let lightness = Number(match[1]);
  if (match[1].includes("%")) lightness /= 100;
  const chroma = Number(match[2]);
  const hue = (Number(match[3]) * Math.PI) / 180;
  const a = chroma * Math.cos(hue);
  const b = chroma * Math.sin(hue);
  const l = (lightness + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (lightness - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (lightness - 0.0894841775 * a - 1.291485548 * b) ** 3;
  const linear = [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ];
  return `#${linear
    .map((value) => {
      const srgb =
        value <= 0.0031308 ? 12.92 * value : 1.055 * value ** (1 / 2.4) - 0.055;
      return Math.round(Math.min(1, Math.max(0, srgb)) * 255)
        .toString(16)
        .padStart(2, "0");
    })
    .join("")}`;
}
