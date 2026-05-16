import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { toWikiSegment } from "./wikiPath";

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
  onNavigate: (slug: string) => void;
}

/** Group items by their leading letter for a tidy A–Z encyclopedia index. */
function groupByLetter(items: IndexItem[]): Map<string, IndexItem[]> {
  const out = new Map<string, IndexItem[]>();
  for (const it of items) {
    const ch = (it.title[0] || "·").toUpperCase();
    const key = /[A-Z]/.test(ch) ? ch : "#";
    if (!out.has(key)) out.set(key, []);
    out.get(key)!.push(it);
  }
  // Sort buckets alphabetically; "#" last.
  return new Map(
    [...out.entries()].sort(([a], [b]) => {
      if (a === "#") return 1;
      if (b === "#") return -1;
      return a.localeCompare(b);
    })
  );
}

export function AllEntries({ onNavigate }: Props) {
  const [items, setItems] = useState<IndexItem[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [complete, setComplete] = useState(false);
  const [total, setTotal] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState("");
  const inflight = useRef(false);

  const fetchPage = useCallback(async (cur: string | null, append: boolean) => {
    if (inflight.current) return;
    inflight.current = true;
    if (append) setLoadingMore(true);
    else setLoading(true);
    try {
      const url = `/api/index?limit=200${cur ? `&cursor=${encodeURIComponent(cur)}` : ""}`;
      const res = await fetch(url);
      if (!res.ok) throw new Error(`error ${res.status}`);
      const data: IndexResponse = await res.json();
      setItems((prev) => {
        if (!append) return data.items;
        // Dedupe by slug in case of overlap.
        const seen = new Set(prev.map((p) => p.slug));
        return [...prev, ...data.items.filter((d) => !seen.has(d.slug))];
      });
      setCursor(data.cursor);
      setComplete(data.complete);
      if (typeof data.total === "number") setTotal(data.total);
    } catch (e: any) {
      setError(e?.message || "failed to load index");
    } finally {
      inflight.current = false;
      setLoading(false);
      setLoadingMore(false);
    }
  }, []);

  useEffect(() => {
    document.title = "All entries — Halupedia";
    fetchPage(null, false);
  }, [fetchPage]);

  const filtered = useMemo(() => {
    const q = filter.trim().toLowerCase();
    const base = [...items].sort((a, b) =>
      a.title.localeCompare(b.title, undefined, { sensitivity: "base" })
    );
    if (!q) return base;
    return base.filter(
      (it) =>
        it.title.toLowerCase().includes(q) ||
        it.slug.toLowerCase().includes(q)
    );
  }, [items, filter]);

  const grouped = useMemo(() => groupByLetter(filtered), [filtered]);

  const onLinkClick = useCallback(
    (e: React.MouseEvent<HTMLAnchorElement>, slug: string) => {
      if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      e.preventDefault();
      onNavigate(slug);
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
                      href={`/wiki/${toWikiSegment(it.title)}`}
                      onClick={(e) => onLinkClick(e, toWikiSegment(it.title))}
                    >
                      {it.title}
                    </a>
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      )}

      {!complete && !loading && (
        <div className="all-entries-more">
          <button
            className="all-entries-more-btn"
            onClick={() => fetchPage(cursor, true)}
            disabled={loadingMore}
          >
            {loadingMore ? "Loading…" : "Load more"}
          </button>
        </div>
      )}
    </div>
  );
}
