import { type ReactNode } from "react";
import clsx from "clsx";

/**
 * Small status pill (formerly .admin-prompt-history-badge + its --save/--revert
 * variants). `variant` keys a color set; unknown variants render the bare pill.
 */
const BASE =
  "rounded-[3px] px-[0.45em] py-[0.1em] text-[0.72rem] font-semibold uppercase tracking-[0.03em]";
const VARIANTS: Record<string, string> = {
  save: "bg-[var(--color-info-bg,#dbeafe)] text-[var(--color-info,#1d4ed8)]",
  revert:
    "bg-[var(--color-warn-bg,#fff3cd)] text-[var(--color-warn-text,#92400e)]",
};

export function StatusBadge({
  variant,
  children,
}: {
  variant?: string;
  children: ReactNode;
}) {
  return (
    <span className={clsx(BASE, variant && VARIANTS[variant])}>{children}</span>
  );
}
