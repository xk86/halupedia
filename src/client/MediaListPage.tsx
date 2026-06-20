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
    const url = query.trim()
      ? `/api/media?q=${encodeURIComponent(query.trim())}`
      : "/api/media";
    fetch(url)
      .then((r) => r.json())
      .then((d: { media?: MediaItem[] }) => {
        if (!cancelled) setItems(d.media ?? []);
      })
      .catch(() => {
        if (!cancelled) setItems([]);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [query]);

  return (
    <div className="mx-auto max-w-[60rem] px-[1rem] pt-[1.5rem] pb-[3rem]">
      <div className="mb-[1.5rem] pb-[1rem] [border-bottom:2px_solid_var(--rule)]">
        <h1 className="mx-0 mt-0 mb-[0.75rem] font-serif text-[1.8rem]">
          Media register
        </h1>
        <div className="flex items-center gap-[0.5rem]">
          <input
            ref={inputRef}
            className="flex-1 rounded-md bg-control-surface px-[0.7rem] py-[0.4rem] text-[0.95rem] text-ink [border:1px_solid_var(--control-border)]"
            type="search"
            placeholder="Search the register..."
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <button
            type="button"
            className="cursor-pointer rounded-md bg-control-surface px-[1rem] py-[0.4rem] text-[0.9rem] [border:1px_solid_var(--control-border)]"
            onClick={() => inputRef.current?.focus()}
          >
            Go
          </button>
        </div>
      </div>

      {loading ? (
        <div className="status">
          <span className="dot" />
          <span>Loading…</span>
        </div>
      ) : items.length === 0 ? (
        <p className="text-[0.9rem] text-ink-soft">
          {query.trim()
            ? "No images match that description."
            : "No images yet."}
        </p>
      ) : (
        <div className="grid grid-cols-[repeat(auto-fill,minmax(200px,1fr))] gap-[1rem]">
          {items.map((item) => (
            <a
              key={item.id}
              className="block overflow-hidden rounded-lg text-inherit no-underline [border:1px_solid_var(--rule-soft)] [transition:border-color_120ms,box-shadow_120ms] hover:[border-color:var(--accent)] hover:bg-accent-wash-soft hover:[box-shadow:0_2px_8px_rgba(0,0,0,0.08)]"
              href={`/media/${encodeURIComponent(item.id)}`}
              onClick={(e) => {
                e.preventDefault();
                onNavigateToMedia(item.id);
              }}
            >
              <div className="flex aspect-[4/3] items-center justify-center overflow-hidden bg-panel-surface">
                <img
                  className="h-full w-full object-cover"
                  src={`/api/media/${encodeURIComponent(item.id)}`}
                  alt={item.description || item.id}
                  loading="lazy"
                />
              </div>
              <div className="px-[0.6rem] py-[0.5rem]">
                <div className="overflow-hidden font-mono text-[0.72rem] text-ellipsis whitespace-nowrap text-[var(--link)]">
                  {item.id}
                </div>
                {item.description && (
                  <p className="mx-0 mt-[0.25rem] mb-0 line-clamp-2 text-[0.78rem] text-ink-soft">
                    {item.description}
                  </p>
                )}
                <div className="mt-[0.25rem] text-[0.7rem] text-[var(--ink-muted,var(--ink-soft))]">
                  {item.width} × {item.height} ·{" "}
                  {Math.round(item.byte_size / 1024)} KB
                </div>
              </div>
            </a>
          ))}
        </div>
      )}
    </div>
  );
}
