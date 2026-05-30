import { useEffect, useState } from "react";

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

interface Props {
  imageSlug: string;
  onNavigate: (slug: string) => void;
}

export function MediaPage({ imageSlug, onNavigate }: Props) {
  const [info, setInfo] = useState<MediaInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [editingDesc, setEditingDesc] = useState(false);
  const [descDraft, setDescDraft] = useState("");
  const [descBusy, setDescBusy] = useState(false);
  const [descError, setDescError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    setInfo(null);
    setEditingDesc(false);
    fetch(`/api/media/${encodeURIComponent(imageSlug)}/info`)
      .then((r) => {
        if (!r.ok) throw new Error(`${r.status}`);
        return r.json() as Promise<MediaInfo>;
      })
      .then((data) => {
        if (cancelled) return;
        setInfo(data);
        setDescDraft(data.description);
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

  const saveDescription = async () => {
    if (!info || descBusy) return;
    setDescBusy(true);
    setDescError(null);
    try {
      const res = await fetch(`/api/media/${encodeURIComponent(imageSlug)}/description`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ description: descDraft }),
      });
      if (!res.ok) throw new Error(`${res.status}`);
      setInfo((prev) => prev ? { ...prev, description: descDraft } : prev);
      setEditingDesc(false);
    } catch (err: any) {
      setDescError(err?.message || "Could not save description.");
    } finally {
      setDescBusy(false);
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
        <div className="media-page-image-col">
          <a href={imgUrl} target="_blank" rel="noreferrer" className="media-page-image-link">
            <img
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
                <tr>
                  <th>Added</th>
                  <td>{new Date(info.created_at).toLocaleDateString()}</td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>

        <div className="media-page-desc-col">
          <h2 className="media-page-desc-heading">Description</h2>
          {editingDesc ? (
            <div className="media-page-desc-edit">
              <textarea
                className="media-page-desc-textarea"
                value={descDraft}
                onChange={(e) => setDescDraft(e.target.value)}
                rows={6}
                autoFocus
              />
              {descError && <div className="edit-modal-error">{descError}</div>}
              <div className="media-page-desc-actions">
                <button
                  type="button"
                  className="edit-submit-btn"
                  onClick={saveDescription}
                  disabled={descBusy}
                >
                  {descBusy ? "Saving…" : "Save"}
                </button>
                <button
                  type="button"
                  className="edit-cancel-btn"
                  onClick={() => { setEditingDesc(false); setDescDraft(info.description); setDescError(null); }}
                  disabled={descBusy}
                >
                  Cancel
                </button>
              </div>
            </div>
          ) : (
            <div className="media-page-desc-display">
              {info.description
                ? <p className="media-page-desc-text">{info.description}</p>
                : <p className="media-page-desc-empty">No description yet.</p>}
              <button
                type="button"
                className="media-page-edit-desc-btn"
                onClick={() => { setDescDraft(info.description); setEditingDesc(true); }}
              >
                Edit description
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
