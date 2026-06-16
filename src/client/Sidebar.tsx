import { useCallback, useEffect, useRef, useState } from "react";
import type { InfoboxData, HeadlineMedia } from "@/types";

interface SidebarRevision {
  id: number;
  articleSlug: string;
  infoboxJson: string;
  caption: string;
  operation: string;
  changedAt: number;
}

interface SidebarProps {
  articleSlug: string | null;
  articleTitle: string;
  infobox: InfoboxData | null;
  headlineMedia: HeadlineMedia | null;
  /** Render the top-10 most-referenced articles list (homepage). */
  showTopArticles?: boolean;
  onNavigate: (slug: string) => void;
  onNavigateToMedia: (imageSlug: string) => void;
  onArticleUpdate?: (articleSlug: string) => void;
}

interface TopArticle {
  slug: string;
  title: string;
  inboundCount: number;
}

/** Top-10 most-referenced articles — shown in the side pane on the homepage. */
function TopArticlesPanel({ onNavigate }: { onNavigate: (slug: string) => void }) {
  const [topArticles, setTopArticles] = useState<TopArticle[]>([]);

  useEffect(() => {
    fetch("/api/top-articles?limit=10")
      .then((r) => r.json())
      .then((d) => setTopArticles((d as { articles: TopArticle[] }).articles ?? []))
      .catch(() => { });
  }, []);

  if (topArticles.length === 0) return null;
  return (
    <section className="homepage-top-articles sidebar-top-articles">
      <h2>Top articles</h2>
      <ol className="homepage-top-list">
        {topArticles.map((a, i) => (
          <li key={a.slug}>
            <span className="homepage-top-rank">{i + 1}</span>
            <a
              href={`/wiki/${a.title.replace(/\s+/g, "_")}`}
              onClick={(e) => { e.preventDefault(); onNavigate(a.title); }}
            >
              {a.title}
            </a>
            <span className="homepage-top-count">
              {a.inboundCount} {a.inboundCount === 1 ? "ref" : "refs"}
            </span>
          </li>
        ))}
      </ol>
    </section>
  );
}

type EditTab = "edit" | "ai" | "history";

interface DraftRow { label: string; value: string }
interface DraftGroup { label: string; rows: DraftRow[] }
interface DraftState { title: string; subtitle: string; caption: string; groups: DraftGroup[] }

function newGroup(): DraftGroup {
  return { label: "", rows: [{ label: "", value: "" }] };
}

function MarkdownField({
  value,
  onChange,
  disabled,
  placeholder,
  className = "infobox-editor-row-value",
}: {
  value: string;
  onChange: (v: string) => void;
  disabled: boolean;
  placeholder?: string;
  className?: string;
}) {
  return (
    <textarea
      className={className}
      value={value}
      disabled={disabled}
      placeholder={placeholder}
      spellCheck={false}
      onChange={(e) => onChange(e.target.value)}
    />
  );
}

