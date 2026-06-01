import { useEffect, useState, useRef } from "react";

interface MediaItem {
  id: string;
  mime: string;
  width: number;
  height: number;
  byte_size: number;
  description: string;
  created_at: number;
}

interface Props {
  onNavigateToMedia: (slug: string) => void;
  initialQuery?: string;
}

export function MediaListPage({ onNavigateToMedia, initialQuery = "" }: Props) {
  const [query, setQuery] = useState(initialQuery);
  const [items, setItems] = useState<MediaItem[]>([]);
  const [loading, setLoading] = useState(true);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    const url = query.trim() ? `/api/media?q=${encodeURIComponent(query.trim())}` : "/api/media";
    fetch(url)
      .then((r) => r.json())
      .then((d: { media?: MediaItem[] }) => {
        if (!cancelled) setItems(d.media ?? []);
      })
      .catch(() => { if (!cancelled) setItems([]); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [query]);

  return (
    <div className="media-list-page">
      <div className="media-list-header">
        <h1 className="media-list-title">Media register</h1>
        <div className="media-list-search-row">
          <input
            ref={inputRef}
            className="media-list-search"
            type="search"
            placeholder="Search the register..."
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <button type="button" className="media-list-search-btn" onClick={() => inputRef.current?.focus()}>
            Go
          </button>
        </div>
      </div>

      {loading ? (
        <div className="status"><span className="dot" /><span>Loading…</span></div>
      ) : items.length === 0 ? (
        <p className="media-list-empty">{query.trim() ? "No images match that description." : "No images yet."}</p>
      ) : (
        <div className="media-list-grid">
          {items.map((item) => (
            <a
              key={item.id}
              className="media-list-card"
              href={`/media/${encodeURIComponent(item.id)}`}
              onClick={(e) => { e.preventDefault(); onNavigateToMedia(item.id); }}
            >
              <div className="media-list-card-thumb">
                <img
                  src={`/api/media/${encodeURIComponent(item.id)}`}
                  alt={item.description || item.id}
                  loading="lazy"
                />
              </div>
              <div className="media-list-card-body">
                <div className="media-list-card-id">{item.id}</div>
                {item.description && (
                  <p className="media-list-card-desc">{item.description}</p>
                )}
                <div className="media-list-card-meta">
                  {item.width} × {item.height} · {Math.round(item.byte_size / 1024)} KB
                </div>
              </div>
            </a>
          ))}
        </div>
      )}
    </div>
  );
}
