// OKLCH color helpers. Perceptual interpolation is nicer than sRGB because
// the "midpoint" between two node colors stays close to both — mixing
// #e63946 (red-pink) and #457b9d (steel-blue) in sRGB gives a muddy grey,
// but in OKLCH it stays vivid across the arc.

const clamp01 = (n: number) => Math.max(0, Math.min(1, n));

interface Rgb {
  r: number;
  g: number;
  b: number;
}
interface OkLch {
  L: number;
  C: number;
  h: number;
}

function srgbToLinear(v: number): number {
  const s = v / 255;
  return s <= 0.04045 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
}

function linearToSrgb(v: number): number {
  const s = v <= 0.0031308 ? 12.92 * v : 1.055 * Math.pow(v, 1 / 2.4) - 0.055;
  return Math.round(clamp01(s) * 255);
}

/**
 * Parse a #rrggbb / #rgb hex color to sRGB bytes. Falls back to opaque black
 * on garbage input rather than throwing, so a bad theme value can't crash the
 * whole graph render.
 */
export function parseHex(input: string): Rgb {
  const s = input.trim().replace(/^#/, "");
  if (s.length === 3) {
    const r = parseInt(s[0] + s[0], 16);
    const g = parseInt(s[1] + s[1], 16);
    const b = parseInt(s[2] + s[2], 16);
    if ([r, g, b].every(Number.isFinite)) return { r, g, b };
  } else if (s.length === 6) {
    const r = parseInt(s.slice(0, 2), 16);
    const g = parseInt(s.slice(2, 4), 16);
    const b = parseInt(s.slice(4, 6), 16);
    if ([r, g, b].every(Number.isFinite)) return { r, g, b };
  }
  return { r: 0, g: 0, b: 0 };
}

export function toHex({ r, g, b }: Rgb): string {
  const h = (n: number) => n.toString(16).padStart(2, "0");
  return `#${h(r)}${h(g)}${h(b)}`;
}

// Straight from https://bottosson.github.io/posts/oklab/. The matrices are the
// direct-composition of the "sRGB → linear → LMS → Oklab" chain — precomputed
// so we don't allocate anything per-color.
export function rgbToOkLab(
  rgb: Rgb,
): { L: number; a: number; b: number } {
  const r = srgbToLinear(rgb.r);
  const g = srgbToLinear(rgb.g);
  const b = srgbToLinear(rgb.b);
  const l = 0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b;
  const m = 0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b;
  const s = 0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b;
  const l_ = Math.cbrt(l);
  const m_ = Math.cbrt(m);
  const s_ = Math.cbrt(s);
  return {
    L: 0.2104542553 * l_ + 0.793617785 * m_ - 0.0040720468 * s_,
    a: 1.9779984951 * l_ - 2.428592205 * m_ + 0.4505937099 * s_,
    b: 0.0259040371 * l_ + 0.7827717662 * m_ - 0.808675766 * s_,
  };
}

export function okLabToRgb(lab: {
  L: number;
  a: number;
  b: number;
}): Rgb {
  const l_ = lab.L + 0.3963377774 * lab.a + 0.2158037573 * lab.b;
  const m_ = lab.L - 0.1055613458 * lab.a - 0.0638541728 * lab.b;
  const s_ = lab.L - 0.0894841775 * lab.a - 1.291485548 * lab.b;
  const l = l_ * l_ * l_;
  const m = m_ * m_ * m_;
  const s = s_ * s_ * s_;
  const r =
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s;
  const g =
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s;
  const b = -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s;
  return { r: linearToSrgb(r), g: linearToSrgb(g), b: linearToSrgb(b) };
}

export function rgbToOkLch(rgb: Rgb): OkLch {
  const { L, a, b } = rgbToOkLab(rgb);
  const C = Math.sqrt(a * a + b * b);
  let h = (Math.atan2(b, a) * 180) / Math.PI;
  if (h < 0) h += 360;
  return { L, C, h };
}

export function okLchToRgb({ L, C, h }: OkLch): Rgb {
  const rad = (h * Math.PI) / 180;
  return okLabToRgb({ L, a: C * Math.cos(rad), b: C * Math.sin(rad) });
}

/**
 * Interpolate two OKLCH colors along the shorter hue arc. `t` is clamped to
 * [0, 1] so callers can feed unclamped ratios without pre-guarding.
 */
export function mixOkLch(aHex: string, bHex: string, t: number): string {
  const tt = clamp01(t);
  const a = rgbToOkLch(parseHex(aHex));
  const b = rgbToOkLch(parseHex(bHex));
  let dh = b.h - a.h;
  if (dh > 180) dh -= 360;
  else if (dh < -180) dh += 360;
  const h = a.h + dh * tt;
  const L = a.L + (b.L - a.L) * tt;
  // If either endpoint is (near-)grey, ramp chroma linearly — otherwise the
  // hue interpolation of one endpoint alone would swing the ramp visibly.
  const C = a.C + (b.C - a.C) * tt;
  return toHex(okLchToRgb({ L, C, h: ((h % 360) + 360) % 360 }));
}

/**
 * Mix `color` toward `neutral` by (1 - intensity). Used to fade a gradient
 * edge back to the neutral link tint at low intensity settings.
 */
export function fadeTowardNeutral(
  color: string,
  neutral: string,
  intensity: number,
): string {
  return mixOkLch(neutral, color, clamp01(intensity));
}