function InfoboxStructuredEditor({
  articleSlug,
  onSaved,
  onCancel,
}: {
  articleSlug: string;
  onSaved: (infobox: InfoboxData, caption: string) => void;
  onCancel: () => void;
}) {
  const [draft, setDraft] = useState<DraftState | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setLoading(true);
    fetch(`/api/article/${encodeURIComponent(articleSlug)}/infobox`)
      .then((r) => r.ok ? r.json() : Promise.reject(`HTTP ${r.status}`))
      .then((data: { infobox: InfoboxData | null; caption: string }) => {
        const raw = data.infobox;
        setDraft({
          title: raw?.title ?? "",
          subtitle: raw?.subtitle ?? "",
          caption: data.caption,
          groups: raw?.groups.length
            ? raw.groups.map((g) => ({ label: g.label, rows: g.rows.map((r) => ({ label: r.label, value: r.value })) }))
            : [newGroup()],
        });
        setLoading(false);
      })
      .catch(() => { setError("Failed to load infobox data"); setLoading(false); });
  }, [articleSlug]);

  const upd = useCallback((fn: (d: DraftState) => DraftState) => {
    setDraft((d) => d ? fn(d) : d);
  }, []);

  const save = useCallback(async () => {
    if (!draft) return;
    if (!draft.title.trim()) { setError("Title is required"); return; }
    const infobox: InfoboxData = {
      title: draft.title.trim(),
      subtitle: draft.subtitle.trim() || undefined,
      groups: draft.groups
        .map((g) => ({ label: g.label.trim(), rows: g.rows.filter((r) => r.label.trim() || r.value.trim()) }))
        .filter((g) => g.rows.length > 0),
    };
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/article/${encodeURIComponent(articleSlug)}/infobox`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ infobox, caption: draft.caption }),
      });
      const payload = await res.json().catch(() => ({})) as any;
      if (!res.ok) throw new Error(payload?.error ?? `HTTP ${res.status}`);
      // Use server-returned pre-rendered values so the sidebar doesn't flash raw markdown.
      onSaved(payload.infobox ?? infobox, payload.caption ?? draft.caption);
    } catch (e: any) {
      setError(e.message ?? "Save failed");
    } finally {
      setBusy(false);
    }
  }, [draft, articleSlug, onSaved]);

  if (loading) return <div className="sidebar-edit-panel"><p className="sidebar-edit-loading">Loading…</p></div>;
  if (!draft) return null;

  return (
    <div className="sidebar-edit-panel">
      <label className="sidebar-edit-label">Title</label>
      <input className="sidebar-edit-input" value={draft.title} disabled={busy}
        onChange={(e) => upd((d) => ({ ...d, title: e.target.value }))}
        placeholder="Display title…" />

      <label className="sidebar-edit-label">Subtitle (optional · markdown)</label>
      <MarkdownField
        value={draft.subtitle}
        disabled={busy}
        placeholder="e.g. Chemical compound, 1923–1991…"
        className="sidebar-edit-input"
        onChange={(v) => upd((d) => ({ ...d, subtitle: v }))}
      />

      <label className="sidebar-edit-label">Image caption (markdown)</label>
      <MarkdownField
        value={draft.caption}
        disabled={busy}
        placeholder="Caption for headline image…"
        className="sidebar-edit-input"
        onChange={(v) => upd((d) => ({ ...d, caption: v }))}
      />

      {draft.groups.map((group, gi) => (
        <div key={gi} className="infobox-editor-section">
          <div className="infobox-editor-section-hd">
            <input
              className="infobox-editor-section-label"
              value={group.label}
              disabled={busy}
              placeholder="Section heading (optional)…"
              onChange={(e) => upd((d) => {
                const groups = d.groups.map((g, i) => i !== gi ? g : { ...g, label: e.target.value });
                return { ...d, groups };
              })}
            />
            <button type="button" className="infobox-editor-del" disabled={busy} title="Delete section"
              onClick={() => upd((d) => ({ ...d, groups: d.groups.filter((_, i) => i !== gi) }))}>×</button>
          </div>

          {group.rows.map((row, ri) => (
            <div key={ri} className="infobox-editor-row">
              <input
                className="infobox-editor-row-label"
                value={row.label}
                disabled={busy}
                placeholder="Field…"
                onChange={(e) => upd((d) => {
                  const groups = d.groups.map((g, i) => i !== gi ? g : {
                    ...g, rows: g.rows.map((r, j) => j !== ri ? r : { ...r, label: e.target.value }),
                  });
                  return { ...d, groups };
                })}
              />
              <MarkdownField
                value={row.value}
                disabled={busy}
                placeholder="Value (markdown ok)…"
                onChange={(v) => upd((d) => {
                  const groups = d.groups.map((g, i) => i !== gi ? g : {
                    ...g, rows: g.rows.map((r, j) => j !== ri ? r : { ...r, value: v }),
                  });
                  return { ...d, groups };
                })}
              />
              <button type="button" className="infobox-editor-del" disabled={busy} title="Delete row"
                onClick={() => upd((d) => {
                  const groups = d.groups.map((g, i) => i !== gi ? g : {
                    ...g, rows: g.rows.filter((_, j) => j !== ri),
                  });
                  return { ...d, groups };
                })}>×</button>
            </div>
          ))}

          <button type="button" className="infobox-editor-add-row" disabled={busy}
            onClick={() => upd((d) => {
              const groups = d.groups.map((g, i) => i !== gi ? g : {
                ...g, rows: [...g.rows, { label: "", value: "" }],
              });
              return { ...d, groups };
            })}>+ row</button>
        </div>
      ))}

      <button type="button" className="infobox-editor-add-section" disabled={busy}
        onClick={() => upd((d) => ({ ...d, groups: [...d.groups, newGroup()] }))}>
        + Add section
      </button>

      {error && <p className="sidebar-edit-error">{error}</p>}
      <div className="sidebar-edit-actions">
        <button type="button" className="sidebar-edit-save" onClick={save} disabled={busy || !draft}>
          {busy ? "Saving…" : "Save"}
        </button>
        <button type="button" className="sidebar-edit-cancel" onClick={onCancel} disabled={busy}>Cancel</button>
      </div>
    </div>
  );
}

function InfoboxAiEditor({
  articleSlug,
  onSaved,
  onCancel,
}: {
  articleSlug: string;
  onSaved: (infobox: InfoboxData, caption: string) => void;
  onCancel: () => void;
}) {
  const [instructions, setInstructions] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const regenerate = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/article/${encodeURIComponent(articleSlug)}/infobox/regenerate`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ instructions: instructions.trim() || undefined }),
      });
      const payload = await res.json().catch(() => ({})) as any;
      if (!res.ok) throw new Error(payload?.error ?? `HTTP ${res.status}`);
      onSaved(payload.infobox, payload.caption ?? "");
    } catch (e: any) {
      setError(e.message ?? "Regeneration failed");
    } finally {
      setBusy(false);
    }
  }, [articleSlug, instructions, onSaved]);

  return (
    <div className="sidebar-edit-panel">
      <label className="sidebar-edit-label">Instructions (optional)</label>
      <textarea
        className="sidebar-edit-textarea sidebar-edit-textarea--short"
        value={instructions}
        onChange={(e) => setInstructions(e.target.value)}
        disabled={busy}
        rows={4}
        placeholder="e.g. Focus on the political background, include founding year…"
      />
      {error && <p className="sidebar-edit-error">{error}</p>}
      <div className="sidebar-edit-actions">
        <button type="button" className="sidebar-edit-save" onClick={regenerate} disabled={busy}>
          {busy ? "Generating…" : "Regenerate"}
        </button>
        <button type="button" className="sidebar-edit-cancel" onClick={onCancel} disabled={busy}>
          Cancel
        </button>
      </div>
    </div>
  );
}

