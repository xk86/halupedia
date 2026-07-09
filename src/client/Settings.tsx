import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  CopyPlusIcon,
  DownloadIcon,
  RotateCcwIcon,
  Trash2Icon,
  UploadIcon,
} from "lucide-react";
import { MarkdownEditor } from "./MarkdownEditor";
import { ThemeColorPicker } from "./ThemeColorPicker";
import { InfoboxCard } from "./article/infobox/InfoboxCard";
import type { InfoboxData } from "@/types";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
  FieldTitle,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Separator } from "@/components/ui/separator";
import { Slider } from "@/components/ui/slider";
import { Textarea } from "@/components/ui/textarea";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import {
  DEFAULT_THEME_SETTINGS,
  FONT_CATEGORIES,
  FONT_OPTIONS,
  MAX_FONT_SCALE,
  MIN_FONT_SCALE,
  THEME_PRESETS,
  THEME_PRESET_GROUPS,
  createCustomTheme,
  deleteCustomTheme,
  findPreset,
  hexToOklch,
  importSharedTheme,
  isStockPreset,
  oklchToHex,
  parseSharedTheme,
  serializeTheme,
  settingsFromPreset,
  themePreviewStyle,
  updateCustomMeta,
  withColorChange,
  withPaletteReset,
  type ThemeMode,
  type ThemePalette,
  type ThemeSettings,
  type ThemeVariant,
} from "./theme";

interface SettingsProps {
  settings: ThemeSettings;
  onChange: (settings: ThemeSettings) => void;
}

/* The XS–2XL corner scale, mirrored as a live preview under the roundness
 * slider. Each swatch is sized to the kind of element its step is meant for —
 * a tiny chip at XS up to a card at 2XL — so the radius reads at its true
 * proportion (a card corner, not a circle) and the "bigger shapes, bigger
 * radii" rule is visible as the slider moves. Full class strings so Tailwind
 * keeps the utilities. */
const RADIUS_SCALE_PREVIEW = [
  { token: "rounded-xs", size: "size-5", label: "XS" },
  { token: "rounded-sm", size: "size-7", label: "S" },
  { token: "rounded-md", size: "size-9", label: "M" },
  { token: "rounded-lg", size: "size-12", label: "L" },
  { token: "rounded-xl", size: "size-14", label: "XL" },
  { token: "rounded-2xl", size: "size-16", label: "2XL" },
] as const;

const paletteFields: Array<{
  key: keyof ThemePalette;
  label: string;
  description: string;
}> = [
  { key: "background", label: "Background", description: "Page canvas" },
  { key: "foreground", label: "Foreground", description: "Primary text" },
  { key: "surface", label: "Surface", description: "Cards and popovers" },
  { key: "muted", label: "Muted", description: "Subtle controls" },
  {
    key: "mutedForeground",
    label: "Muted foreground",
    description: "Secondary text",
  },
  { key: "border", label: "Border", description: "Rules and outlines" },
  { key: "primary", label: "Primary", description: "Primary actions" },
  {
    key: "primaryForeground",
    label: "Primary foreground",
    description: "Text on primary",
  },
  { key: "accent", label: "Accent", description: "Links and focus" },
  {
    key: "destructive",
    label: "Destructive",
    description: "Dangerous actions",
  },
];

const PREVIEW_MARKDOWN_KEY = "halupedia-theme-preview-md";
const COLOR_SWATCHES_KEY = "halupedia-theme-color-swatches";
const DEFAULT_COLOR_SWATCHES = [
  "#FFFFFF",
  "#000000",
  "#7A2E1F",
  "#D98968",
  "#2F6F73",
  "#B6A47E",
];
const DEFAULT_PREVIEW_MARKDOWN = `# The cartographer's quiet index

An article font should stay comfortable over long passages. An [accent link](https://example.com) stays distinct without overwhelming the body text.

## Surfaces and controls

- Muted surfaces, borders, and rules
- Secondary text in the softer foreground
- Inline \`fixed-width: atlas_entry_04\`

> A short quotation shows muted surfaces, borders, and secondary text together.`;

