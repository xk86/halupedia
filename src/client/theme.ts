import type { CSSProperties } from "react";

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
  light: ThemePalette;
  dark: ThemePalette;
}

export const THEME_STORAGE_KEY = "halupedia-user-settings";

export const FONT_OPTIONS = [
  {
    value: "editorial-serif",
    label: "Editorial serif",
    stack:
      '"EB Garamond", "Iowan Old Style", "Palatino Linotype", Georgia, serif',
  },
  {
    value: "system-serif",
    label: "System serif",
    stack: 'ui-serif, Georgia, Cambria, "Times New Roman", serif',
  },
  {
    value: "inter",
    label: "Inter / system sans",
    stack: 'Inter, ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif',
  },
  {
    value: "humanist-sans",
    label: "Humanist sans",
    stack: '"Avenir Next", Avenir, "Segoe UI", ui-sans-serif, sans-serif',
  },
  {
    value: "system-mono",
    label: "System monospace",
    stack:
      'ui-monospace, "SFMono-Regular", Consolas, "Liberation Mono", monospace',
  },
  {
    value: "classic-mono",
    label: "Classic monospace",
    stack: '"IBM Plex Mono", "Courier New", Courier, monospace',
  },
] as const;

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
    light: halupediaLight,
    dark: halupediaDark,
  },
  {
    id: "neutral",
    name: "Neutral",
    description: "A standard grayscale UI palette.",
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
];

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
    articleFont: current?.articleFont ?? "editorial-serif",
    uiFont: current?.uiFont ?? "inter",
    fixedFont: current?.fixedFont ?? "system-mono",
    radius: current?.radius ?? 3,
    fontScale: current?.fontScale ?? 1,
    light: clonePalette(preset.light),
    dark: clonePalette(preset.dark),
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
      typeof value[key] === "string" && value[key]
        ? value[key]
        : defaultValue,
    ]),
  ) as unknown as ThemePalette;
}

export function normalizeThemeSettings(value: unknown): ThemeSettings {
  if (!isRecord(value)) return settingsFromPreset(THEME_PRESETS[0]);
  const mode =
    value.mode === "light" || value.mode === "dark" || value.mode === "system"
      ? value.mode
      : DEFAULT_THEME_SETTINGS.mode;
  return {
    version: 1,
    mode,
    presetId:
      typeof value.presetId === "string"
        ? value.presetId
        : DEFAULT_THEME_SETTINGS.presetId,
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
  return {
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
    value <= 0.04045
      ? value / 12.92
      : ((value + 0.055) / 1.055) ** 2.4,
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
        value <= 0.0031308
          ? 12.92 * value
          : 1.055 * value ** (1 / 2.4) - 0.055;
      return Math.round(Math.min(1, Math.max(0, srgb)) * 255)
        .toString(16)
        .padStart(2, "0");
    })
    .join("")}`;
}
