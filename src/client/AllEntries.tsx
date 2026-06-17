import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import MarkdownIt from "markdown-it";
import { toWikiSegment } from "./wikiPath";

const titleMarkdown = new MarkdownIt({
  html: false,
  linkify: false,
  typographer: false,
});

interface IndexItem {
  slug: string;
  canonicalSlug?: string;
  title: string;
  summaryMarkdown?: string;
  generatedAt: number | null;
}

interface IndexResponse {
  items: IndexItem[];
  cursor: string | null;
  complete: boolean;
  total: number | null;
}

interface Props {
  onNavigate: (slugOrTitleSegment: string, explicitTitle?: string) => void;
}

export function renderEntryTitleHtml(title: string): string {
  return titleMarkdown.renderInline(title);
}

export function plainEntryTitle(title: string): string {
  const html = renderEntryTitleHtml(title);
  if (typeof document === "undefined") {
    return html
      .replace(/<[^>]+>/g, "")
      .replace(/\s+/g, " ")
      .trim();
  }
  const el = document.createElement("span");
  el.innerHTML = html;
  return (el.textContent ?? "").replace(/\s+/g, " ").trim();
}

export function entryTitleSortKey(title: string): string {
  return plainEntryTitle(title)
    .replace(/^the\s+/i, "")
    .trim();
}

export function entryTitleWikiPath(title: string): string {
  return `/wiki/${entryTitleWikiSegment(title)}`;
}

export function entryTitleWikiSegment(title: string): string {
  return toWikiSegment(plainEntryTitle(title));
}

function entryGroupKey(title: string): string {
  const key = entryTitleSortKey(title);
  const [first = "·"] = Array.from(key);
  return first.toLocaleUpperCase();
}

function compareEntries(a: IndexItem, b: IndexItem): number {
  const aKey = entryTitleSortKey(a.title);
  const bKey = entryTitleSortKey(b.title);
  return (
    aKey.localeCompare(bKey, undefined, {
      sensitivity: "base",
      numeric: true,
    }) ||
    plainEntryTitle(a.title).localeCompare(
      plainEntryTitle(b.title),
      undefined,
      { sensitivity: "base", numeric: true },
    ) ||
    a.slug.localeCompare(b.slug, undefined, { sensitivity: "base" })
  );
}

/** Group items by their leading sort character for a tidy encyclopedia index. */
function groupByLetter(items: IndexItem[]): Map<string, IndexItem[]> {
  const out = new Map<string, IndexItem[]>();
  for (const it of items) {
    const key = entryGroupKey(it.title);
    if (!out.has(key)) out.set(key, []);
    out.get(key)!.push(it);
  }
  return new Map(
    [...out.entries()].sort(([a], [b]) => {
      return a.localeCompare(b);
    }),
  );
}