// Sample data for the preview's right-rail. Mirrors the real article infobox so
// themes are tested against the actual component. Values are plain text rendered
// through the same markup the server-rendered HTML flows into; the accent link
// exercises the link color against the panel surface.
const PREVIEW_INFOBOX: InfoboxData = {
  title: "The cartographer's quiet index",
  subtitle: "Reference compendium",
  groups: [
    {
      label: "Overview",
      rows: [
        { label: "Type", value: "Atlas supplement" },
        { label: "Edition", value: "Fourth" },
        {
          label: "Subject",
          value: '<a href="/wiki/Cartography">Cartography</a>',
        },
      ],
    },
    {
      label: "Details",
      rows: [
        { label: "Pages", value: "412" },
        { label: "Entries", value: "atlas_entry_04" },
      ],
    },
  ],
};

function loadPreviewMarkdown(): string {
  try {
    return (
      window.localStorage.getItem(PREVIEW_MARKDOWN_KEY) ??
      DEFAULT_PREVIEW_MARKDOWN
    );
  } catch {
    return DEFAULT_PREVIEW_MARKDOWN;
  }
}

function loadColorSwatches(): string[] {
  try {
    const stored = JSON.parse(
      window.localStorage.getItem(COLOR_SWATCHES_KEY) ?? "[]",
    );
    return Array.isArray(stored)
      ? stored.filter(
          (color): color is string =>
            typeof color === "string" && /^#[0-9a-f]{6}$/i.test(color),
        )
      : [];
  } catch {
    return [];
  }
}

const fontItems = FONT_OPTIONS.map(({ label, value }) => ({ label, value }));
const presetItems = THEME_PRESETS.map(({ id, name }) => ({
  label: name,
  value: id,
}));
function ResetButton({
  label,
  disabled,
  onReset,
}: {
  label: string;
  disabled?: boolean;
  onReset: () => void;
}) {
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon"
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={onReset}
      className="size-7 shrink-0 text-muted-foreground"
    >
      <RotateCcwIcon className="size-3.5" />
    </Button>
  );
}

function FontSelect({
  id,
  label,
  description,
  value,
  defaultValue,
  onValueChange,
}: {
  id: string;
  label: string;
  description: string;
  value: string;
  defaultValue: string;
  onValueChange: (value: string) => void;
}) {
  return (
    <Field>
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <FieldLabel htmlFor={id}>{label}</FieldLabel>
          <FieldDescription>{description}</FieldDescription>
        </div>
        <ResetButton
          label={`Reset ${label.toLowerCase()}`}
          disabled={value === defaultValue}
          onReset={() => onValueChange(defaultValue)}
        />
      </div>
      <Select
        items={fontItems}
        value={value}
        onValueChange={(next) => {
          if (next != null) onValueChange(next);
        }}
      >
        <SelectTrigger id={id} className="w-full">
          <SelectValue />
        </SelectTrigger>
        <SelectContent alignItemWithTrigger={false}>
          {FONT_CATEGORIES.map((category) => (
            <SelectGroup key={category}>
              <SelectLabel>{category}</SelectLabel>
              {FONT_OPTIONS.filter((font) => font.category === category).map(
                (font) => (
                  <SelectItem key={font.value} value={font.value}>
                    <span style={{ fontFamily: font.stack }}>{font.label}</span>
                  </SelectItem>
                ),
              )}
            </SelectGroup>
          ))}
        </SelectContent>
      </Select>
    </Field>
  );
}

