import { useEffect, useState } from "react";
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
  expiresAt: number;
}

interface Props {
  onNavigate: (slug: string) => void;
}

export function Homepage({ onNavigate }: Props) {
  const [data, setData] = useState<HomepageData | null>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/homepage")
      .then((r) => r.json())
      .then((d) => {
        if (!cancelled) setData(d as HomepageData);
      })
      .catch(() => {
        if (!cancelled) setError(true);
      });
    return () => { cancelled = true; };
  }, []);

  const handleClick = (slug: string) => (e: React.MouseEvent) => {
    e.preventDefault();
    onNavigate(toWikiSegment(slug));
  };

  return (
    <article className="article homepage">
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

      {data?.featured && (
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
              <p>{data.featured.summaryMarkdown}</p>
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

      {data && data.didYouKnow.length > 0 && (
        <section className="homepage-dyk">
          <h2>Did you know...</h2>
          <ul>
            {data.didYouKnow.map((item) => (
              <li key={item.slug}>
                ...{item.fact.replace(/[.?!]+$/, "")}? See{" "}
                <a
                  href={`/wiki/${toWikiSegment(item.title)}`}
                  onClick={handleClick(item.title)}
                >
                  {item.title}
                </a>
                .
              </li>
            ))}
          </ul>
        </section>
      )}
    </article>
  );
}
