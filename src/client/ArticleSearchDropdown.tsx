import { useState, type ReactNode } from "react";
import clsx from "clsx";
import { useArticleSuggestions, type Suggestion } from "@/articleSuggest";

export type { Suggestion };

/**
 * The single article search-with-suggestions widget reused across the app
 * (header search, graph pickers, …). It owns its open/close state and the
 * shared `useArticleSuggestions` hook; the query itself stays controlled so
 * each caller can react to picks/submits. Render an input plus a parchment
 * suggestion popover with scroll-to-load-more.
 *
 * Callers that need extra chrome (a form + submit button, a "Go to: <literal>"
 * action) wrap this and pass `leading` for the optional sticky first row.
 */

const INPUT =
  "box-border w-full rounded-[2px] bg-input-surface px-[0.55rem] py-[0.35rem] font-serif text-[0.95rem] text-ink outline-none [border:1px_solid_var(--rule)] [transition:border-color_120ms_ease,background_120ms_ease] focus:bg-input-surface-focus focus:[border-color:var(--accent)]";

const ITEM =
  "block w-full cursor-pointer border-none bg-transparent px-[0.6rem] py-[0.45rem] text-left font-serif text-[0.92rem] text-ink [transition:background_80ms_ease] hover:bg-blockquote-bg";

interface ArticleSearchDropdownProps {
  query: string;
  onQueryChange: (q: string) => void;
  /** Called when a suggested (existing) article is chosen. */
  onPick: (s: Suggestion) => void;
  placeholder?: string;
  autoFocus?: boolean;
  inputType?: "search" | "text";
  /** Extra classes for the relative wrapper (e.g. flex sizing). */
  wrapClassName?: string;
  /** Extra classes appended to the input. */
  inputClassName?: string;
  /** Optional sticky first row, e.g. the header's "Go to: <typed text>". */
  leading?: { label: ReactNode; onSelect: () => void };
  /**
   * Optional per-item preview rendered under the title (e.g. a summary). When
   * omitted the rows are compact (the "quick" dropdown); when provided they are
   * taller "previewed" rows — same component, different flag.
   */
  renderPreview?: (item: Suggestion) => ReactNode;
}

export function ArticleSearchDropdown({
  query,
  onQueryChange,
  onPick,
  placeholder,
  autoFocus,
  inputType = "search",
  wrapClassName,
  inputClassName,
  leading,
  renderPreview,
}: ArticleSearchDropdownProps) {
  const [open, setOpen] = useState(false);
  const { items, hasMore, loading, loadMore } = useArticleSuggestions(query);

  const show = open && !!query.trim() && (!!leading || items.length > 0);

  return (
    <div className={clsx("relative", wrapClassName)}>
      <input
        type={inputType}
        className={clsx(INPUT, inputClassName)}
        placeholder={placeholder}
        value={query}
        autoFocus={autoFocus}
        onChange={(e) => {
          onQueryChange(e.target.value);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        // Delay so an item's onMouseDown handler runs before the list unmounts.
        onBlur={() => setTimeout(() => setOpen(false), 150)}
      />
      {show && (
        <ul
          className="absolute top-full right-0 left-0 z-10 m-0 mt-[2px] max-h-[18rem] list-none overflow-y-auto bg-parchment p-0 [box-shadow:0_4px_12px_var(--shadow-soft)] [border:1px_solid_var(--rule)]"
          onScroll={(e) => {
            const el = e.currentTarget;
            if (el.scrollHeight - el.scrollTop - el.clientHeight < 60)
              loadMore();
          }}
        >
          {leading && (
            <li className="sticky top-0 bg-parchment [border-bottom:1px_solid_var(--rule)]">
              <button
                type="button"
                className={ITEM}
                onMouseDown={(e) => {
                  e.preventDefault();
                  leading.onSelect();
                }}
              >
                {leading.label}
              </button>
            </li>
          )}
          {items.map((s) => (
            <li key={s.slug}>
              <button
                type="button"
                className={ITEM}
                onMouseDown={(e) => {
                  e.preventDefault();
                  onPick(s);
                }}
              >
                {renderPreview ? (
                  <span className="block">
                    <span className="block">{s.title}</span>
                    <span className="mt-[0.15rem] block text-[0.78rem] text-ink-fade">
                      {renderPreview(s)}
                    </span>
                  </span>
                ) : (
                  s.title
                )}
              </button>
            </li>
          ))}
          {hasMore && (
            <li className="px-[0.6rem] py-[0.4rem] text-center font-serif text-[0.8rem] text-[var(--muted,#888)]">
              {loading ? "Loading…" : "Scroll for more"}
            </li>
          )}
        </ul>
      )}
    </div>
  );
}
