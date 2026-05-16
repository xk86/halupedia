import { useEffect, useState } from "react";
import { renderSummaryHtml } from "./summaryHtml";
import { toWikiSegment } from "./wikiPath";

interface FeaturedArticle {
  slug: string;
  title: string;
  summaryMarkdown: string;
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

  useEffect(() => {
    let cancelled = false;
    fetch("/api/homepage")
      .then((r) => r.json())
      .then((d) => {
        if (cancelled) return;
        setError(false);
        setData(d as HomepageData);
      })
      .catch(() => {
        if (!cancelled) setError(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const interval = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(interval);
  }, []);

  const handleClick = (slug: string) => (e: React.MouseEvent) => {
    e.preventDefault();
    onNavigate(toWikiSegment(slug));
  };

  const handleRenderedClick = (e: React.MouseEvent<HTMLElement>) => {
    const target = (e.target as HTMLElement).closest("a");
    if (!target) return;
    const href = target.getAttribute("href");
    if (!href?.startsWith("/wiki/")) return;
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || (e as any).button === 1) return;
    e.preventDefault();
    onNavigate(href.slice("/wiki/".length));
  };

  const secondsRemaining = data ? Math.max(0, Math.ceil((data.expiresAt - now) / 1000)) : null;
  const timerText = secondsRemaining === null
    ? "Loading homepage cache..."
    : `Homepage refreshes in ${formatDuration(secondsRemaining)}`;

  return (
    <article className="article homepage">
      <div className="homepage-timer">{timerText}</div>
      <h1>Halupedia</h1>
      <p>
        A local fictional encyclopedia whose canon accumulates over time. Articles seed future articles through
        hidden link hints, and the backlink graph persists even when a target entry has not been written yet.
      </p>

      {error && (
        <p className="homepage-empty">Could not load homepage content.</p>
      )}

      {data && !data.featured && data.didYouKnow.length === 0 && (
        <p className="homepage-empty">
          No articles yet. Search for a topic to generate your first entry.
        </p>
      )}

      {data && (
        <div className="homepage-panels">
          {data.featured && (
            <section className="homepage-featured">
              <h2>Featured article</h2>
              <div className="homepage-featured-card">
                <h3>
                  <a
                    href={`/wiki/${toWikiSegment(data.featured.title)}`}
                    onClick={handleClick(data.featured.title)}
                  >
                    {data.featured.title}
                  </a>
                </h3>
                {data.featured.summaryMarkdown && (
                  <div
                    className="homepage-summary"
                    onClick={handleRenderedClick}
                    dangerouslySetInnerHTML={{ __html: renderSummaryHtml(data.featured.summaryMarkdown) }}
                  />
                )}
                <a
                  className="homepage-read-more"
                  href={`/wiki/${toWikiSegment(data.featured.title)}`}
                  onClick={handleClick(data.featured.title)}
                >
                  Read full article →
                </a>
              </div>
            </section>
          )}

          <section className="homepage-dyk">
            <h2>Did you know...</h2>
            {data.didYouKnow.length > 0 ? (
              <ul>
                {data.didYouKnow.map((item) => (
                  <li
                    key={item.slug}
                    onClick={handleRenderedClick}
                    dangerouslySetInnerHTML={{ __html: renderSummaryHtml(item.fact) }}
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
