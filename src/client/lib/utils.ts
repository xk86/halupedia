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