function ColorField({
  variant,
  field,
  value,
  backgroundColor,
  presets,
  onChange,
  onAddPreset,
}: {
  variant: ThemeVariant;
  field: (typeof paletteFields)[number];
  value: string;
  backgroundColor: string;
  presets: string[];
  onChange: (value: string) => void;
  onAddPreset: (hex: string) => void;
}) {
  const id = `${variant}-${field.key}`;
  const hex = oklchToHex(value).toUpperCase();
  const [hexDraft, setHexDraft] = useState(hex);
  const validHex = /^#?[0-9A-F]{6}$/i.test(hexDraft);

  useEffect(() => setHexDraft(hex), [hex]);

  return (
    <Field
      className="grid grid-cols-[minmax(0,1fr)_5.75rem_1.75rem] items-center gap-1.5"
      data-invalid={!validHex || undefined}
    >
      <div className="min-w-0">
        <FieldLabel htmlFor={id} className="text-xs leading-tight">
          {field.label}
        </FieldLabel>
        <FieldDescription className="truncate text-[0.6875rem] leading-tight">
          {field.description}
        </FieldDescription>
      </div>
      <Input
        id={id}
        value={hexDraft}
        onChange={(event) => {
          const next = event.currentTarget.value.toUpperCase();
          setHexDraft(next);
          if (/^#?[0-9A-F]{6}$/.test(next)) {
            onChange(hexToOklch(`#${next.replace(/^#/, "")}`));
          }
        }}
        onBlur={() => {
          setHexDraft(
            validHex ? `#${hexDraft.replace(/^#/, "").toUpperCase()}` : hex,
          );
        }}
        aria-label={`${variant} ${field.label} HEX value`}
        aria-invalid={!validHex}
        className="h-7 px-2 font-mono text-xs"
      />
      <Popover>
        <PopoverTrigger
          type="button"
          aria-label={`Edit ${variant} ${field.label} color`}
          title="Open color picker"
          className="size-7 shrink-0 cursor-pointer rounded-md border border-input shadow-xs transition-[color,box-shadow] outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
          style={{ backgroundColor: value }}
        />
        <PopoverContent
          align="end"
          sideOffset={6}
          className="w-auto border-0 bg-transparent p-0 shadow-none ring-0"
        >
          <ThemeColorPicker
            value={value}
            backgroundColor={backgroundColor}
            presets={presets}
            onChange={onChange}
            onAddPreset={onAddPreset}
          />
        </PopoverContent>
      </Popover>
    </Field>
  );
}

const ThemePreview = memo(function ThemePreview({
  settings,
  variant,
  markdown,
  onMarkdownChange,
}: {
  settings: ThemeSettings;
  variant: ThemeVariant;
  markdown: string;
  onMarkdownChange: (value: string) => void;
}) {
  // A scoped, themed slice of the real app: the actual MarkdownEditor renders
  // the shared sample, flanked by a sidebar of real controls. data-theme +
  // the mirrored --color-* tokens (themePreviewStyle) make this render in its
  // own variant without touching the document root.
  return (
    <div
      data-theme={variant}
      style={themePreviewStyle(settings, variant)}
      className="overflow-hidden rounded-lg border border-border bg-background text-foreground"
    >
      <div className="flex items-center justify-between gap-3 border-b border-border bg-muted/40 px-3 py-2">
        <span className="text-sm font-semibold">
          {variant === "light" ? "Day" : "Night"}
        </span>
        <Badge variant="outline">{settings.radius}px radius</Badge>
      </div>
      <div className="grid gap-3 p-3 lg:grid-cols-[minmax(0,1fr)_13rem]">
        <MarkdownEditor
          value={markdown}
          onChange={onMarkdownChange}
          minRows={8}
          placeholder="Edit this sample to test your theme…"
        />
        <aside className="flex flex-col gap-2 font-serif">
          <InfoboxCard
            title={PREVIEW_INFOBOX.title}
            subtitle={PREVIEW_INFOBOX.subtitle}
            groups={PREVIEW_INFOBOX.groups}
          />
        </aside>
      </div>
    </div>
  );
});

