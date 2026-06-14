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
    return html.replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
  }
  const el = document.createElement("span");
  el.innerHTML = html;
  return (el.textContent ?? "").replace(/\s+/g, " ").trim();
}

export function entryTitleSortKey(title: string): string {
  return plainEntryTitle(title).replace(/^the\s+/i, "").trim();
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
    aKey.localeCompare(bKey, undefined, { sensitivity: "base", numeric: true }) ||
    plainEntryTitle(a.title).localeCompare(plainEntryTitle(b.title), undefined, { sensitivity: "base", numeric: true }) ||
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
    })
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
    return base.filter(
      (it) => {
        const plainTitle = plainEntryTitle(it.title).toLowerCase();
        return (
          it.title.toLowerCase().includes(q) ||
          plainTitle.includes(q) ||
          it.slug.toLowerCase().includes(q)
        );
      }
    );
  }, [items, filter]);

  const grouped = useMemo(() => groupByLetter(filtered), [filtered]);

  const onLinkClick = useCallback(
    (e: React.MouseEvent<HTMLAnchorElement>, title: string) => {
      if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      e.preventDefault();
      onNavigate(entryTitleWikiSegment(title), plainEntryTitle(title));
    },
    [onNavigate]
  );

  return (
    <div className="all-entries">
      <header className="all-entries-header">
        <h1>All entries</h1>
        <p className="all-entries-subtitle">
          Every page that has ever been hallucinated, in alphabetical order.
          New entries are dreamt on demand and join this register the moment
          they are written.
        </p>
        <p className="all-entries-total">
          {total === null
            ? "Counting the volumes\u2026"
            : `${total.toLocaleString()} ${
                total === 1 ? "entry" : "entries"
              } catalogued to date.`}
        </p>
      </header>

      <div className="all-entries-toolbar">
        <input
          type="search"
          className="all-entries-search"
          placeholder="Filter by title or slug…"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          autoFocus
        />
        <span className="all-entries-count">
          {loading
            ? "\u2014"
            : filter
            ? `${filtered.length} matching`
            : `${filtered.length}${complete ? "" : "+"} loaded`}
        </span>
      </div>

      {error && <div className="all-entries-error">{error}</div>}

      {loading ? (
        <p className="all-entries-status">Compiling the register…</p>
      ) : filtered.length === 0 ? (
        <p className="all-entries-empty">
          {filter
            ? "No entries match that query."
            : "No entries have been hallucinated yet."}
        </p>
      ) : (
        <div className="all-entries-groups">
          {[...grouped.entries()].map(([letter, list]) => (
            <section key={letter} className="all-entries-group">
              <h2 className="all-entries-letter">{letter}</h2>
              <ul className="all-entries-list">
                {list.map((it) => (
                  <li key={it.slug}>
                    <a
                      href={entryTitleWikiPath(it.title)}
                      onClick={(e) => onLinkClick(e, it.title)}
                      dangerouslySetInnerHTML={{ __html: renderEntryTitleHtml(it.title) }}
                    />
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      )}
      {!complete && !loading ? (
        <p className="all-entries-status">
          Showing the first {items.length.toLocaleString()} entries.
        </p>
      ) : null}
    </div>
  );
}
