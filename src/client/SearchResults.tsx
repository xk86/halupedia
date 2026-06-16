import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { toWikiSegment } from "./wikiPath";

/** Section heading with an optional count badge. */
function SectionTitle({
  children,
  count,
}: {
  children: ReactNode;
  count?: number;
}) {
  return (
    <h2 className="mx-0 mt-0 mb-[0.5rem] flex items-baseline gap-[0.5rem] pb-[0.25rem] font-serif text-[1.2rem] font-medium text-ink-soft [border-bottom:1px_solid_var(--rule-soft)]">
      {children}
      {count !== undefined && (
        <span className="font-mono text-[0.7rem] font-normal tracking-[0.1em] text-ink-fade">
          {count}
        </span>
      )}
    </h2>
  );
}

interface SearchItem {
  slug: string;
  title: string;
  summary?: string;
  exists: boolean;
}

interface Suggestion {
  slug: string;
  title: string;
  summary: string;
}

interface SearchResponse {
  query: string;
  results: SearchItem[];
  suggestions: Suggestion[];
  existing_count: number;
  hallucinated_count: number;
  rate_limited: boolean;
  retry_after: number | null;
}

interface Props {
  q: string;
  onNavigate: (slug: string) => void;
  onSearch: (q: string) => void;
}

export function SearchResults({ q, onNavigate, onSearch }: Props) {
  const [data, setData] = useState<SearchResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState(q);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    setDraft(q);
  }, [q]);

  useEffect(() => {
    abortRef.current?.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    setLoading(true);
    setError(null);

    (async () => {
      try {
        const url = q
          ? `/api/search?q=${encodeURIComponent(q)}`
          : "/api/search";
        const res = await fetch(url, { signal: ctrl.signal });
        if (!res.ok) {
          const j: any = await res.json().catch(() => ({}));
          throw new Error(j?.error || `error ${res.status}`);
        }
        const j: SearchResponse = await res.json();
        if (ctrl.signal.aborted) return;
        setData(j);
        setLoading(false);
      } catch (e: any) {
        if (ctrl.signal.aborted || e?.name === "AbortError") return;
        setError(e?.message || "search failed");
        setLoading(false);
      }
    })();

    return () => ctrl.abort();
  }, [q]);

  useEffect(() => {
    document.title = q ? `Search: ${q} — Halupedia` : "Search — Halupedia";
  }, [q]);

  const onSubmit = useCallback(
    (e: React.FormEvent) => {
      e.preventDefault();
      const trimmed = draft.trim();
      if (!trimmed) return;
      onSearch(trimmed);
    },
    [draft, onSearch],
  );

  const onLinkClick = useCallback(
    (e: React.MouseEvent<HTMLAnchorElement>, slug: string) => {
      if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      e.preventDefault();
      onNavigate(slug);
    },
    [onNavigate],
  );

  const { existingResults, unwrittenResults } = useMemo(() => {
    const e: SearchItem[] = [];
    const u: SearchItem[] = [];
    for (const r of data?.results ?? []) {
      (r.exists ? e : u).push(r);
    }
    return { existingResults: e, unwrittenResults: u };
  }, [data]);

  const suggestions = data?.suggestions ?? [];

  return (
    <div className="mt-[0.5rem]">
      <header>
        <h1 className="mx-0 mt-0 mb-[0.5rem] pb-[0.4rem] font-serif text-[2rem] font-medium [border-bottom:2px_solid_var(--rule)]">
          Search
        </h1>
        <p className="mx-0 mt-0 mb-[1.25rem] font-serif text-ink-soft italic">
          Existing entries are listed first. The rest are plausible titles the
          encyclopedia hasn't yet committed to paper — click one and it will be
          dreamt up on the spot.
        </p>
      </header>

      <form className="mb-[1.25rem] flex gap-[0.5rem]" onSubmit={onSubmit}>
        <input
          type="search"
          className="search-input"
          placeholder="Search Halupedia…"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          maxLength={100}
          autoFocus
        />
        <button
          type="submit"
          className="search-submit"
          disabled={!draft.trim()}
        >
          Search
        </button>
      </form>

      {q && (
        <div className="search-goto mb-[1.2em] rounded-[4px] bg-blockquote-bg px-[0.8em] py-[0.6em] text-[0.95rem] [border:1px_solid_var(--rule)]">
          Go to{" "}
          <a
            className="font-semibold text-accent no-underline hover:text-accent-hover hover:underline"
            href={`/wiki/${toWikiSegment(q)}`}
            onClick={(e) => onLinkClick(e, toWikiSegment(q))}
          >
            {q}
          </a>
        </div>
      )}

      {error && <div className="search-error">{error}</div>}

      {q && loading && (
        <p className="search-status">
          <span className="dot" /> Consulting the index and hallucinating
          alternatives…
        </p>
      )}

      {q && data && !loading && (
        <>
          {data.rate_limited && (
            <div className="mx-0 mt-0 mb-[1.25rem] bg-panel-surface-soft px-[0.9rem] py-[0.7rem] font-serif text-[0.95rem] text-ink-soft italic [border-left:3px_solid_var(--rule)]">
              You've hit the search-suggestion rate limit. Showing only entries
              already in the encyclopedia — no new hallucinations this round.
              Try again later.
            </div>
          )}

          {data.results.length === 0 ? (
            <p className="my-[1rem] font-serif text-ink-fade italic">
              Nothing in the register, and the encyclopedia declines to invent
              anything new right now.
            </p>
          ) : (
            <div className="search-results">
              {existingResults.length > 0 && (
                <section>
                  <SectionTitle count={existingResults.length}>
                    In the encyclopedia
                  </SectionTitle>
                  <ul className="search-list">
                    {existingResults.map((r) => (
                      <li key={r.slug} className="search-item">
                        <a
                          href={`/wiki/${toWikiSegment(r.title)}`}
                          onClick={(e) =>
                            onLinkClick(e, toWikiSegment(r.title))
                          }
                        >
                          {r.title}
                        </a>
                        {r.summary && <p>{r.summary}</p>}
                      </li>
                    ))}
                  </ul>
                </section>
              )}

              {unwrittenResults.length > 0 && (
                <section>
                  <SectionTitle count={unwrittenResults.length}>
                    Not yet written
                  </SectionTitle>
                  <ul className="search-list">
                    {unwrittenResults.map((r) => (
                      <li key={r.slug} className="search-item">
                        <a
                          className="group text-ink-fade italic [border-bottom:1px_dashed_var(--accent-border-soft)] hover:[border-bottom-color:var(--accent-hover)] hover:text-accent-hover"
                          href={`/wiki/${toWikiSegment(r.title)}`}
                          onClick={(e) =>
                            onLinkClick(e, toWikiSegment(r.title))
                          }
                          title="Not yet written — clicking will hallucinate it"
                        >
                          <span
                            className="mr-[0.35rem] inline-block w-[1rem] text-center text-[0.85em] text-[var(--rule)] not-italic group-hover:text-[var(--accent-hover)]"
                            aria-hidden
                          >
                            ✦
                          </span>
                          {r.title}
                        </a>
                      </li>
                    ))}
                  </ul>
                </section>
              )}
            </div>
          )}
        </>
      )}

      {suggestions.length > 0 && (
        <section>
          <SectionTitle>
            {q ? "You might also enjoy" : "Random entries"}
          </SectionTitle>
          <ul className="search-list">
            {suggestions.map((s) => (
              <li key={s.slug} className="search-item">
                <a
                  href={`/wiki/${toWikiSegment(s.title)}`}
                  onClick={(e) => onLinkClick(e, toWikiSegment(s.title))}
                >
                  {s.title}
                </a>
                {s.summary && <p>{s.summary}</p>}
              </li>
            ))}
          </ul>
        </section>
      )}

      {!q && !loading && suggestions.length === 0 && (
        <p className="my-[1rem] font-serif text-ink-fade italic">
          Try a name, a place, a century, an obscure ritual — or anything at
          all.
        </p>
      )}
    </div>
  );
}