export function Settings({ settings, onChange }: SettingsProps) {
  const [savedColorSwatches, setSavedColorSwatches] =
    useState(loadColorSwatches);
  const colorSwatches = useMemo(
    () => [...new Set([...DEFAULT_COLOR_SWATCHES, ...savedColorSwatches])],
    [savedColorSwatches],
  );
  const saveColorSwatch = useCallback((hex: string) => {
    setSavedColorSwatches((current) => {
      if (current.includes(hex)) return current;
      const next = [...current, hex];
      try {
        window.localStorage.setItem(COLOR_SWATCHES_KEY, JSON.stringify(next));
      } catch {
        // Storage may be disabled; retain the swatch for this session.
      }
      return next;
    });
  }, []);

  const updateFont = useCallback(
    (key: "articleFont" | "uiFont" | "fixedFont", value: string) => {
      onChange({ ...settings, [key]: value });
    },
    [onChange, settings],
  );

  const updateColor = useCallback(
    (variant: ThemeVariant, key: keyof ThemePalette, value: string) => {
      onChange(withColorChange(settings, variant, key, value));
    },
    [onChange, settings],
  );

  const paletteIsDefault = useCallback(
    (variant: ThemeVariant) =>
      paletteFields.every(
        (field) =>
          settings[variant][field.key] ===
          DEFAULT_THEME_SETTINGS[variant][field.key],
      ),
    [settings],
  );

  const resetPalette = useCallback(
    (variant: ThemeVariant) => {
      onChange(
        withPaletteReset(settings, variant, DEFAULT_THEME_SETTINGS[variant]),
      );
    },
    [onChange, settings],
  );

  // Editable sample content shared by both preview panels, persisted locally so
  // experiments survive reloads.
  const [previewMarkdown, setPreviewMarkdown] = useState(loadPreviewMarkdown);
  useEffect(() => {
    const timeout = window.setTimeout(() => {
      try {
        window.localStorage.setItem(PREVIEW_MARKDOWN_KEY, previewMarkdown);
      } catch {
        // Storage may be disabled; the in-memory sample still works.
      }
    }, 200);
    return () => window.clearTimeout(timeout);
  }, [previewMarkdown]);

  const selectedPreset = findPreset(settings, settings.presetId);
  const selectedIsCustom = !isStockPreset(settings.presetId);
  // The `items` prop feeds the trigger's label lookup; include the user's
  // custom themes so a selected custom shows its name rather than a blank
  // trigger.
  const presetSelectItems = [
    ...presetItems,
    ...settings.customThemes.map((theme) => ({
      label: theme.name,
      value: theme.id,
    })),
  ];

  const duplicateAsCustom = useCallback(() => {
    const base = selectedPreset;
    const name = base ? `${base.name} copy` : "Custom theme";
    onChange(
      createCustomTheme(
        settings,
        name,
        base?.description ?? "Your custom palette.",
      ).settings,
    );
  }, [onChange, selectedPreset, settings]);

  const deleteCurrentCustom = useCallback(() => {
    onChange(deleteCustomTheme(settings, settings.presetId));
  }, [onChange, settings]);

  const exportCurrentTheme = useCallback(() => {
    const name = selectedPreset?.name ?? "Custom theme";
    const json = serializeTheme(
      name,
      selectedPreset?.description ?? "",
      settings.light,
      settings.dark,
    );
    const blob = new Blob([json], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `${name.replace(/[^\w.-]+/g, "-").toLowerCase() || "theme"}.json`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  }, [selectedPreset, settings]);

  const [importOpen, setImportOpen] = useState(false);
  const [importText, setImportText] = useState("");
  const [importError, setImportError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const runImport = useCallback(
    (text: string) => {
      const shared = parseSharedTheme(text);
      if (!shared) {
        setImportError("That doesn't look like an exported Halupedia theme.");
        return;
      }
      onChange(importSharedTheme(settings, shared).settings);
      setImportText("");
      setImportError(null);
      setImportOpen(false);
    },
    [onChange, settings],
  );

  return (
    <section className="mx-auto flex w-full max-w-7xl flex-col gap-3 font-sans">
      <header className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h1 className="font-serif text-2xl leading-tight font-semibold">
          Appearance
        </h1>
        <p className="text-sm text-muted-foreground">
          Type, radius, and paired day/night colors — applied immediately and
          saved in this browser.
        </p>
      </header>

      <div className="grid gap-3 lg:grid-cols-[minmax(0,0.75fr)_minmax(0,1.25fr)]">
        <Card size="sm">
          <CardHeader>
            <CardTitle>Theme</CardTitle>
            <CardDescription>
              Start from a paired preset, then tune either palette.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <FieldGroup className="gap-3">
              <Field>
                <div>
                  <FieldLabel htmlFor="theme-preset">Preset</FieldLabel>
                  <FieldDescription>
                    {selectedPreset?.description ?? "Your modified palette."}
                  </FieldDescription>
                </div>
                <Select
                  items={presetSelectItems}
                  value={settings.presetId}
                  onValueChange={(value) => {
                    if (value == null) return;
                    const stock = THEME_PRESETS.find(
                      (candidate) => candidate.id === value,
                    );
                    if (stock) {
                      onChange(settingsFromPreset(stock, settings));
                      return;
                    }
                    // A custom theme: load its stored palette into the active slot.
                    const custom = settings.customThemes.find(
                      (theme) => theme.id === value,
                    );
                    if (custom) {
                      onChange({
                        ...settings,
                        presetId: custom.id,
                        light: { ...custom.light },
                        dark: { ...custom.dark },
                      });
                    }
                  }}
                >
                  <SelectTrigger id="theme-preset" className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent
                    alignItemWithTrigger={false}
                    className="max-h-80"
                  >
                    {settings.customThemes.length > 0 && (
                      <SelectGroup>
                        <SelectLabel>Custom</SelectLabel>
                        {settings.customThemes.map((theme) => (
                          <SelectItem key={theme.id} value={theme.id}>
                            {theme.name}
                          </SelectItem>
                        ))}
                      </SelectGroup>
                    )}
                    {THEME_PRESET_GROUPS.map((group) => (
                      <SelectGroup key={group.category}>
                        <SelectLabel>{group.category}</SelectLabel>
                        {group.presets.map((preset) => (
                          <SelectItem key={preset.id} value={preset.id}>
                            {preset.name}
                          </SelectItem>
                        ))}
                      </SelectGroup>
                    ))}
                  </SelectContent>
                </Select>
                {selectedIsCustom && (
                  <div className="flex flex-col gap-2 rounded-md border border-border bg-muted/30 p-2.5">
                    <Field>
                      <FieldLabel htmlFor="custom-theme-name">Name</FieldLabel>
                      <Input
                        id="custom-theme-name"
                        value={selectedPreset?.name ?? ""}
                        onChange={(event) =>
                          onChange(
                            updateCustomMeta(settings, {
                              name: event.currentTarget.value,
                            }),
                          )
                        }
                        placeholder="My theme"
                        className="h-8"
                      />
                    </Field>
                    <Field>
                      <FieldLabel htmlFor="custom-theme-description">
                        Description
                      </FieldLabel>
                      <Textarea
                        id="custom-theme-description"
                        value={selectedPreset?.description ?? ""}
                        onChange={(event) =>
                          onChange(
                            updateCustomMeta(settings, {
                              description: event.currentTarget.value,
                            }),
                          )
                        }
                        placeholder="A short note about this theme."
                        rows={2}
                        className="min-h-0 resize-none text-sm"
                      />
                    </Field>
                  </div>
                )}
                <div className="flex flex-wrap items-center gap-1.5">
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={duplicateAsCustom}
                  >
                    <CopyPlusIcon />
                    Duplicate
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={exportCurrentTheme}
                  >
                    <DownloadIcon />
                    Export
                  </Button>
                  <Popover open={importOpen} onOpenChange={setImportOpen}>
                    <PopoverTrigger
                      render={
                        <Button type="button" variant="outline" size="sm">
                          <UploadIcon />
                          Import
                        </Button>
                      }
                    />
                    <PopoverContent className="flex w-80 flex-col gap-2">
                      <p className="text-sm font-medium">Import a theme</p>
                      <FieldDescription>
                        Paste exported theme JSON, or load a .json file. It's
                        added as a new custom theme.
                      </FieldDescription>
                      <Textarea
                        value={importText}
                        onChange={(event) => {
                          setImportText(event.currentTarget.value);
                          setImportError(null);
                        }}
                        placeholder='{ "halupedia": "theme", … }'
                        rows={5}
                        className="resize-none font-mono text-xs"
                        aria-invalid={importError != null}
                      />
                      {importError && (
                        <p className="text-xs text-destructive">
                          {importError}
                        </p>
                      )}
                      <input
                        ref={fileInputRef}
                        type="file"
                        accept="application/json,.json"
                        className="hidden"
                        onChange={(event) => {
                          const file = event.currentTarget.files?.[0];
                          event.currentTarget.value = "";
                          if (!file) return;
                          file
                            .text()
                            .then((text) => runImport(text))
                            .catch(() =>
                              setImportError("Couldn't read that file."),
                            );
                        }}
                      />
                      <div className="flex items-center justify-end gap-1.5">
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          onClick={() => fileInputRef.current?.click()}
                        >
                          Choose file…
                        </Button>
                        <Button
                          type="button"
                          size="sm"
                          disabled={!importText.trim()}
                          onClick={() => runImport(importText)}
                        >
                          Import
                        </Button>
                      </div>
                    </PopoverContent>
                  </Popover>
                  {selectedIsCustom && (
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-sm"
                      aria-label="Delete custom theme"
                      title="Delete custom theme"
                      className="ml-auto text-muted-foreground"
                      onClick={deleteCurrentCustom}
                    >
                      <Trash2Icon />
                    </Button>
                  )}
                </div>
              </Field>
              <Field>
                <div>
                  <FieldTitle id="appearance-mode-label">Site mode</FieldTitle>
                  <FieldDescription>
                    System follows the operating system preference.
                  </FieldDescription>
                </div>
                <ToggleGroup
                  value={[settings.mode]}
                  onValueChange={(values) => {
                    const mode = values[0] as ThemeMode | undefined;
                    if (mode) onChange({ ...settings, mode });
                  }}
                  aria-labelledby="appearance-mode-label"
                  variant="outline"
                  spacing={0}
                >
                  <ToggleGroupItem value="system">System</ToggleGroupItem>
                  <ToggleGroupItem value="light">Day</ToggleGroupItem>
                  <ToggleGroupItem value="dark">Night</ToggleGroupItem>
                </ToggleGroup>
              </Field>
              <Field orientation="horizontal">
                <Checkbox
                  id="chat-enabled"
                  checked={settings.chatEnabled}
                  onCheckedChange={(checked) =>
                    onChange({ ...settings, chatEnabled: checked === true })
                  }
                />
                <div>
                  <FieldLabel htmlFor="chat-enabled">Research chat</FieldLabel>
                  <FieldDescription>
                    Shows a floating button on every page for asking questions
                    about the wiki.
                  </FieldDescription>
                </div>
              </Field>
            </FieldGroup>
          </CardContent>
        </Card>

        <Card size="sm">
          <CardHeader>
            <CardTitle>Typography and shape</CardTitle>
            <CardDescription>
              Stable font choices plus one global component radius.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <FieldGroup className="grid gap-3 md:grid-cols-2">
              <FontSelect
                id="article-font"
                label="Article font"
                description="Headlines and long-form copy."
                value={settings.articleFont}
                defaultValue={DEFAULT_THEME_SETTINGS.articleFont}
                onValueChange={(value) => updateFont("articleFont", value)}
              />
              <FontSelect
                id="ui-font"
                label="UI font"
                description="Navigation, forms, and controls."
                value={settings.uiFont}
                defaultValue={DEFAULT_THEME_SETTINGS.uiFont}
                onValueChange={(value) => updateFont("uiFont", value)}
              />
              <FontSelect
                id="fixed-font"
                label="Fixed-width font"
                description="Code, slugs, and tabular details."
                value={settings.fixedFont}
                defaultValue={DEFAULT_THEME_SETTINGS.fixedFont}
                onValueChange={(value) => updateFont("fixedFont", value)}
              />
              <Field>
                <div className="flex items-center justify-between gap-2">
                  <div>
                    <FieldLabel htmlFor="theme-radius">
                      Corner roundness
                    </FieldLabel>
                    <FieldDescription>
                      One knob scales the whole XS–2XL corner system — sharp at
                      0, rounder as it climbs, bigger shapes rounding more.
                    </FieldDescription>
                  </div>
                  <div className="flex items-center gap-1">
                    <Badge variant="secondary">{settings.radius}px</Badge>
                    <ResetButton
                      label="Reset corner roundness"
                      disabled={
                        settings.radius === DEFAULT_THEME_SETTINGS.radius
                      }
                      onReset={() =>
                        onChange({
                          ...settings,
                          radius: DEFAULT_THEME_SETTINGS.radius,
                        })
                      }
                    />
                  </div>
                </div>
                <Slider
                  id="theme-radius"
                  min={0}
                  max={12}
                  step={1}
                  value={settings.radius}
                  onValueChange={(value) =>
                    onChange({ ...settings, radius: Number(value) })
                  }
                  aria-label="Corner roundness"
                />
                {/* Live preview of the derived scale: each swatch is sized to
                    its step and rounded with its own token, so the "bigger
                    shapes, bigger radii" rule is visible as the slider moves. */}
                <div
                  className="mt-1 flex flex-wrap items-end gap-x-3 gap-y-2"
                  aria-hidden
                >
                  {RADIUS_SCALE_PREVIEW.map(({ token, size, label }) => (
                    <div
                      key={label}
                      className="flex flex-col items-center gap-1"
                    >
                      <div
                        className={`${token} ${size} border border-control-border bg-control-surface-strong`}
                      />
                      <span className="font-mono text-[0.58rem] uppercase tracking-wide text-ink-fade">
                        {label}
                      </span>
                    </div>
                  ))}
                </div>
              </Field>
              <Field>
                <div className="flex items-center justify-between gap-2">
                  <div>
                    <FieldLabel htmlFor="theme-font-scale">
                      Type size
                    </FieldLabel>
                    <FieldDescription>
                      Scales every size across the site.
                    </FieldDescription>
                  </div>
                  <div className="flex items-center gap-1">
                    <Badge variant="secondary">
                      {Math.round(settings.fontScale * 100)}%
                    </Badge>
                    <ResetButton
                      label="Reset type size"
                      disabled={
                        settings.fontScale === DEFAULT_THEME_SETTINGS.fontScale
                      }
                      onReset={() =>
                        onChange({
                          ...settings,
                          fontScale: DEFAULT_THEME_SETTINGS.fontScale,
                        })
                      }
                    />
                  </div>
                </div>
                <Slider
                  id="theme-font-scale"
                  min={MIN_FONT_SCALE}
                  max={MAX_FONT_SCALE}
                  step={0.05}
                  value={settings.fontScale}
                  onValueChange={(value) =>
                    onChange({ ...settings, fontScale: Number(value) })
                  }
                  aria-label="Type size"
                />
              </Field>
            </FieldGroup>
          </CardContent>
        </Card>
      </div>

      <Card size="sm">
        <CardHeader>
          <CardTitle>Color scheme</CardTitle>
          <CardDescription>
            Day and night remain visible together. Pickers store OKLCH and show
            their sRGB HEX equivalent.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="grid gap-x-6 gap-y-4 lg:grid-cols-2">
            {(["light", "dark"] as const).map((variant) => (
              <div key={variant} className="flex flex-col gap-3">
                <div className="flex items-center gap-2">
                  <h3 className="text-sm font-semibold whitespace-nowrap">
                    {variant === "light" ? "Day colors" : "Night colors"}
                  </h3>
                  <Separator className="flex-1" />
                  <ResetButton
                    label={`Reset ${variant === "light" ? "day" : "night"} colors`}
                    disabled={paletteIsDefault(variant)}
                    onReset={() => resetPalette(variant)}
                  />
                </div>
                <FieldGroup className="grid gap-2 sm:grid-cols-2">
                  {paletteFields.map((field) => (
                    <ColorField
                      key={field.key}
                      variant={variant}
                      field={field}
                      value={settings[variant][field.key]}
                      backgroundColor={
                        field.key === "background"
                          ? settings[variant].foreground
                          : settings[variant].background
                      }
                      presets={colorSwatches}
                      onChange={(value) =>
                        updateColor(variant, field.key, value)
                      }
                      onAddPreset={saveColorSwatch}
                    />
                  ))}
                </FieldGroup>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>

      <section className="flex flex-col gap-2" aria-labelledby="theme-previews">
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <h2 id="theme-previews" className="text-lg font-semibold">
            Live preview
          </h2>
          <p className="text-sm text-muted-foreground">
            The real editor and controls in day and night together. Edit the
            sample to test your theme — it saves locally.
          </p>
        </div>
        <div className="grid gap-3 lg:grid-cols-2">
          <ThemePreview
            settings={settings}
            variant="light"
            markdown={previewMarkdown}
            onMarkdownChange={setPreviewMarkdown}
          />
          <ThemePreview
            settings={settings}
            variant="dark"
            markdown={previewMarkdown}
            onMarkdownChange={setPreviewMarkdown}
          />
        </div>
      </section>
    </section>
  );
}