export function AllEntries({ onNavigate }: Props) {
  const [items, setItems] = useState<IndexItem[]>([]);
  const [complete, setComplete] = useState(false);
  const [total, setTotal] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState("");
  const inflight = useRef(false);

  const fetchPage = useCallback(async () => {
    if (inflight.current) return;
    inflight.current = true;
    setLoading(true);
    try {
      const url = "/api/index?all=1";
      const res = await fetch(url);
      if (!res.ok) throw new Error(`error ${res.status}`);
      const data: IndexResponse = await res.json();
      setItems(data.items);
      setComplete(data.complete);
      if (typeof data.total === "number") setTotal(data.total);
    } catch (e: any) {
      setError(e?.message || "failed to load index");
    } finally {
      inflight.current = false;
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    document.title = "All entries — Halupedia";
    fetchPage();
  }, [fetchPage]);

  const filtered = useMemo(() => {
    const q = filter.trim().toLowerCase();
    const base = [...items].sort(compareEntries);
    if (!q) return base;
    return base.filter((it) => {
      const plainTitle = plainEntryTitle(it.title).toLowerCase();
      return (
        it.title.toLowerCase().includes(q) ||
        plainTitle.includes(q) ||
        it.slug.toLowerCase().includes(q)
      );
    });
  }, [items, filter]);

  const grouped = useMemo(() => groupByLetter(filtered), [filtered]);

  const onLinkClick = useCallback(
    (e: React.MouseEvent<HTMLAnchorElement>, title: string) => {
      if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      e.preventDefault();
      onNavigate(entryTitleWikiSegment(title), plainEntryTitle(title));
    },
    [onNavigate],
  );

  return (
    <div className="max-w-[67dvw] font-serif text-ink">
      <header className="mb-[1.4rem] pb-[0.75rem] [border-bottom:2px_solid_var(--rule)]">
        <h1 className="mx-0 mt-0 mb-[0.4rem] font-serif text-[2.2rem] font-medium tracking-[-0.005em]">
          All entries
        </h1>
        <p className="m-0 text-[0.98rem] leading-[1.5] text-ink-soft italic">
          Every page that has ever been hallucinated, in alphabetical order. New
          entries are dreamt on demand and join this register the moment they
          are written.
        </p>
        <p className="mx-0 mt-[0.6rem] mb-0 font-mono text-[0.78rem] tracking-[0.12em] text-accent uppercase">
          {total === null
            ? "Counting the volumes\u2026"
            : `${total.toLocaleString()} ${
                total === 1 ? "entry" : "entries"
              } catalogued to date.`}
        </p>
      </header>

      <div className="mb-[1.5rem] flex flex-wrap items-center gap-[1rem]">
        <input
          type="search"
          className="min-w-[12rem] flex-1 rounded-[2px] bg-control-surface-soft px-[0.8rem] py-[0.55rem] font-serif text-[1rem] text-ink [border:1px_solid_var(--rule)] focus:[border-color:var(--accent)] focus:bg-input-surface-strong focus:outline-none"
          placeholder="Filter by title or slug…"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          autoFocus
        />
        <span className="font-mono text-[0.78rem] tracking-[0.1em] text-ink-fade uppercase">
          {loading
            ? "\u2014"
            : filter
              ? `${filtered.length} matching`
              : `${filtered.length}${complete ? "" : "+"} loaded`}
        </span>
      </div>

      {error && (
        <div className="mb-[1rem] bg-accent-wash px-[0.8rem] py-[0.6rem] font-mono text-[0.85rem] text-accent [border:1px_solid_var(--accent)]">
          {error}
        </div>
      )}

      {loading ? (
        <p className="my-[1.5rem] font-mono text-[0.85rem] text-ink-fade">
          Compiling the register…
        </p>
      ) : filtered.length === 0 ? (
        <p className="my-[1.5rem] font-mono text-[0.85rem] text-ink-fade">
          {filter
            ? "No entries match that query."
            : "No entries have been hallucinated yet."}
        </p>
      ) : (
        <div className="flex flex-col gap-[1.6rem]">
          {[...grouped.entries()].map(([letter, list]) => (
            <section key={letter} className="[break-inside:avoid]">
              <h2 className="mx-0 mt-0 mb-[0.5rem] pb-[0.2rem] font-serif text-[1.6rem] font-medium tracking-[0.02em] text-accent [border-bottom:1px_solid_var(--rule-soft)]">
                {letter}
              </h2>
              <ul className="m-0 list-none columns-3 [column-gap:2rem] p-0">
                {list.map((it) => (
                  <li
                    key={it.slug}
                    className="mx-0 mt-0 mb-[0.25rem] [break-inside:avoid] text-[0.98rem] leading-[1.4] [overflow-wrap:break-word]"
                  >
                    <a
                      className="pb-[1px] [border-bottom:1px_dotted_var(--accent-border-soft)] hover:[border-bottom:1px_solid_var(--accent-hover)]"
                      href={entryTitleWikiPath(it.title)}
                      onClick={(e) => onLinkClick(e, it.title)}
                      dangerouslySetInnerHTML={{
                        __html: renderEntryTitleHtml(it.title),
                      }}
                    />
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      )}
      {!complete && !loading ? (
        <p className="my-[1.5rem] font-mono text-[0.85rem] text-ink-fade">
          Showing the first {items.length.toLocaleString()} entries.
        </p>
      ) : null}
    </div>
  );
}
