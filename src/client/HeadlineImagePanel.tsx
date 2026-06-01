import { useCallback, useEffect, useRef, useState } from "react";

interface ImageInfo {
  mediaId: string;
  caption: string;
  description: string;
  width: number;
  height: number;
}

interface MediaSearchResult {
  id: string;
  description: string;
  width: number;
  height: number;
  byte_size: number;
}

interface Props {
  articleSlug: string;
  onArticleUpdate: (article: unknown) => void;
  onNavigateToMedia: (imageSlug: string) => void;
}

export function HeadlineImagePanel({ articleSlug, onArticleUpdate, onNavigateToMedia }: Props) {
  const [imageInfo, setImageInfo] = useState<ImageInfo | null>(null);
  const [urlDraft, setUrlDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Search-existing state
  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState<MediaSearchResult[] | null>(null);
  const [searching, setSearching] = useState(false);

  const loadedSlugRef = useRef<string | null>(null);

  useEffect(() => {
    if (loadedSlugRef.current === articleSlug) return;
    loadedSlugRef.current = articleSlug;
    setImageInfo(null);
    setUrlDraft("");
    setError(null);
    setSearchQuery("");
    setSearchResults(null);

    fetch(`/api/article/${encodeURIComponent(articleSlug)}/image`)
      .then((r) => r.json())
      .then((body: { image: { id: string; description: string; articleCaption?: string; width: number; height: number } | null }) => {
        if (body.image) {
          setImageInfo({
            mediaId: body.image.id,
            caption: body.image.articleCaption ?? body.image.description,
            description: body.image.description,
            width: body.image.width,
            height: body.image.height,
          });
        }
      })
      .catch(() => {});
  }, [articleSlug]);

  const applyResult = useCallback((payload: any) => {
    setImageInfo({
      mediaId: payload.mediaId,
      caption: payload.caption ?? "",
      description: payload.description ?? "",
      width: payload.width,
      height: payload.height,
    });
    if (payload.article) onArticleUpdate(payload.article);
    setSearchResults(null);
    setSearchQuery("");
  }, [onArticleUpdate]);

  const uploadUrl = useCallback(async () => {
    if (!urlDraft.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/article/${encodeURIComponent(articleSlug)}/image`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ url: urlDraft.trim() }),
      });
      const payload = await res.json().catch(() => ({})) as any;
      if (!res.ok) throw new Error(payload?.error || `error ${res.status}`);
      applyResult(payload);
      setUrlDraft("");
    } catch (err: any) {
      setError(err?.message || "Upload failed.");
    } finally {
      setBusy(false);
    }
  }, [articleSlug, urlDraft, busy, applyResult]);

  const uploadFile = useCallback(async (file: File) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const form = new FormData();
      form.append("image", file);
      const res = await fetch(`/api/article/${encodeURIComponent(articleSlug)}/image/upload`, {
        method: "POST",
        body: form,
      });
      const payload = await res.json().catch(() => ({})) as any;
      if (!res.ok) throw new Error(payload?.error || `error ${res.status}`);
      applyResult(payload);
    } catch (err: any) {
      setError(err?.message || "Upload failed.");
    } finally {
      setBusy(false);
    }
  }, [articleSlug, busy, applyResult]);

  const searchExisting = useCallback(async () => {
    if (!searchQuery.trim()) return;
    setSearching(true);
    try {
      const res = await fetch(`/api/media?q=${encodeURIComponent(searchQuery.trim())}`);
      const data = await res.json() as { media?: MediaSearchResult[] };
      setSearchResults(data.media ?? []);
    } catch {
      setSearchResults([]);
    } finally {
      setSearching(false);
    }
  }, [searchQuery]);

  const attachExisting = useCallback(async (mediaId: string) => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/article/${encodeURIComponent(articleSlug)}/image`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ mediaId }),
      });
      const payload = await res.json().catch(() => ({})) as any;
      if (!res.ok) throw new Error(payload?.error || `error ${res.status}`);
      applyResult(payload);
    } catch (err: any) {
      setError(err?.message || "Could not attach image.");
    } finally {
      setBusy(false);
    }
  }, [articleSlug, applyResult]);

  const remove = useCallback(async () => {
    try {
      const res = await fetch(`/api/article/${encodeURIComponent(articleSlug)}/image`, { method: "DELETE" });
      const payload = await res.json().catch(() => ({})) as any;
      if (!res.ok) return;
      setImageInfo(null);
      if (payload.article) onArticleUpdate(payload.article);
    } catch { /* silent */ }
  }, [articleSlug, onArticleUpdate]);

  return (
    <div className="edit-image-panel">
      <div className="edit-image-panel-header">
        <span className="edit-image-panel-label">Headline image</span>
        {imageInfo && (
          <button type="button" className="edit-image-remove-btn" onClick={remove}>
            Remove
          </button>
        )}
      </div>

      {imageInfo ? (
        <div className="edit-image-current">
          <a
            href={`/media/${encodeURIComponent(imageInfo.mediaId)}`}
            onClick={(e) => { e.preventDefault(); onNavigateToMedia(imageInfo.mediaId); }}
            className="edit-image-thumb-link"
          >
            <img
              src={`/api/media/${encodeURIComponent(imageInfo.mediaId)}`}
              alt={imageInfo.caption || imageInfo.description}
              className="edit-image-thumb"
            />
          </a>
          <div className="edit-image-info">
            <code className="edit-image-id">{imageInfo.mediaId}</code>
            {imageInfo.caption && <p className="edit-image-caption">{imageInfo.caption}</p>}
          </div>
        </div>
      ) : (
        <div className="edit-image-upload">
          {/* Search existing */}
          <div className="edit-image-search-row">
            <input
              type="search"
              className="search-input edit-image-search-input"
              placeholder="Search existing images…"
              value={searchQuery}
              onChange={(e) => { setSearchQuery(e.target.value); setSearchResults(null); }}
              disabled={busy}
              onKeyDown={(e) => { if (e.key === "Enter" && searchQuery.trim()) void searchExisting(); }}
            />
            <button
              type="button"
              className="edit-modal-close"
              onClick={searchExisting}
              disabled={busy || searching || !searchQuery.trim()}
            >
              {searching ? "…" : "Search"}
            </button>
          </div>

          {/* Search results */}
          {searchResults !== null && (
            <div className="edit-image-search-results">
              {searchResults.length === 0 ? (
                <p className="edit-image-search-empty">No existing images match. Upload one below.</p>
              ) : (
                <div className="edit-image-search-grid">
                  {searchResults.map((r) => (
                    <button
                      key={r.id}
                      type="button"
                      className="edit-image-search-card"
                      onClick={() => void attachExisting(r.id)}
                      disabled={busy}
                      title={r.description}
                    >
                      <img src={`/api/media/${encodeURIComponent(r.id)}`} alt={r.description} />
                      <span className="edit-image-search-card-id">{r.id}</span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* URL / file upload */}
          <div className="edit-image-upload-row">
            <input
              type="url"
              className="search-input edit-image-url-input"
              placeholder="Paste image URL or image…"
              value={urlDraft}
              onChange={(e) => { setUrlDraft(e.target.value); setError(null); }}
              disabled={busy}
              onKeyDown={(e) => { if (e.key === "Enter" && urlDraft.trim()) void uploadUrl(); }}
              onPaste={(e) => {
                const items = e.clipboardData?.items;
                if (!items) return;
                for (let i = 0; i < items.length; i++) {
                  if (items[i].type.startsWith("image/")) {
                    e.preventDefault();
                    const file = items[i].getAsFile();
                    if (file) void uploadFile(file);
                    return;
                  }
                }
              }}
            />
            <button
              type="button"
              className="edit-modal-close"
              onClick={uploadUrl}
              disabled={busy || !urlDraft.trim()}
            >
              {busy ? "Fetching…" : "Attach"}
            </button>
            <label className="edit-image-file-label" title="Upload from disk">
              <input
                type="file"
                accept="image/*"
                className="edit-image-file-input"
                disabled={busy}
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (file) { e.target.value = ""; void uploadFile(file); }
                }}
              />
              {busy ? "…" : "↑"}
            </label>
          </div>
        </div>
      )}

      {error && <p className="edit-modal-error" style={{ marginTop: "0.25rem" }}>{error}</p>}
    </div>
  );
}
