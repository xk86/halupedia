"use client";

import * as React from "react";
import { useColorPickerContext } from "../context";
import { cn } from "@/lib/utils";

export interface GamutBadgeProps extends React.HTMLAttributes<HTMLDivElement> {
  showLabel?: boolean;
}

export const GamutBadge = React.forwardRef<HTMLDivElement, GamutBadgeProps>(
  function GamutBadge({ showLabel = true, className, ...rest }, ref) {
    const { gamut } = useColorPickerContext();

    let label = "sRGB";
    if (!gamut.inSrgb && gamut.inP3) label = "P3";
    else if (!gamut.inP3 && gamut.inRec2020) label = "Rec.2020";
    else if (!gamut.inRec2020) label = "Out of gamut";

    return (
      <div
        ref={ref}
        data-slot="color-picker-gamut-badge"
        role="status"
        aria-live="polite"
        title={`Color in ${label} color space`}
        className={cn(
          "inline-flex h-7 w-full cursor-default items-center gap-1.5 rounded-md border border-border bg-muted/30 px-2 text-xs",
          className,
        )}
        {...rest}
      >
        {showLabel ? (
          <span className="text-muted-foreground">Gamut</span>
        ) : null}
        <span className="font-mono font-medium">{label}</span>
      </div>
    );
  },
);
