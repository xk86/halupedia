import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

/**
 * The shadcn class-name helper: merge conditional clsx input, then dedupe
 * conflicting Tailwind utilities with tailwind-merge. shadcn-generated
 * components import this as `cn`.
 *
 * NOTE: twMerge only understands Tailwind's DEFAULT class names/scale. This
 * project leans on arbitrary values (e.g. px-[0.65rem]) and a custom @theme;
 * those pass through untouched (twMerge won't dedupe two competing arbitrary
 * utilities), which is fine for shadcn components but keep in mind when relying
 * on override behavior.
 */
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/**
 * Inline error-message box: mono accent text on an accent wash, used for
 * fetch/save failures across the search page and admin panes. A plain class
 * string (not a component) so it drops onto whatever element each call site
 * already uses — block <p>/<div> banners or inline <span> status text.
 */
export const ERROR_BOX =
  "my-4 [border:1px_solid_var(--accent-border)] bg-accent-wash px-[0.8rem] py-[0.6rem] font-mono text-[0.85rem] text-accent";
