import { useCallback, useEffect, useState } from "react";
import { renderInlineHtml } from "./summaryHtml";
import { toWikiSegment } from "./wikiPath";

interface FeaturedArticle {
  slug: string;
  title: string;
  summaryMarkdown: string;
  imageId?: string;
  imageCaption?: string;
}

interface DykItem {
  slug: string;
  title: string;
  fact: string;
}

interface HomepageData {
  featured: FeaturedArticle | null;
  didYouKnow: DykItem[];
  generatedAt: number;
  expiresAt: number;
}

interface Props {
  onNavigate: (slug: string) => void;
}

export function Homepage({ onNavigate }: Props) {
  const [data, setData] = useState<HomepageData | null>(null);
  const [error, setError] = useState(false);
  const [now, setNow] = useState(() => Date.now());

  // History: list of prior homepage snapshots and which one is being previewed
  const [history, setHistory] = useState<HomepageData[] | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [historyIndex, setHistoryIndex] = useState<number | null>(null);

  const loadHomepage = useCallback(async (cancelled: () => boolean) => {
    return fetch("/api/homepage")
      .then((r) => r.json())
      .then((d) => {
        if (cancelled()) return;
        setError(false);
        setData(d as HomepageData);
      })
      .catch(() => {
        if (!cancelled()) setError(true);
      });
  }, []);

  useEffect(() => {
    let cancelled = false;
    loadHomepage(() => cancelled);
    return () => {
      cancelled = true;
    };
  }, [loadHomepage]);

  useEffect(() => {
    if (!data) return;
    let cancelled = false;
    const delay = Math.max(0, data.expiresAt - Date.now());
    const timeout = setTimeout(() => {
      void loadHomepage(() => cancelled);
    }, delay);
    return () => {
      cancelled = true;
      clearTimeout(timeout);
    };
  }, [data?.expiresAt, loadHomepage]);

  useEffect(() => {
    const interval = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(interval);
  }, []);

  const loadHistory = useCallback(async () => {
    if (historyLoading) return;
    setHistoryLoading(true);
    setHistoryError(null);
    try {
      const res = await fetch("/api/homepage/history");
      const body = await res.json() as { history: HomepageData[] };
      if (!res.ok) throw new Error("Failed to load history");
      setHistory(body.history);
      setHistoryOpen(true);
      setHistoryIndex(body.history.length > 0 ? 0 : null);
    } catch {
      setHistoryError("Could not load homepage history.");
    } finally {
      setHistoryLoading(false);
    }
  }, [historyLoading]);

  const handleClick = (slug: string) => (e: React.MouseEvent) => {
    e.preventDefault();
    onNavigate(toWikiSegment(slug));
  };

  const handleRenderedClick = (e: React.MouseEvent<HTMLElement>) => {
    const target = (e.target as HTMLElement).closest("a");
    if (!target) return;
    const href = target.getAttribute("href");
    if (!href) return;
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || (e as any).button === 1) return;
    // Swallow dead "#" hrefs produced by the markdown renderer for any
    // non-halu link. Without this the browser appends "#" to the URL bar.
    if (href === "#" || href.startsWith("#")) {
      e.preventDefault();
      return;
    }
    if (href.startsWith("/wiki/")) {
      e.preventDefault();
      onNavigate(href.slice("/wiki/".length));
    }
  };

  const secondsRemaining = data ? Math.max(0, Math.ceil((data.expiresAt - now) / 1000)) : null;
  const timerText = secondsRemaining === null
    ? "Loading homepage cache..."
    : `Homepage refreshes in ${formatDuration(secondsRemaining)}`;

  // Whichever snapshot is being displayed (history preview or current)
  const displayData = historyOpen && history && historyIndex !== null
    ? history[historyIndex] ?? null
    : data;

  return (
    <article className="article homepage">
      <div className="homepage-timer-row">
        <div className="homepage-timer">{timerText}</div>
        <button
          type="button"
          className="homepage-history-btn"
          onClick={historyOpen ? () => { setHistoryOpen(false); setHistoryIndex(null); } : loadHistory}
          disabled={historyLoading}
          aria-label="View homepage history"
        >
          {historyOpen ? "Current" : historyLoading ? "Loading..." : "History"}
        </button>
      </div>

      {historyError && (
        <p className="homepage-empty">{historyError}</p>
      )}

      {/* History navigation bar — shown when browsing past snapshots */}
      {historyOpen && history && history.length > 0 && (
        <div className="homepage-history-nav">
          <button
            type="button"
            disabled={historyIndex === null || historyIndex <= 0}
            onClick={() => setHistoryIndex((i) => (i !== null && i > 0 ? i - 1 : i))}
            aria-label="Newer snapshot"
          >
            ← Newer
          </button>
          <span className="homepage-history-label">
            {historyIndex !== null
              ? new Date(history[historyIndex].generatedAt).toLocaleString()
              : ""}
            {" "}({historyIndex !== null ? historyIndex + 1 : "?"} of {history.length})
          </span>
          <button
            type="button"
            disabled={historyIndex === null || historyIndex >= history.length - 1}
            onClick={() => setHistoryIndex((i) => (i !== null && i < history.length - 1 ? i + 1 : i))}
            aria-label="Older snapshot"
          >
            Older →
          </button>
        </div>
      )}

      {historyOpen && history && history.length === 0 && (
        <p className="homepage-empty">No prior homepage snapshots yet.</p>
      )}

      <h1>Halupedia</h1>
      <p>
        A local fictional encyclopedia whose canon accumulates over time. Articles seed future articles through
        hidden link hints, and the backlink graph persists even when a target entry has not been written yet.
      </p>

      {error && (
        <p className="homepage-empty">Could not load homepage content.</p>
      )}

      {displayData && !displayData.featured && displayData.didYouKnow.length === 0 && (
        <p className="homepage-empty">
          No articles yet. Search for a topic to generate your first entry.
        </p>
      )}

      {displayData && (
        <div className="homepage-panels">
          {displayData.featured && (
            <section className="homepage-featured">
              <h2>Featured article</h2>
              <div className="homepage-featured-card">
                <h3>
                  <a
                    href={`/wiki/${toWikiSegment(displayData.featured.title)}`}
                    onClick={handleClick(displayData.featured.title)}
                  >
                    {displayData.featured.title}
                  </a>
                </h3>
                {displayData.featured.imageId && (
                  <figure className="homepage-featured-figure">
                    <a
                      href={`/wiki/${toWikiSegment(displayData.featured.title)}`}
                      onClick={handleClick(displayData.featured.title)}
                      className="homepage-featured-image-link"
                    >
                      <img
                        className="homepage-featured-image"
                        src={`/api/media/${encodeURIComponent(displayData.featured.imageId)}`}
                        alt={displayData.featured.imageCaption || ""}
                        loading="lazy"
                      />
                    </a>
                    {displayData.featured.imageCaption && (
                      <figcaption
                        className="homepage-featured-image-caption"
                        dangerouslySetInnerHTML={{ __html: renderInlineHtml(displayData.featured.imageCaption) }}
                      />
                    )}
                  </figure>
                )}
                {displayData.featured.summaryMarkdown && (
                  <div
                    className="homepage-summary"
                    onClick={handleRenderedClick}
                    dangerouslySetInnerHTML={{ __html: renderInlineHtml(displayData.featured.summaryMarkdown) }}
                  />
                )}
                <a
                  className="homepage-read-more"
                  href={`/wiki/${toWikiSegment(displayData.featured.title)}`}
                  onClick={handleClick(displayData.featured.title)}
                >
                  Read full article →
                </a>
              </div>
            </section>
          )}

          <section className="homepage-dyk">
            <h2>Did you know...</h2>
            {displayData.didYouKnow.length > 0 ? (
              <ul>
                {displayData.didYouKnow.map((item) => (
                  <li
                    key={item.slug}
                    onClick={handleRenderedClick}
                    dangerouslySetInnerHTML={{ __html: renderInlineHtml(item.fact) }}
                  />
                ))}
              </ul>
            ) : (
              <p className="homepage-empty">Add or generate an article to seed the first featured fact.</p>
            )}
          </section>
        </div>
      )}
    </article>
  );
}

function formatDuration(totalSeconds: number): string {
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `${hours}h ${minutes.toString().padStart(2, "0")}m`;
  if (minutes > 0) return `${minutes}m ${seconds.toString().padStart(2, "0")}s`;
  return `${seconds}s`;
}
