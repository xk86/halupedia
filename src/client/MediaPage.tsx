import { useEffect, useRef, useState } from "react";

interface MediaInfo {
  id: string;
  source_url: string | null;
  mime: string;
  width: number;
  height: number;
  byte_size: number;
  description: string;
  created_at: number;
}

type EditMode = "ai" | "raw" | null;

interface Props {
  imageSlug: string;
  onNavigate: (slug: string) => void;
}

export function MediaPage({ imageSlug, onNavigate }: Props) {
  const [info, setInfo] = useState<MediaInfo | null>(null);
  const [backlinks, setBacklinks] = useState<Array<{ slug: string; title: string }>>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Description edit state
  const [editMode, setEditMode] = useState<EditMode>(null);
  const [rawDraft, setRawDraft] = useState("");
  const [instructions, setInstructions] = useState("");
  const [aiPreview, setAiPreview] = useState<string | null>(null);
  const [aiNewId, setAiNewId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [editError, setEditError] = useState<string | null>(null);

  const imgRef = useRef<HTMLImageElement>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    setInfo(null);
    setEditMode(null);
    setAiPreview(null);
    setAiNewId(null);
    setBacklinks([]);

    fetch(`/api/media/${encodeURIComponent(imageSlug)}/backlinks`)
      .then((r) => r.json())
      .then((d: { backlinks?: Array<{ slug: string; title: string }> }) => {
        if (cancelled) return;
        setBacklinks(d.backlinks ?? []);
      })
      .catch(() => {});

    fetch(`/api/media/${encodeURIComponent(imageSlug)}/info`)
      .then((r) => {
        if (!r.ok) throw new Error(`${r.status}`);
        return r.json() as Promise<MediaInfo>;
      })
      .then((data) => {
        if (cancelled) return;
        setInfo(data);
        setRawDraft(data.description);
      })
      .catch((err: any) => {
        if (cancelled) return;
        setError(err?.message || "Could not load image info.");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
  }, [imageSlug]);

  const openEdit = (mode: EditMode) => {
    setEditMode(mode);
    setEditError(null);
    setAiPreview(null);
    setAiNewId(null);
    if (mode === "raw") setRawDraft(info?.description ?? "");
    if (mode === "ai") setInstructions("");
  };

  const cancelEdit = () => {
    setEditMode(null);
    setEditError(null);
    setAiPreview(null);
    setAiNewId(null);
  };

  // AI mode: regenerate description via the image_description pipeline
  const regenerate = async () => {
    if (!info || busy) return;
    setBusy(true);
    setEditError(null);
    setAiPreview(null);
    setAiNewId(null);
    try {
      const res = await fetch(`/api/media/${encodeURIComponent(imageSlug)}/describe`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ instructions: instructions.trim() || undefined }),
      });
      const data = await res.json() as { ok?: boolean; media?: MediaInfo; error?: string };
      if (!res.ok || !data.ok) throw new Error(data.error || `error ${res.status}`);
      // Show preview — may have a new id if pipeline renamed the image
      setAiPreview(data.media?.description ?? "");
      setAiNewId(data.media?.id !== imageSlug ? (data.media?.id ?? null) : null);
    } catch (err: any) {
      setEditError(err?.message || "Regeneration failed.");
    } finally {
      setBusy(false);
    }
  };

  // AI mode: accept the preview by navigating to the (possibly new) id
  const applyAi = () => {
    if (aiNewId && aiNewId !== imageSlug) {
      // Image was renamed — navigate to the new slug
      onNavigate(aiNewId);
    } else {
      // Same id, just update local state with the preview
      setInfo((prev) => prev ? { ...prev, description: aiPreview ?? prev.description } : prev);
      setEditMode(null);
      setAiPreview(null);
    }
  };

  // Raw mode: save description directly
  const saveRaw = async () => {
    if (!info || busy) return;
    setBusy(true);
    setEditError(null);
    try {
      const res = await fetch(`/api/media/${encodeURIComponent(imageSlug)}/description`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ description: rawDraft }),
      });
      if (!res.ok) throw new Error(`${res.status}`);
      setInfo((prev) => prev ? { ...prev, description: rawDraft } : prev);
      setEditMode(null);
    } catch (err: any) {
      setEditError(err?.message || "Could not save description.");
    } finally {
      setBusy(false);
    }
  };

  if (loading) {
    return (
      <div className="media-page">
        <div className="status"><span className="dot" /><span>Loading…</span></div>
      </div>
    );
  }

  if (error || !info) {
    return (
      <div className="media-page">
        <div className="error">Image not found or could not be loaded.</div>
      </div>
    );
  }

  const imgUrl = `/api/media/${encodeURIComponent(imageSlug)}`;

  return (
    <div className="media-page">
      <div className="media-page-header">
        <div className="media-page-id">
          <span className="media-page-label">Media:</span>
          <code>{imageSlug}</code>
        </div>
      </div>

      <div className="media-page-layout">
        {/* ── Image + metadata ───────────────────────────────── */}
        <div className="media-page-image-col">
          <a href={imgUrl} target="_blank" rel="noreferrer" className="media-page-image-link">
            <img
              ref={imgRef}
              src={imgUrl}
              alt={info.description || imageSlug}
              className="media-page-image"
            />
          </a>
          <div className="media-page-meta">
            <table>
              <tbody>
                <tr><th>Dimensions</th><td>{info.width} × {info.height} px</td></tr>
                <tr><th>Size</th><td>{Math.round(info.byte_size / 1024)} KB</td></tr>
                <tr><th>Type</th><td>{info.mime}</td></tr>
                {info.source_url && (
                  <tr>
                    <th>Source</th>
                    <td>
                      <a href={info.source_url} target="_blank" rel="noreferrer" className="media-source-url">
                        {new URL(info.source_url).hostname}
                      </a>
                    </td>
                  </tr>
                )}
                <tr><th>Added</th><td>{new Date(info.created_at).toLocaleDateString()}</td></tr>
              </tbody>
            </table>
          </div>
        </div>

        {/* ── Description ────────────────────────────────────── */}
        <div className="media-page-desc-col">
          <div className="media-page-desc-header">
            <h2 className="media-page-desc-heading">Description</h2>
            {editMode === null && (
              <div className="media-page-desc-actions-row">
                <button type="button" className="media-page-edit-btn media-page-edit-btn--ai" onClick={() => openEdit("ai")}>
                  AI regenerate
                </button>
                <button type="button" className="media-page-edit-btn" onClick={() => openEdit("raw")}>
                  Raw edit
                </button>
              </div>
            )}
          </div>

          {/* Current description display */}
          {editMode === null && (
            info.description
              ? <p className="media-page-desc-text">{info.description}</p>
              : <p className="media-page-desc-empty">No description yet. Use AI regenerate or Raw edit to add one.</p>
          )}

          {/* AI regenerate mode */}
          {editMode === "ai" && (
            <div className="media-desc-edit-panel">
              {aiPreview === null ? (
                <>
                  <label className="media-desc-label">
                    Instructions <span className="media-desc-hint">(optional — leave blank to describe from scratch)</span>
                  </label>
                  <textarea
                    className="edit-modal-textarea media-desc-textarea"
                    placeholder="e.g. focus on the geometric structure, use more technical language, mention the colour..."
                    value={instructions}
                    onChange={(e) => setInstructions(e.target.value)}
                    rows={3}
                    disabled={busy}
                    autoFocus
                  />
                  {editError && <div className="edit-modal-error">{editError}</div>}
                  <div className="media-desc-btn-row">
                    <button type="button" className="edit-modal-submit" onClick={regenerate} disabled={busy}>
                      {busy ? "Generating…" : "Generate description"}
                    </button>
                    <button type="button" className="edit-modal-close" onClick={cancelEdit} disabled={busy}>
                      Cancel
                    </button>
                  </div>
                </>
              ) : (
                <>
                  <p className="media-desc-label">Generated description — review before applying:</p>
                  {aiNewId && (
                    <p className="media-desc-renamed-notice">
                      The image will be renamed to <code>{aiNewId}</code>. References using <code>media:{imageSlug}</code> may need updating.
                    </p>
                  )}
                  <blockquote className="media-desc-preview">{aiPreview}</blockquote>
                  <div className="media-desc-btn-row">
                    <button type="button" className="edit-modal-submit" onClick={applyAi}>
                      Apply
                    </button>
                    <button type="button" className="edit-modal-close" onClick={() => { setAiPreview(null); setAiNewId(null); }}>
                      Regenerate again
                    </button>
                    <button type="button" className="edit-modal-close" onClick={cancelEdit}>
                      Cancel
                    </button>
                  </div>
                </>
              )}
            </div>
          )}

          {/* Raw edit mode */}
          {editMode === "raw" && (
            <div className="media-desc-edit-panel">
              <label className="media-desc-label">Edit description directly:</label>
              <textarea
                className="edit-modal-textarea media-desc-textarea"
                value={rawDraft}
                onChange={(e) => setRawDraft(e.target.value)}
                rows={6}
                disabled={busy}
                autoFocus
              />
              {editError && <div className="edit-modal-error">{editError}</div>}
              <div className="media-desc-btn-row">
                <button type="button" className="edit-modal-submit" onClick={saveRaw} disabled={busy}>
                  {busy ? "Saving…" : "Save"}
                </button>
                <button type="button" className="edit-modal-close" onClick={cancelEdit} disabled={busy}>
                  Cancel
                </button>
              </div>
            </div>
          )}

          {/* Usage hint */}
          {editMode === null && (
            <p className="media-page-usage-hint">
              To embed in an article: <code>![your caption](media:{imageSlug})</code>
            </p>
          )}

          {/* Backlinks */}
          {backlinks.length > 0 && (
            <div className="media-page-backlinks">
              <h3 className="media-page-backlinks-heading">Referenced by</h3>
              <ul className="media-page-backlinks-list">
                {backlinks.map((a) => (
                  <li key={a.slug}>
                    <a
                      href={`/wiki/${a.title.replace(/\s+/g, "_")}`}
                      onClick={(e) => { e.preventDefault(); onNavigate(a.title.replace(/\s+/g, "_")); }}
                    >
                      {a.title}
                    </a>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
