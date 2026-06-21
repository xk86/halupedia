import { useState } from "react";
import { ColorPicker } from "@/components/ui/color-picker/color-picker";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";

type PickerMode = "oklch-cl" | "oklch-hc";
const CONTRAST_METRICS: Array<"wcag" | "apca"> = ["wcag", "apca"];

interface ThemeColorPickerProps {
  value: string;
  backgroundColor: string;
  presets: string[];
  onChange: (value: string) => void;
  onAddPreset: (hex: string) => void;
}

export function ThemeColorPicker({
  value,
  backgroundColor,
  presets,
  onChange,
  onAddPreset,
}: ThemeColorPickerProps) {
  const [mode, setMode] = useState<PickerMode>("oklch-cl");

  return (
    <ColorPicker.Root
      value={value}
      defaultFormat="p3"
      backgroundColor={backgroundColor}
      onValueChange={(_color, _formatted, formats) => onChange(formats.oklch)}
      className="w-64 max-w-[calc(100vw-2rem)] gap-2 rounded-md p-2"
    >
      <ToggleGroup
        value={[mode]}
        onValueChange={(next) => {
          const selected = next[0] as PickerMode | undefined;
          if (selected) setMode(selected);
        }}
        variant="outline"
        size="sm"
        spacing={1}
        aria-label="Color area mode"
        className="w-full"
      >
        <ToggleGroupItem
          value="oklch-cl"
          className="h-7 min-w-0 flex-1 px-1.5 text-xs"
        >
          Chroma × lightness
        </ToggleGroupItem>
        <ToggleGroupItem
          value="oklch-hc"
          className="h-7 min-w-0 flex-1 px-1.5 text-xs"
        >
          Chroma × hue
        </ToggleGroupItem>
      </ToggleGroup>

      <div className="flex items-stretch gap-1.5">
        <ColorPicker.GamutBadge
          showLabel={false}
          className="w-auto flex-1 justify-center"
        />
        <ColorPicker.ContrastReadout
          metrics={CONTRAST_METRICS}
          showLabel={false}
          showValue={false}
          className="w-auto flex-1 justify-center"
        />
      </div>

      <ColorPicker.Area
        mode={mode}
        resolution={128}
        softProof
        className="h-36"
      />

      <div className="flex flex-col gap-1.5">
        {mode === "oklch-hc" ? <ColorPicker.Lightness /> : <ColorPicker.Hue />}
        <ColorPicker.Alpha />
      </div>

      <div className="flex items-center gap-1.5">
        <ColorPicker.FormatSwitcher className="min-w-0 flex-1" />
        <ColorPicker.EyeDropper className="h-8 w-full flex-1" />
      </div>
      <ColorPicker.ChannelInput showFormat={false} />
      {mode === "oklch-cl" ? (
        <ColorPicker.Swatches
          presets={presets}
          onAdd={(_color, hex) => onAddPreset(hex)}
          className="grid-cols-8"
        />
      ) : null}
    </ColorPicker.Root>
  );
}
