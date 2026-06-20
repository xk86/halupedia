import { afterEach, describe, expect, it } from "vitest";
import {
  DEFAULT_THEME_SETTINGS,
  THEME_STORAGE_KEY,
  applyThemeSettings,
  hexToOklch,
  loadThemeSettings,
  normalizeThemeSettings,
  oklchToHex,
  persistThemeSettings,
  settingsFromPreset,
  THEME_PRESETS,
  themeVariables,
} from "../../src/client/theme";

describe("theme settings", () => {
  afterEach(() => {
    window.localStorage.clear();
    document.documentElement.removeAttribute("data-theme");
    document.documentElement.removeAttribute("style");
  });

  it("round-trips browser hex colors through OKLCH", () => {
    for (const color of ["#ff0000", "#f3ecd8", "#171513", "#336699"]) {
      expect(oklchToHex(hexToOklch(color))).toBe(color);
    }
  });

  it("normalizes corrupt persisted values without discarding valid choices", () => {
    const normalized = normalizeThemeSettings({
      mode: "dark",
      radius: 999,
      articleFont: "sf-mono",
      light: { accent: "oklch(0.7 0.2 30)" },
    });

    expect(normalized.mode).toBe("dark");
    expect(normalized.radius).toBe(24);
    expect(normalized.articleFont).toBe("sf-mono");
    expect(normalized.light.accent).toBe("oklch(0.7 0.2 30)");
    expect(normalized.light.background).toBe(
      DEFAULT_THEME_SETTINGS.light.background,
    );
  });

  it("persists one versioned model and migrates the legacy dark flag", () => {
    window.localStorage.setItem("halupedia-theme", "dark");
    expect(loadThemeSettings().mode).toBe("dark");

    const settings = settingsFromPreset(THEME_PRESETS[2]);
    persistThemeSettings(settings);

    expect(window.localStorage.getItem("halupedia-theme")).toBeNull();
    expect(
      JSON.parse(window.localStorage.getItem(THEME_STORAGE_KEY) ?? "{}"),
    ).toMatchObject({ version: 1, presetId: "slate" });
  });

  it("applies the selected palette, fonts, and radius to the document root", () => {
    const settings = {
      ...DEFAULT_THEME_SETTINGS,
      mode: "dark" as const,
      articleFont: "sf-mono",
      radius: 11,
    };

    expect(applyThemeSettings(settings, false)).toBe("dark");
    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(document.documentElement.style.getPropertyValue("--radius")).toBe(
      "11px",
    );
    expect(
      document.documentElement.style.getPropertyValue("--parchment"),
    ).toBe(settings.dark.background);
    expect(
      document.documentElement.style.getPropertyValue("--article-font"),
    ).toContain("ui-monospace");
  });

  it("scales the document root font size and clamps out-of-range values", () => {
    applyThemeSettings({ ...DEFAULT_THEME_SETTINGS, fontScale: 1.25 }, false);
    expect(document.documentElement.style.fontSize).toBe("125%");
    expect(
      document.documentElement.style.getPropertyValue("--font-scale"),
    ).toBe("1.25");

    expect(normalizeThemeSettings({ fontScale: 99 }).fontScale).toBe(1.4);
    expect(normalizeThemeSettings({ fontScale: 0.1 }).fontScale).toBe(0.85);
    expect(normalizeThemeSettings({}).fontScale).toBe(1);
  });

  it("derives legacy and shadcn variables without runtime shadows", () => {
    const variables = themeVariables(DEFAULT_THEME_SETTINGS, "light");

    expect(variables["--background"]).toBe(
      DEFAULT_THEME_SETTINGS.light.background,
    );
    expect(variables["--accent"]).toBe(DEFAULT_THEME_SETTINGS.light.accent);
    expect(variables["--shadow-soft"]).toBe("transparent");
    expect(variables["--shadow-strong"]).toBe("transparent");
  });

  it("mirrors source tokens as --color-* so utilities theme scoped containers", () => {
    const variables = themeVariables(DEFAULT_THEME_SETTINGS, "dark");
    // Tailwind utilities compile to var(--color-*); the mirror re-points them
    // at the per-element source token so a nested preview renders its variant.
    expect(variables["--color-card"]).toBe("var(--card)");
    expect(variables["--color-background"]).toBe("var(--background)");
    expect(variables["--color-primary"]).toBe("var(--primary)");
    expect(variables["--card"]).toBe(DEFAULT_THEME_SETTINGS.dark.surface);
  });
});
