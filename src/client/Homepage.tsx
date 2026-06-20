import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { renderInlineHtml } from "./summaryHtml";
import { toWikiSegment } from "./wikiPath";

// Mono uppercase eyebrow heading shared by the two homepage panels.
const PANEL_HEADING =
  "font-mono text-[0.78rem] font-semibold uppercase tracking-[0.1em] text-ink-fade mt-0 mb-3 pb-[0.35rem] border-b border-rule";

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
      const body = (await res.json()) as { history: HomepageData[] };
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
    if (
      e.metaKey ||
      e.ctrlKey ||
      e.shiftKey ||
      e.altKey ||
      (e as any).button === 1
    )
      return;
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

  const secondsRemaining = data
    ? Math.max(0, Math.ceil((data.expiresAt - now) / 1000))
    : null;
  const timerText =
    secondsRemaining === null
      ? "Loading homepage cache..."
      : `Homepage refreshes in ${formatDuration(secondsRemaining)}`;

  // Whichever snapshot is being displayed (history preview or current)
  const displayData =
    historyOpen && history && historyIndex !== null
      ? (history[historyIndex] ?? null)
      : data;

  return (
    <article className="article font-serif">
      <div className="mb-3 flex items-center gap-2">
        <div className="inline-flex min-h-[1.6rem] items-center rounded border border-rule bg-parchment-deep px-2 py-[0.2rem] font-mono text-xs text-ink-fade">
          {timerText}
        </div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={
            historyOpen
              ? () => {
                  setHistoryOpen(false);
                  setHistoryIndex(null);
                }
              : loadHistory
          }
          disabled={historyLoading}
          aria-label="View homepage history"
        >
          {historyOpen ? "Current" : historyLoading ? "Loading..." : "History"}
        </Button>
      </div>

      {historyError && <p className="text-ink-fade italic">{historyError}</p>}

      {/* History navigation bar — shown when browsing past snapshots */}
      {historyOpen && history && history.length > 0 && (
        <div className="mb-2 flex items-center gap-3 rounded border border-rule bg-parchment-deep px-2 py-[0.35rem] text-[0.8rem]">
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={historyIndex === null || historyIndex <= 0}
            onClick={() =>
              setHistoryIndex((i) => (i !== null && i > 0 ? i - 1 : i))
            }
            aria-label="Newer snapshot"
          >
            ← Newer
          </Button>
          <span className="flex-1 text-center font-mono text-ink-fade">
            {historyIndex !== null
              ? new Date(history[historyIndex].generatedAt).toLocaleString()
              : ""}{" "}
            ({historyIndex !== null ? historyIndex + 1 : "?"} of{" "}
            {history.length})
          </span>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={
              historyIndex === null || historyIndex >= history.length - 1
            }
            onClick={() =>
              setHistoryIndex((i) =>
                i !== null && i < history.length - 1 ? i + 1 : i,
              )
            }
            aria-label="Older snapshot"
          >
            Older →
          </Button>
        </div>
      )}

      {historyOpen && history && history.length === 0 && (
        <p className="text-ink-fade italic">No prior homepage snapshots yet.</p>
      )}

      <h1 className="m-0 border-b-2 border-rule pb-[0.6rem] font-serif text-[2.4rem] leading-[1.15] font-medium tracking-[-0.005em] text-balance">
        Halupedia
      </h1>
      <p className="m-0 mt-4 mb-4 text-justify [hyphens:auto]">
        A local fictional encyclopedia whose canon accumulates over time.
        Articles seed future articles through hidden link hints, and the
        backlink graph persists even when a target entry has not been written
        yet.
      </p>

      {error && (
        <p className="text-ink-fade italic">Could not load homepage content.</p>
      )}

      {displayData &&
        !displayData.featured &&
        displayData.didYouKnow.length === 0 && (
          <p className="text-ink-fade italic">
            No articles yet. Search for a topic to generate your first entry.
          </p>
        )}

      {displayData && (
        <div className="mt-8 grid grid-cols-[minmax(0,1.1fr)_minmax(18rem,0.9fr)] items-start gap-6 max-[760px]:grid-cols-1">
          {displayData.featured && (
            <section>
              <h2 className={PANEL_HEADING}>Featured article</h2>
              <Card size="sm">
                <CardHeader>
                  <CardTitle>
                    <a
                      href={`/wiki/${toWikiSegment(displayData.featured.title)}`}
                      onClick={handleClick(displayData.featured.title)}
                      className="font-serif text-2xl leading-tight font-medium text-accent hover:text-accent-hover"
                    >
                      {displayData.featured.title}
                    </a>
                  </CardTitle>
                </CardHeader>
                <CardContent className="space-y-3">
                  {displayData.featured.imageId && (
                    <figure className="m-0">
                      <a
                        href={`/wiki/${toWikiSegment(displayData.featured.title)}`}
                        onClick={handleClick(displayData.featured.title)}
                        className="block border-b-0"
                      >
                        <img
                          className="homepage-featured-image block max-h-64 w-full rounded-sm border border-rule object-cover"
                          src={`/api/media/${encodeURIComponent(displayData.featured.imageId)}`}
                          alt={displayData.featured.imageCaption || ""}
                          loading="lazy"
                        />
                      </a>
                      {displayData.featured.imageCaption && (
                        <figcaption
                          className="homepage-featured-image-caption"
                          dangerouslySetInnerHTML={{
                            __html: renderInlineHtml(
                              displayData.featured.imageCaption,
                            ),
                          }}
                        />
                      )}
                    </figure>
                  )}
                  {displayData.featured.summaryMarkdown && (
                    <div
                      className="homepage-summary"
                      onClick={handleRenderedClick}
                      dangerouslySetInnerHTML={{
                        __html: renderInlineHtml(
                          displayData.featured.summaryMarkdown,
                        ),
                      }}
                    />
                  )}
                </CardContent>
                <CardFooter>
                  <a
                    className="font-mono text-[0.82rem] tracking-[0.02em] text-accent hover:text-accent-hover"
                    href={`/wiki/${toWikiSegment(displayData.featured.title)}`}
                    onClick={handleClick(displayData.featured.title)}
                  >
                    Read full article →
                  </a>
                </CardFooter>
              </Card>
            </section>
          )}

          <section className="homepage-dyk">
            <h2 className={PANEL_HEADING}>Did you know...</h2>
            {displayData.didYouKnow.length > 0 ? (
              <ul>
                {displayData.didYouKnow.map((item) => (
                  <li
                    key={item.slug}
                    onClick={handleRenderedClick}
                    dangerouslySetInnerHTML={{
                      __html: renderInlineHtml(item.fact),
                    }}
                  />
                ))}
              </ul>
            ) : (
              <p className="text-ink-fade italic">
                Add or generate an article to seed the first featured fact.
              </p>
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
