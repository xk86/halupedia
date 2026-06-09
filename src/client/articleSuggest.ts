// ── Article suggestion search (shared) ─────────────────────────────────────
//
// A single source of truth for the scroll-paginated /api/search suggestion
// widget. Used by the graph's seed/waypoint pickers and the global header
// search bar. Keeps only real (exists) articles and exposes a debounced,
// scroll-for-more hook so each consumer only renders the result list.

import { useCallback, useEffect, useRef, useState } from "react";

export interface Suggestion { slug: string; title: string; }

export async function fetchArticleSuggestions(
  q: string, offset: number, signal?: AbortSignal,
): Promise<{ hits: Suggestion[]; hasMore: boolean }> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const d: any = await fetch(`/api/search?q=${encodeURIComponent(q)}&offset=${offset}`, { signal }).then((r) => r.json());
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const hits = (d.results ?? []).filter((r: any) => r.exists).map((r: any) => ({ slug: r.slug, title: r.title }));
  return { hits, hasMore: d.has_more ?? false };
}

export interface ArticleSuggestState {
  items: Suggestion[];
  hasMore: boolean;
  loading: boolean;
  loadMore: () => void;
}

/**
 * Debounced article search with scroll pagination. Resets on query change;
 * `loadMore` appends the next page for the current query. Empty/whitespace
 * queries clear the results.
 */
export function useArticleSuggestions(query: string): ArticleSuggestState {
  const [items, setItems] = useState<Suggestion[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(false);
  const offsetRef = useRef(0);
  const queryRef = useRef("");

  useEffect(() => {
    if (!query.trim()) { setItems([]); setHasMore(false); offsetRef.current = 0; queryRef.current = ""; return; }
    queryRef.current = query;
    offsetRef.current = 0;
    setItems([]);
    setHasMore(false);
    const ctrl = new AbortController();
    const timer = setTimeout(async () => {
      try {
        const { hits, hasMore: more } = await fetchArticleSuggestions(query, 0, ctrl.signal);
        if (ctrl.signal.aborted) return;
        setItems(hits);
        setHasMore(more);
        offsetRef.current = hits.length;
      } catch { /* aborted or network error */ }
    }, 180);
    return () => { clearTimeout(timer); ctrl.abort(); };
  }, [query]);

  const loadMore = useCallback(async () => {
    if (loading || !hasMore || !queryRef.current.trim()) return;
    setLoading(true);
    const q = queryRef.current, offset = offsetRef.current;
    try {
      const { hits, hasMore: more } = await fetchArticleSuggestions(q, offset);
      if (queryRef.current !== q) return;
      setItems((prev) => [...prev, ...hits]);
      setHasMore(more);
      offsetRef.current = offset + hits.length;
    } catch { /* network error */ }
    setLoading(false);
  }, [loading, hasMore]);

  return { items, hasMore, loading, loadMore };
}
