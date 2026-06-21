import { Root } from "./parts/root";
import { Area } from "./parts/area";
import { Hue } from "./parts/hue";
import { Lightness } from "./parts/lightness";
import { Alpha } from "./parts/alpha";
import { FormatSwitcher } from "./parts/format-switcher";
import { ChannelInput } from "./parts/channel-input";
import { Swatches } from "./parts/swatches";
import { GamutBadge } from "./parts/gamut-badge";
import { ContrastReadout } from "./parts/contrast-readout";
import { EyeDropper } from "./parts/eye-dropper";

export type { ColorFormat, OklchColor } from "./lib/types";

export const ColorPicker = {
  Root,
  Area,
  Hue,
  Lightness,
  Alpha,
  FormatSwitcher,
  ChannelInput,
  Swatches,
  GamutBadge,
  ContrastReadout,
  EyeDropper,
};
