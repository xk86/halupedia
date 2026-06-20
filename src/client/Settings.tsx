import { memo, useCallback, useEffect, useState } from "react";
import { RotateCcwIcon } from "lucide-react";
import { MarkdownEditor } from "./MarkdownEditor";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
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
import { Separator } from "@/components/ui/separator";
import { Slider } from "@/components/ui/slider";
import {
  ToggleGroup,
  ToggleGroupItem,
} from "@/components/ui/toggle-group";
import {
  DEFAULT_THEME_SETTINGS,
  FONT_CATEGORIES,
  FONT_OPTIONS,
  MAX_FONT_SCALE,
  MIN_FONT_SCALE,
  THEME_PRESETS,
  THEME_PRESET_GROUPS,
  hexToOklch,
  oklchToHex,
  settingsFromPreset,
  themePreviewStyle,
  type ThemeMode,
  type ThemePalette,
  type ThemeSettings,
  type ThemeVariant,
} from "./theme";

interface SettingsProps {
  settings: ThemeSettings;
  onChange: (settings: ThemeSettings) => void;
}

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
const DEFAULT_PREVIEW_MARKDOWN = `# The cartographer's quiet index

An article font should stay comfortable over long passages. An [accent link](https://example.com) stays distinct without overwhelming the body text.

## Surfaces and controls

- Muted surfaces, borders, and rules
- Secondary text in the softer foreground
- Inline \`fixed-width: atlas_entry_04\`

> A short quotation shows muted surfaces, borders, and secondary text together.`;

function loadPreviewMarkdown(): string {
  try {
    return window.localStorage.getItem(PREVIEW_MARKDOWN_KEY) ?? DEFAULT_PREVIEW_MARKDOWN;
  } catch {
    return DEFAULT_PREVIEW_MARKDOWN;
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
  onChange,
}: {
  variant: ThemeVariant;
  field: (typeof paletteFields)[number];
  value: string;
  onChange: (value: string) => void;
}) {
  const id = `${variant}-${field.key}`;
  const hex = oklchToHex(value).toUpperCase();
  const [hexDraft, setHexDraft] = useState(hex);
  const validHex = /^#?[0-9A-F]{6}$/i.test(hexDraft);

  useEffect(() => setHexDraft(hex), [hex]);

  return (
    <Field className="gap-1.5" data-invalid={!validHex || undefined}>
      <div className="flex items-center gap-2">
        <div className="min-w-0 flex-1">
          <FieldLabel htmlFor={id}>{field.label}</FieldLabel>
          <FieldDescription>{field.description}</FieldDescription>
        </div>
        <Input
          id={id}
          type="color"
          value={oklchToHex(value)}
          onChange={(event) => onChange(hexToOklch(event.currentTarget.value))}
          className="size-8 shrink-0 p-0.5"
          aria-label={`${variant} ${field.label}`}
        />
      </div>
      <div className="grid grid-cols-[7rem_minmax(0,1fr)] gap-1">
        <Input
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
          className="h-8 font-mono text-xs"
        />
        <Input
          value={value}
          readOnly
          aria-label={`${variant} ${field.label} OKLCH value`}
          className="h-8 font-mono text-[0.7rem]"
        />
      </div>
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
        <aside className="flex flex-col gap-2">
          <Card size="sm">
            <CardHeader>
              <CardTitle className="text-base">Sidebar</CardTitle>
              <CardDescription>Surfaces and controls</CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-2.5">
              <Input placeholder="Search…" />
              <div className="flex flex-wrap gap-1.5">
                <Badge>Primary</Badge>
                <Badge variant="secondary">Muted</Badge>
                <Badge variant="outline">Outline</Badge>
              </div>
              <Separator />
              <div className="grid grid-cols-2 gap-1.5">
                <Button size="sm">Primary</Button>
                <Button size="sm" variant="secondary">
                  Secondary
                </Button>
                <Button size="sm" variant="outline">
                  Outline
                </Button>
                <Button size="sm" variant="destructive">
                  Delete
                </Button>
              </div>
            </CardContent>
          </Card>
        </aside>
      </div>
    </div>
  );
});

export function Settings({ settings, onChange }: SettingsProps) {
  const updateFont = useCallback(
    (key: "articleFont" | "uiFont" | "fixedFont", value: string) => {
      onChange({ ...settings, [key]: value });
    },
    [onChange, settings],
  );

  const updateColor = useCallback(
    (variant: ThemeVariant, key: keyof ThemePalette, value: string) => {
      onChange({
        ...settings,
        presetId: "custom",
        [variant]: { ...settings[variant], [key]: value },
      });
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
      onChange({
        ...settings,
        presetId: "custom",
        [variant]: { ...DEFAULT_THEME_SETTINGS[variant] },
      });
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

  const selectedPreset = THEME_PRESETS.find(
    (preset) => preset.id === settings.presetId,
  );
  // The `items` prop feeds the trigger's label lookup; include "Custom" so a
  // modified palette shows a label rather than a blank trigger.
  const presetSelectItems =
    settings.presetId === "custom"
      ? [{ label: "Custom", value: "custom" }, ...presetItems]
      : presetItems;

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
                    const preset = THEME_PRESETS.find(
                      (candidate) => candidate.id === value,
                    );
                    if (preset) onChange(settingsFromPreset(preset, settings));
                  }}
                >
                  <SelectTrigger id="theme-preset" className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent
                    alignItemWithTrigger={false}
                    className="max-h-80"
                  >
                    {settings.presetId === "custom" && (
                      <SelectGroup>
                        <SelectItem value="custom">Custom</SelectItem>
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
                      Component radius
                    </FieldLabel>
                    <FieldDescription>0px square to 24px round.</FieldDescription>
                  </div>
                  <div className="flex items-center gap-1">
                    <Badge variant="secondary">{settings.radius}px</Badge>
                    <ResetButton
                      label="Reset component radius"
                      disabled={settings.radius === DEFAULT_THEME_SETTINGS.radius}
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
                  max={24}
                  step={1}
                  value={settings.radius}
                  onValueChange={(value) =>
                    onChange({ ...settings, radius: Number(value) })
                  }
                  aria-label="Component radius"
                />
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
                <FieldGroup className="grid gap-3 sm:grid-cols-2">
                  {paletteFields.map((field) => (
                    <ColorField
                      key={field.key}
                      variant={variant}
                      field={field}
                      value={settings[variant][field.key]}
                      onChange={(value) =>
                        updateColor(variant, field.key, value)
                      }
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
