import { type ButtonHTMLAttributes } from "react";
import clsx from "clsx";

/**
 * The shared admin button (formerly the .admin-btn / .admin-btn--small /
 * .admin-danger-btn / .all-entries-more-btn classes). Colors are a
 * mutually-exclusive group so a variant never leaves a competing
 * background/border utility:
 *   default — subtle control-surface chrome
 *   primary — solid ink/parchment (the prominent action button)
 *   danger  — solid danger
 */
const BASE =
  "inline-flex cursor-pointer items-center gap-[0.3rem] rounded-[3px] px-[0.65rem] py-[0.28rem] font-mono text-[0.8rem] disabled:cursor-not-allowed disabled:opacity-50";
const SMALL = "px-[0.45rem] py-[0.15rem] text-[0.72rem]";
const COLORS = {
  default:
    "bg-control-surface text-ink [border:1px_solid_var(--control-border)] hover:not-disabled:bg-control-surface-strong",
  primary:
    "bg-ink text-parchment [border:1px_solid_var(--ink)] hover:not-disabled:bg-accent hover:not-disabled:[border-color:var(--accent)]",
  danger:
    "bg-danger-alt text-danger-text [border:1px_solid_var(--danger-alt)] hover:not-disabled:bg-danger-hover hover:not-disabled:[border-color:var(--danger-hover)]",
};

interface AdminButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: keyof typeof COLORS;
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
        COLORS[variant],
        className,
      )}
      {...rest}
    />
  );
}
