import { memo, useCallback, useEffect, useState } from "react";
import { RotateCcwIcon } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
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
import { Slider } from "@/components/ui/slider";
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@/components/ui/tabs";
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

const fontItems = FONT_OPTIONS.map(({ label, value }) => ({ label, value }));
const presetItems = THEME_PRESETS.map(({ id, name }) => ({
  label: name,
  value: id,
}));
function FontSelect({
  id,
  label,
  description,
  value,
  onValueChange,
}: {
  id: string;
  label: string;
  description: string;
  value: string;
  onValueChange: (value: string) => void;
}) {
  return (
    <Field>
      <div>
        <FieldLabel htmlFor={id}>{label}</FieldLabel>
        <FieldDescription>{description}</FieldDescription>
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
}: {
  settings: ThemeSettings;
  variant: ThemeVariant;
}) {
  return (
    <Card size="sm" style={themePreviewStyle(settings, variant)}>
      <CardHeader>
        <div className="flex items-center justify-between gap-3">
          <CardTitle>
            {variant === "light" ? "Day" : "Night"} preview
          </CardTitle>
          <Badge variant="outline">{settings.radius}px radius</Badge>
        </div>
        <CardDescription>
          Every editable token appears in this sample.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <article className="flex flex-col gap-2 font-serif">
          <header className="flex flex-col gap-1">
            <p className="font-mono text-xs tracking-wide text-muted-foreground uppercase">
              Demonstration article
            </p>
            <h2 className="text-2xl leading-tight font-semibold">
              The cartographer&apos;s quiet index
            </h2>
          </header>
          <p>
            An article font should remain comfortable over long passages. The
            <a href="#preview-link" className="ml-1 text-accent underline">
              accent link
            </a>{" "}
            remains distinct without overwhelming the text.
          </p>
          <blockquote className="rounded-md border-l-4 border-primary bg-muted p-3 text-muted-foreground">
            A compact quotation demonstrates muted surfaces, borders, and
            secondary text.
          </blockquote>
          <code className="rounded-md border border-border bg-muted px-2 py-1 font-mono text-sm">
            fixed-width: atlas_entry_04
          </code>
        </article>
        <Field>
          <FieldLabel htmlFor={`${variant}-preview-input`}>
            Interface sample
          </FieldLabel>
          <Input
            id={`${variant}-preview-input`}
            placeholder="Surface and border tokens"
          />
        </Field>
        <div className="flex flex-wrap gap-2 font-sans">
          <Button size="sm">Primary action</Button>
          <Button size="sm" variant="secondary">
            Secondary
          </Button>
          <Button size="sm" variant="destructive">
            Destructive
          </Button>
        </div>
      </CardContent>
    </Card>
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

  const selectedPreset = THEME_PRESETS.find(
    (preset) => preset.id === settings.presetId,
  );
  const displayedPresetItems =
    settings.presetId === "custom"
      ? [{ label: "Custom", value: "custom" }, ...presetItems]
      : presetItems;

  return (
    <section className="mx-auto flex w-full max-w-7xl flex-col gap-4 font-sans">
      <header className="flex flex-col gap-1">
        <Badge variant="outline" className="w-fit">
          Local user settings
        </Badge>
        <h1 className="font-serif text-4xl leading-tight font-semibold">
          Appearance
        </h1>
        <p className="max-w-3xl text-muted-foreground">
          Choose type, radius, and paired day/night colors. Changes apply
          immediately and persist in this browser.
        </p>
      </header>

      <div className="grid gap-4 lg:grid-cols-[minmax(0,0.75fr)_minmax(0,1.25fr)]">
        <Card size="sm">
          <CardHeader>
            <CardTitle>Theme</CardTitle>
            <CardDescription>
              Start from a paired preset, then tune either palette.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <FieldGroup className="gap-4">
              <Field>
                <div>
                  <FieldLabel htmlFor="theme-preset">Preset</FieldLabel>
                  <FieldDescription>
                    {selectedPreset?.description ?? "Your modified palette."}
                  </FieldDescription>
                </div>
                <Select
                  items={displayedPresetItems}
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
                  <SelectContent alignItemWithTrigger={false}>
                    <SelectGroup>
                      {displayedPresetItems.map((item) => (
                        <SelectItem key={item.value} value={item.value}>
                          {item.label}
                        </SelectItem>
                      ))}
                    </SelectGroup>
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
            <FieldGroup className="grid gap-4 md:grid-cols-2">
              <FontSelect
                id="article-font"
                label="Article font"
                description="Headlines and long-form copy."
                value={settings.articleFont}
                onValueChange={(value) => updateFont("articleFont", value)}
              />
              <FontSelect
                id="ui-font"
                label="UI font"
                description="Navigation, forms, and controls."
                value={settings.uiFont}
                onValueChange={(value) => updateFont("uiFont", value)}
              />
              <FontSelect
                id="fixed-font"
                label="Fixed-width font"
                description="Code, slugs, and tabular details."
                value={settings.fixedFont}
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
                  <Badge variant="secondary">{settings.radius}px</Badge>
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
                  <Badge variant="secondary">
                    {Math.round(settings.fontScale * 100)}%
                  </Badge>
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
          <CardFooter>
            <Button
              variant="outline"
              size="sm"
              onClick={() =>
                onChange({
                  ...settings,
                  articleFont: DEFAULT_THEME_SETTINGS.articleFont,
                  uiFont: DEFAULT_THEME_SETTINGS.uiFont,
                  fixedFont: DEFAULT_THEME_SETTINGS.fixedFont,
                  radius: DEFAULT_THEME_SETTINGS.radius,
                  fontScale: DEFAULT_THEME_SETTINGS.fontScale,
                })
              }
            >
              <RotateCcwIcon data-icon="inline-start" />
              Reset type and radius
            </Button>
          </CardFooter>
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
          <Tabs defaultValue="light">
            <TabsList>
              <TabsTrigger value="light">Day colors</TabsTrigger>
              <TabsTrigger value="dark">Night colors</TabsTrigger>
            </TabsList>
            {(["light", "dark"] as const).map((variant) => (
              <TabsContent key={variant} value={variant} className="pt-3">
                <FieldGroup className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
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
              </TabsContent>
            ))}
          </Tabs>
        </CardContent>
      </Card>

      <section className="flex flex-col gap-3" aria-labelledby="theme-previews">
        <div>
          <h2 id="theme-previews" className="text-2xl font-semibold">
            Paired preview
          </h2>
          <p className="text-muted-foreground">
            Day and night render together. Editing never hides the other half.
          </p>
        </div>
        <div className="grid gap-4 lg:grid-cols-2">
          <ThemePreview settings={settings} variant="light" />
          <ThemePreview settings={settings} variant="dark" />
        </div>
      </section>
    </section>
  );
}
