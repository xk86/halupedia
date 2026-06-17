import { type ButtonHTMLAttributes } from "react";
import clsx from "clsx";

/**
 * The shared admin button (formerly the .admin-btn / .admin-btn--small /
 * .admin-danger-btn classes). Colors are picked as a mutually-exclusive group
 * so the danger variant never leaves a competing background/border utility.
 */
const BASE =
  "inline-flex cursor-pointer items-center gap-[0.3rem] rounded-[3px] px-[0.65rem] py-[0.28rem] font-mono text-[0.8rem] disabled:cursor-not-allowed disabled:opacity-50";
const SMALL = "px-[0.45rem] py-[0.15rem] text-[0.72rem]";
const DEFAULT_COLORS =
  "bg-control-surface text-ink [border:1px_solid_var(--control-border)] hover:not-disabled:bg-control-surface-strong";
const DANGER_COLORS =
  "bg-danger-alt text-danger-text [border:1px_solid_var(--danger-alt)] hover:not-disabled:bg-danger-hover hover:not-disabled:[border-color:var(--danger-hover)]";

interface AdminButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: "default" | "danger";
  size?: "default" | "small";
}

export function AdminButton({
  variant = "default",
  size = "default",
  className,
  type = "button",
  ...rest
}: AdminButtonProps) {
  return (
    <button
      type={type}
      className={clsx(
        BASE,
        size === "small" && SMALL,
        variant === "danger" ? DANGER_COLORS : DEFAULT_COLORS,
        className,
      )}
      {...rest}
    />
  );
}
