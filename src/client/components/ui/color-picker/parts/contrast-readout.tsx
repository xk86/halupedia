"use client";

import * as React from "react";
import { useColorPickerContext } from "../context";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

export type ContrastMetric = "wcag" | "apca";

export interface ContrastReadoutProps extends React.HTMLAttributes<HTMLDivElement> {
  metrics?: ContrastMetric[];
  defaultMetric?: ContrastMetric;
  showLabel?: boolean;
  showValue?: boolean;
  showBadges?: boolean;
}

const DEFAULT_METRICS: ContrastMetric[] = ["wcag"];

export const ContrastReadout = React.forwardRef<
  HTMLDivElement,
  ContrastReadoutProps
>(function ContrastReadout(
  {
    metrics = DEFAULT_METRICS,
    defaultMetric,
    showLabel = true,
    showValue = true,
    showBadges = true,
    className,
    ...rest
  },
  ref,
) {
  const { contrast } = useColorPickerContext();
  const initial =
    defaultMetric && metrics.includes(defaultMetric)
      ? defaultMetric
      : metrics[0];
  const [active, setActive] = React.useState<ContrastMetric>(initial);

  if (!metrics.includes(active)) setActive(metrics[0]);

  const togglable = metrics.length > 1;
  const nextMetric = metrics[(metrics.indexOf(active) + 1) % metrics.length];
  const body =
    active === "wcag" ? (
      <WcagBody
        wcag={contrast.wcag}
        aa={contrast.wcagLevel.aaNormal}
        aaa={contrast.wcagLevel.aaaNormal}
        showLabel={showLabel}
        showValue={showValue}
        showBadges={showBadges}
      />
    ) : (
      <ApcaBody
        lc={contrast.apca}
        showLabel={showLabel}
        showValue={showValue}
        showBadges={showBadges}
      />
    );
  const baseClass =
    "flex h-7 w-full items-center gap-1.5 rounded-md border border-border bg-muted/30 px-2 text-xs";

  if (togglable) {
    return (
      <button
        ref={ref as React.Ref<HTMLButtonElement>}
        data-slot="color-picker-contrast-readout"
        type="button"
        onClick={() => setActive(nextMetric)}
        aria-label={`Contrast (${active.toUpperCase()}). Click to switch to ${nextMetric.toUpperCase()}.`}
        title={`Click to switch to ${nextMetric.toUpperCase()}`}
        className={cn(
          baseClass,
          "cursor-pointer text-left transition-colors hover:bg-muted/60 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none",
          className,
        )}
        {...(rest as React.ButtonHTMLAttributes<HTMLButtonElement>)}
      >
        {body}
        <span aria-hidden="true" className="ml-auto text-muted-foreground">
          ⇅
        </span>
      </button>
    );
  }

  return (
    <div
      ref={ref}
      data-slot="color-picker-contrast-readout"
      role="group"
      aria-label="Contrast against background"
      className={cn(baseClass, className)}
      {...rest}
    >
      {body}
    </div>
  );
});

function WcagBody({
  wcag,
  aa,
  aaa,
  showLabel,
  showValue,
  showBadges,
}: {
  wcag: number;
  aa: boolean;
  aaa: boolean;
  showLabel: boolean;
  showValue: boolean;
  showBadges: boolean;
}) {
  return (
    <>
      {showLabel || showValue ? (
        <span className="font-mono font-medium">
          {showLabel ? "WCAG " : ""}
          {showValue ? `${wcag.toFixed(2)}:1` : ""}
        </span>
      ) : null}
      {showBadges ? (
        <span className="flex items-center gap-1">
          <PassBadge ok={aa}>AA</PassBadge>
          <PassBadge ok={aaa}>AAA</PassBadge>
        </span>
      ) : null}
    </>
  );
}

function ApcaBody({
  lc,
  showLabel,
  showValue,
  showBadges,
}: {
  lc: number;
  showLabel: boolean;
  showValue: boolean;
  showBadges: boolean;
}) {
  const magnitude = Math.abs(lc);
  const label =
    magnitude >= 75 ? "headline" : magnitude >= 60 ? "body" : "fail";
  return (
    <>
      {showLabel || showValue ? (
        <span className="font-mono font-medium">
          {showLabel ? "APCA " : ""}
          {showValue ? `Lc ${lc.toFixed(1)}` : ""}
        </span>
      ) : null}
      {showBadges ? <PassBadge ok={label !== "fail"}>{label}</PassBadge> : null}
    </>
  );
}

function PassBadge({
  ok,
  children,
}: {
  ok: boolean;
  children: React.ReactNode;
}) {
  return (
    <Badge
      variant={ok ? "secondary" : "destructive"}
      aria-label={
        typeof children === "string"
          ? `${children} ${ok ? "passes" : "fails"}`
          : undefined
      }
      className="h-4 px-1 text-[0.625rem] uppercase"
    >
      {children}
    </Badge>
  );
}