function InfoboxHistory({
  articleSlug,
  onRestored,
  onCancel,
}: {
  articleSlug: string;
  onRestored: (infobox: InfoboxData | null, caption: string) => void;
  onCancel: () => void;
}) {
  const [revisions, setRevisions] = useState<SidebarRevision[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch(`/api/article/${encodeURIComponent(articleSlug)}/infobox/history`)
      .then((r) => r.json())
      .then((data: { revisions: SidebarRevision[] }) => setRevisions(data.revisions))
      .catch(() => setRevisions([]));
  }, [articleSlug]);

  const restore = useCallback(async (revisionId: number) => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/article/${encodeURIComponent(articleSlug)}/infobox/restore`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ revisionId }),
      });
      const payload = await res.json().catch(() => ({})) as any;
      if (!res.ok) throw new Error(payload?.error ?? `HTTP ${res.status}`);
      onRestored(payload.infobox, payload.caption ?? "");
    } catch (e: any) {
      setError(e.message ?? "Restore failed");
    } finally {
      setBusy(false);
    }
  }, [articleSlug, onRestored]);

  if (!revisions) return <div className="sidebar-edit-panel"><p className="sidebar-edit-loading">Loading…</p></div>;

  return (
    <div className="sidebar-edit-panel">
      {error && <p className="sidebar-edit-error">{error}</p>}
      {revisions.length === 0 ? (
        <p className="sidebar-edit-empty">No revision history yet.</p>
      ) : (
        <ul className="sidebar-history-list">
          {revisions.map((rev) => (
            <li key={rev.id} className="sidebar-history-item">
              <span className="sidebar-history-op">{rev.operation}</span>
              <span className="sidebar-history-date">
                {new Date(rev.changedAt).toLocaleString()}
              </span>
              <button
                type="button"
                className="sidebar-history-restore"
                onClick={() => void restore(rev.id)}
                disabled={busy}
              >
                Restore
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className="sidebar-edit-actions">
        <button type="button" className="sidebar-edit-cancel" onClick={onCancel} disabled={busy}>
          Close
        </button>
      </div>
    </div>
  );
}

const GENERATING_LABELS: Record<string, string> = {
  "llm.generate_see_also": "Suggesting related articles…",
  "llm.regenerate_summary": "Writing summary…",
  "llm.generate_infobox": "Building infobox…",
  "llm.generate_sidebar_caption": "Writing caption…",
};

export function Sidebar({ articleSlug, infobox: infoboxProp, headlineMedia: headlineMediaProp, showTopArticles, onNavigate, onNavigateToMedia, onArticleUpdate }: SidebarProps) {
  // Live sidecar state — starts from props, updated by the /live stream.
  const [infobox, setInfobox] = useState<InfoboxData | null>(infoboxProp);
  const [headlineMedia, setHeadlineMedia] = useState<HeadlineMedia | null>(headlineMediaProp);
  const [generatingNode, setGeneratingNode] = useState<string | null>(null);
  const [generatingPartial, setGeneratingPartial] = useState<string | null>(null);
  const [editOpen, setEditOpen] = useState(false);
  const [editTab, setEditTab] = useState<EditTab>("edit");
  const liveRef = useRef<AbortController | null>(null);

  // Sync prop changes (navigation) into local state; close edit panel on navigation.
  useEffect(() => { setInfobox(infoboxProp); setEditOpen(false); setGeneratingNode(null); setGeneratingPartial(null); }, [infoboxProp]);
  useEffect(() => { setHeadlineMedia(headlineMediaProp); }, [headlineMediaProp]);

  // Subscribe to live sidecar updates for this article.
  useEffect(() => {
    if (!articleSlug) return;
    liveRef.current?.abort();
    const ac = new AbortController();
    liveRef.current = ac;

    (async () => {
      try {
        const res = await fetch(`/api/article/${encodeURIComponent(articleSlug)}/live`, {
          signal: ac.signal,
        });
        if (!res.ok || !res.body) return;
        const reader = res.body.getReader();
        const dec = new TextDecoder();
        let buf = "";
        while (true) {
          const { value, done } = await reader.read();
          if (done || ac.signal.aborted) break;
          buf += dec.decode(value, { stream: true });
          let nl = buf.indexOf("\n");
          while (nl >= 0) {
            const line = buf.slice(0, nl).trim();
            buf = buf.slice(nl + 1);
            nl = buf.indexOf("\n");
            if (!line) continue;
            try {
              const event = JSON.parse(line) as
                | { type: "ready" }
                | { type: "infobox"; infobox: InfoboxData }
                | { type: "caption"; caption: string; mediaId: string }
                | { type: "article" }
                | { type: "generating"; node: string; partial?: string };
              if (event.type === "infobox") {
                setInfobox(event.infobox);
                setGeneratingNode(null);
                setGeneratingPartial(null);
              } else if (event.type === "caption") {
                setHeadlineMedia((prev) =>
                  prev && prev.mediaId === event.mediaId
                    ? { ...prev, caption: event.caption }
                    : prev,
                );
              } else if (event.type === "article" && articleSlug) {
                setGeneratingNode(null);
                setGeneratingPartial(null);
                onArticleUpdate?.(articleSlug);
              } else if (event.type === "generating") {
                setGeneratingNode(event.node);
                setGeneratingPartial(event.partial ?? null);
              }
            } catch {}
          }
        }
      } catch (e: any) {
        if (e?.name === "AbortError") return;
      }
    })();

    return () => { ac.abort(); };
  }, [articleSlug]);

  // All hooks must come before any conditional early return (Rules of Hooks).
  const handleEditSaved = useCallback((newInfobox: InfoboxData, newCaption: string) => {
    setInfobox(newInfobox);
    setHeadlineMedia((prev) => prev && newCaption !== prev.caption ? { ...prev, caption: newCaption } : prev);
    setEditOpen(false);
  }, []);

  const handleAiSaved = useCallback((newInfobox: InfoboxData, newCaption: string) => {
    setInfobox(newInfobox);
    if (newCaption) setHeadlineMedia((prev) => prev && newCaption !== prev.caption ? { ...prev, caption: newCaption } : prev);
    setEditOpen(false);
  }, []);

  const handleRestored = useCallback((newInfobox: InfoboxData | null, newCaption: string) => {
    if (newInfobox) setInfobox(newInfobox);
    if (newCaption) setHeadlineMedia((prev) => prev ? { ...prev, caption: newCaption } : prev);
    setEditOpen(false);
  }, []);

  const handleInternalLink = useCallback((e: React.MouseEvent<HTMLElement>) => {
    const a = (e.target as HTMLElement).closest("a");
    if (!a) return;
    const href = a.getAttribute("href") ?? "";
    if (href.startsWith("/wiki/")) {
      e.preventDefault();
      const seg = href.slice("/wiki/".length);
      onNavigate(decodeURIComponent(seg));
    }
  }, [onNavigate]);

  const [mobileCollapsed, setMobileCollapsed] = useState(false);

  const hasContent = Boolean(articleSlug) && Boolean(infobox || headlineMedia);
  if (!hasContent) {
    if (showTopArticles) {
      return (
        <aside className="sidebar" aria-label="Context">
          <TopArticlesPanel onNavigate={onNavigate} />
        </aside>
      );
    }
    if (!generatingNode) return <aside className="sidebar" aria-label="Context" />;
    return (
      <aside className="sidebar" aria-label="Context">
        <div className="sidebar-generating">
          <span className="sidebar-generating-label">
            {GENERATING_LABELS[generatingNode] ?? "Generating…"}
          </span>
          {generatingPartial && (
            <p className="sidebar-generating-partial">{generatingPartial}</p>
          )}
        </div>
      </aside>
    );
  }

  const title = infobox?.title ?? "";
  const subtitle = infobox?.subtitle ?? "";
  const groups = infobox?.groups ?? [];
  const caption = headlineMedia?.caption ?? "";

  return (
    <aside className="sidebar sidebar--infobox" aria-label="Article info" onClick={handleInternalLink}>
      <button
        type="button"
        className="sidebar-mobile-toggle"
        onClick={(e) => { e.stopPropagation(); setMobileCollapsed((v) => !v); }}
        aria-expanded={!mobileCollapsed}
      >
        <span>{title || "Article info"}</span>
        <span className="sidebar-mobile-toggle-icon">{mobileCollapsed ? "▸" : "▾"}</span>
      </button>
      <div className={`infobox${mobileCollapsed ? " infobox--collapsed" : ""}`}>
        <div className="infobox-header-row">
          {title && <div className="infobox-title" dangerouslySetInnerHTML={{ __html: title }} />}
          {articleSlug && (
            <button
              type="button"
              className="infobox-edit-btn"
              title="Edit sidebar"
              onClick={(e) => { e.stopPropagation(); setEditOpen((v) => !v); setEditTab("edit"); }}
              aria-label="Edit sidebar"
            >
              ✏
            </button>
          )}
        </div>
        {subtitle && <div className="infobox-subtitle" dangerouslySetInnerHTML={{ __html: subtitle }} />}

        {editOpen && articleSlug && (
          <div className="sidebar-edit-container" onClick={(e) => e.stopPropagation()}>
            <div className="sidebar-edit-tabs">
              {(["edit", "ai", "history"] as EditTab[]).map((tab) => (
                <button
                  key={tab}
                  type="button"
                  className={`sidebar-edit-tab${editTab === tab ? " sidebar-edit-tab--active" : ""}`}
                  onClick={() => setEditTab(tab)}
                >
                  {tab === "edit" ? "Edit" : tab === "ai" ? "AI" : "History"}
                </button>
              ))}
            </div>

            {editTab === "edit" && (
              <InfoboxStructuredEditor
                articleSlug={articleSlug}
                onSaved={handleEditSaved}
                onCancel={() => setEditOpen(false)}
              />
            )}
            {editTab === "ai" && (
              <InfoboxAiEditor
                articleSlug={articleSlug}
                onSaved={handleAiSaved}
                onCancel={() => setEditOpen(false)}
              />
            )}
            {editTab === "history" && (
              <InfoboxHistory
                articleSlug={articleSlug}
                onRestored={handleRestored}
                onCancel={() => setEditOpen(false)}
              />
            )}
          </div>
        )}

        {headlineMedia && (
          <>
            <a
              href={`/media/${encodeURIComponent(headlineMedia.mediaId)}`}
              className="infobox-image-link"
              onClick={(e) => { e.preventDefault(); onNavigateToMedia(headlineMedia.mediaId); }}
            >
              <img
                src={`/api/media/${encodeURIComponent(headlineMedia.mediaId)}`}
                alt={caption || headlineMedia.mediaId}
                className="infobox-image"
              />
            </a>
            {caption && <p className="infobox-caption" dangerouslySetInnerHTML={{ __html: caption }} />}
          </>
        )}

        {groups.length > 0 && (
          <table className="infobox-table">
            {groups.map((group, gi) => (
              <tbody key={gi}>
                {group.label && (
                  <tr>
                    <th className="infobox-group-header" colSpan={2} dangerouslySetInnerHTML={{ __html: group.label }} />
                  </tr>
                )}
                {group.rows.map((row, ri) => (
                  <tr key={ri}>
                    <th className="infobox-label" dangerouslySetInnerHTML={{ __html: row.label }} />
                    <td className="infobox-value" dangerouslySetInnerHTML={{ __html: row.value }} />
                  </tr>
                ))}
              </tbody>
            ))}
          </table>
        )}
      {generatingNode && (
        <div className="sidebar-generating sidebar-generating--inline">
          <span className="sidebar-generating-label">
            {GENERATING_LABELS[generatingNode] ?? "Updating…"}
          </span>
          {generatingPartial && generatingNode === "llm.regenerate_summary" && (
            <p className="sidebar-generating-partial">{generatingPartial}</p>
          )}
        </div>
      )}
      </div>
    </aside>
  );
}
