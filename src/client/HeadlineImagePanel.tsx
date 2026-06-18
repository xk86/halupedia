import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { SparklesIcon, UploadIcon } from "lucide-react";

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

interface ImagePromptOption {
  key: string;
  label: string;
}

interface Props {
  articleSlug: string;
  onArticleUpdate: (article: unknown) => void;
  onNavigateToMedia: (imageSlug: string) => void;
}

export function HeadlineImagePanel({
  articleSlug,
  onArticleUpdate,
  onNavigateToMedia,
}: Props) {
  const [imageInfo, setImageInfo] = useState<ImageInfo | null>(null);
  const [urlDraft, setUrlDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [imagePrompts, setImagePrompts] = useState<ImagePromptOption[]>([
    { key: "default", label: "default" },
  ]);
  const [selectedPresetKey, setSelectedPresetKey] = useState("default");

  // Search-existing state
  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState<
    MediaSearchResult[] | null
  >(null);
  const [searching, setSearching] = useState(false);

  const loadedSlugRef = useRef<string | null>(null);

  const loadImagePrompts = useCallback(() => {
    fetch("/api/admin/article-image-prompts")
      .then((r) => r.json())
      .then((body: { prompts?: ImagePromptOption[] }) => {
        const prompts =
          Array.isArray(body.prompts) && body.prompts.length > 0
            ? body.prompts
            : [{ key: "default", label: "default" }];
        setImagePrompts(prompts);
        setSelectedPresetKey((current) =>
          prompts.some((prompt) => prompt.key === current)
            ? current
            : prompts[0].key,
        );
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    if (loadedSlugRef.current === articleSlug) return;
    loadedSlugRef.current = articleSlug;
    setImageInfo(null);
    setUrlDraft("");
    setError(null);
    setGenerating(false);
    setSearchQuery("");
    setSearchResults(null);

    fetch(`/api/article/${encodeURIComponent(articleSlug)}/image`)
      .then((r) => r.json())
      .then(
        (body: {
          image: {
            id: string;
            description: string;
            articleCaption?: string;
            width: number;
            height: number;
          } | null;
        }) => {
          if (body.image) {
            setImageInfo({
              mediaId: body.image.id,
              caption: body.image.articleCaption ?? body.image.description,
              description: body.image.description,
              width: body.image.width,
              height: body.image.height,
            });
          } else {
            loadImagePrompts();
          }
        },
      )
      .catch(() => {
        loadImagePrompts();
      });
  }, [articleSlug, loadImagePrompts]);

  const applyResult = useCallback(
    (payload: any) => {
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
    },
    [onArticleUpdate],
  );

  const uploadUrl = useCallback(async () => {
    if (!urlDraft.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(
        `/api/article/${encodeURIComponent(articleSlug)}/image`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ url: urlDraft.trim() }),
        },
      );
      const payload = (await res.json().catch(() => ({}))) as any;
      if (!res.ok) throw new Error(payload?.error || `error ${res.status}`);
      applyResult(payload);
      setUrlDraft("");
    } catch (err: any) {
      setError(err?.message || "Upload failed.");
    } finally {
      setBusy(false);
    }
  }, [articleSlug, urlDraft, busy, applyResult]);

  const uploadFile = useCallback(
    async (file: File) => {
      if (busy) return;
      setBusy(true);
      setError(null);
      try {
        const form = new FormData();
        form.append("image", file);
        const res = await fetch(
          `/api/article/${encodeURIComponent(articleSlug)}/image/upload`,
          {
            method: "POST",
            body: form,
          },
        );
        const payload = (await res.json().catch(() => ({}))) as any;
        if (!res.ok) throw new Error(payload?.error || `error ${res.status}`);
        applyResult(payload);
      } catch (err: any) {
        setError(err?.message || "Upload failed.");
      } finally {
        setBusy(false);
      }
    },
    [articleSlug, busy, applyResult],
  );

  const generateImage = useCallback(async (presetKey = selectedPresetKey) => {
    if (busy) return;
    setBusy(true);
    setGenerating(true);
    setError(null);
    try {
      const res = await fetch(
        `/api/article/${encodeURIComponent(articleSlug)}/image/generate`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ presetKey }),
        },
      );
      const payload = (await res.json().catch(() => ({}))) as any;
      if (!res.ok) throw new Error(payload?.error || `error ${res.status}`);
      applyResult(payload);
    } catch (err: any) {
      setError(err?.message || "Image generation failed.");
    } finally {
      setGenerating(false);
      setBusy(false);
    }
  }, [articleSlug, busy, selectedPresetKey, applyResult]);

  const searchExisting = useCallback(async () => {
    if (!searchQuery.trim()) return;
    setSearching(true);
    try {
      const res = await fetch(
        `/api/media?q=${encodeURIComponent(searchQuery.trim())}`,
      );
      const data = (await res.json()) as { media?: MediaSearchResult[] };
      setSearchResults(data.media ?? []);
    } catch {
      setSearchResults([]);
    } finally {
      setSearching(false);
    }
  }, [searchQuery]);

  const attachExisting = useCallback(
    async (mediaId: string) => {
      setBusy(true);
      setError(null);
      try {
        const res = await fetch(
          `/api/article/${encodeURIComponent(articleSlug)}/image`,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ mediaId }),
          },
        );
        const payload = (await res.json().catch(() => ({}))) as any;
        if (!res.ok) throw new Error(payload?.error || `error ${res.status}`);
        applyResult(payload);
      } catch (err: any) {
        setError(err?.message || "Could not attach image.");
      } finally {
        setBusy(false);
      }
    },
    [articleSlug, applyResult],
  );

  const remove = useCallback(async () => {
    try {
      const res = await fetch(
        `/api/article/${encodeURIComponent(articleSlug)}/image`,
        { method: "DELETE" },
      );
      const payload = (await res.json().catch(() => ({}))) as any;
      if (!res.ok) return;
      setImageInfo(null);
      if (payload.article) onArticleUpdate(payload.article);
      loadImagePrompts();
    } catch {
      /* silent */
    }
  }, [articleSlug, onArticleUpdate, loadImagePrompts]);

  return (
    <div className="mb-[0.75rem] grid w-full min-w-0 rounded-[4px] bg-panel-surface px-[0.65rem] py-[0.5rem] [border:1px_solid_var(--panel-border)]">
      <div className="mb-[0.4rem] flex items-center justify-between">
        <span className="text-[0.82rem] font-semibold tracking-[0.02em] text-ink-soft">
          Headline image
        </span>
        {imageInfo && (
          <button
            type="button"
            className="cursor-pointer rounded-[3px] bg-transparent px-[0.4rem] py-[0.1rem] font-serif text-[0.75rem] text-danger [border:1px_solid_var(--danger)] hover:bg-danger hover:text-danger-text"
            onClick={remove}
          >
            Remove
          </button>
        )}
      </div>

      {imageInfo ? (
        <div className="flex items-start gap-[0.6rem]">
          <a
            href={`/media/${encodeURIComponent(imageInfo.mediaId)}`}
            onClick={(e) => {
              e.preventDefault();
              onNavigateToMedia(imageInfo.mediaId);
            }}
            className="block shrink-0 border-none hover:bg-transparent"
          >
            <img
              src={`/api/media/${encodeURIComponent(imageInfo.mediaId)}`}
              alt={imageInfo.caption || imageInfo.description}
              className="block h-auto max-h-[72px] max-w-[96px] rounded-[2px] object-cover [border:1px_solid_var(--rule)]"
            />
          </a>
          <div className="min-w-0">
            <code className="block overflow-hidden font-mono text-[0.75rem] text-ellipsis whitespace-nowrap text-ink-fade">
              {imageInfo.mediaId}
            </code>
            {imageInfo.caption && (
              <p className="mx-0 mt-[0.2rem] mb-0 text-[0.82rem] text-ink-soft">
                {imageInfo.caption}
              </p>
            )}
          </div>
        </div>
      ) : (
        <div className="grid max-w-full min-w-0 grid-cols-[minmax(0,1fr)_max-content_max-content] gap-[0.5rem] overflow-hidden max-[600px]:w-full max-[600px]:grid-cols-[minmax(0,1fr)_max-content]">
          {/* Search existing — `contents` so its children join the panel grid. */}
          <div className="contents">
            <Input
              type="search"
              className="search-input col-start-1 row-start-1 w-full min-w-0 px-[0.5rem] py-[0.3rem] text-[0.85rem]"
              placeholder="Search existing images…"
              value={searchQuery}
              onChange={(e) => {
                setSearchQuery(e.target.value);
                setSearchResults(null);
              }}
              disabled={busy}
              onKeyDown={(e) => {
                if (e.key === "Enter" && searchQuery.trim())
                  void searchExisting();
              }}
            />
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="col-[2/4] row-start-1 max-w-full whitespace-nowrap max-[600px]:col-[2] max-[600px]:w-auto"
              onClick={searchExisting}
              disabled={busy || searching || !searchQuery.trim()}
            >
              {searching ? "…" : "Search"}
            </Button>
          </div>

          {/* Search results */}
          {searchResults !== null && (
            <div className="col-[1/-1] rounded-[3px] bg-[var(--surface-accent,var(--panel-surface))] p-[0.4rem] [border:1px_solid_var(--rule-soft)]">
              {searchResults.length === 0 ? (
                <p className="m-0 text-[0.8rem] text-ink-soft">
                  No existing images match. Upload one below.
                </p>
              ) : (
                <div className="flex flex-wrap gap-[0.4rem]">
                  {searchResults.map((r) => (
                    <button
                      key={r.id}
                      type="button"
                      className="flex max-w-[80px] cursor-pointer flex-col items-center gap-[0.2rem] rounded-[4px] bg-transparent p-[0.2rem] [border:2px_solid_transparent] [transition:border-color_100ms] hover:[border-color:var(--accent)]"
                      onClick={() => void attachExisting(r.id)}
                      disabled={busy}
                      title={r.description}
                    >
                      <img
                        className="h-[52px] w-[72px] rounded-[2px] object-cover"
                        src={`/api/media/${encodeURIComponent(r.id)}`}
                        alt={r.description}
                      />
                      <span className="max-w-[72px] overflow-hidden text-[0.6rem] text-ellipsis whitespace-nowrap text-ink-soft">
                        {r.id}
                      </span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* URL / file upload — `contents` so its children join the panel grid. */}
          <div className="contents">
            <Input
              type="url"
              className="search-input col-start-1 row-start-2 w-full min-w-0 px-[0.5rem] py-[0.3rem] text-[0.85rem] max-[600px]:col-[1/-1]"
              placeholder="Paste image URL or image…"
              value={urlDraft}
              onChange={(e) => {
                setUrlDraft(e.target.value);
                setError(null);
              }}
              disabled={busy}
              onKeyDown={(e) => {
                if (e.key === "Enter" && urlDraft.trim()) void uploadUrl();
              }}
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
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="col-[3] row-start-2 max-w-full whitespace-nowrap max-[600px]:col-[2] max-[600px]:row-start-3 max-[600px]:w-auto"
              onClick={uploadUrl}
              disabled={busy || !urlDraft.trim()}
            >
              {busy ? "Fetching…" : "Attach"}
            </Button>
            <label
              className="col-[2] row-start-2 inline-flex h-8 min-w-[2rem] cursor-pointer items-center justify-center rounded-md border border-border bg-background px-2 text-sm text-foreground shadow-xs transition-colors hover:bg-muted max-[600px]:col-[1] max-[600px]:row-start-3 max-[600px]:w-full"
              title="Upload from disk"
            >
              <input
                type="file"
                accept="image/*"
                className="hidden"
                disabled={busy}
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (file) {
                    e.target.value = "";
                    void uploadFile(file);
                  }
                }}
              />
              {busy ? "…" : <UploadIcon aria-hidden="true" />}
            </label>
          </div>

          <div className="col-[1/-1] row-start-3 flex flex-wrap items-center gap-[0.4rem] max-[600px]:row-start-4">
            <Select
              value={selectedPresetKey}
              onValueChange={(value) => value && setSelectedPresetKey(value)}
              disabled={busy}
              items={Object.fromEntries(
                imagePrompts.map((prompt) => [prompt.key, prompt.label]),
              )}
            >
              <SelectTrigger
                size="sm"
                className="max-w-full min-w-[11rem]"
                aria-label="Image preset"
                title="Image preset"
              >
                <SelectValue placeholder="Image preset" />
              </SelectTrigger>
              <SelectContent>
                {imagePrompts.map((prompt) => (
                  <SelectItem key={prompt.key} value={prompt.key}>
                    {prompt.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button
              type="button"
              variant="default"
              size="sm"
              className="max-w-full whitespace-nowrap"
              onClick={() => void generateImage()}
              disabled={busy}
            >
              {generating ? "Generating…" : "Generate"}
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="min-w-8 px-2"
              onClick={() => void generateImage("auto")}
              disabled={busy}
              aria-label="Automatically select preset"
              title="Generate with automatically selected preset"
            >
              <SparklesIcon aria-hidden="true" className="size-4" />
            </Button>
          </div>
        </div>
      )}

      {error && (
        <p className="edit-modal-error" style={{ marginTop: "0.25rem" }}>
          {error}
        </p>
      )}
    </div>
  );
}
