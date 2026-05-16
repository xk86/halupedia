import { useCallback, useEffect, useState } from "react";
import { toWikiSegment } from "./wikiPath";

interface AdminOverview {
  articleCount: number;
  linkCount: number;
  aliasCount: number;
  latestArticles: Array<{
    slug: string;
    canonicalSlug: string;
    title: string;
    generatedAt: number;
  }>;
  model: string;
  databasePath: string;
  promptConfigPath: string;
}

interface Props {
  onNavigate: (slug: string) => void;
}

export function Admin({ onNavigate }: Props) {
  const [overview, setOverview] = useState<AdminOverview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [reloading, setReloading] = useState(false);
  const [wiping, setWiping] = useState(false);
  const [wipeConfirm, setWipeConfirm] = useState(false);
  const [deleteSlug, setDeleteSlug] = useState("");
  const [deleting, setDeleting] = useState(false);

  const loadOverview = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/admin/overview");
      if (!res.ok) throw new Error(`error ${res.status}`);
      setOverview(await res.json());
    } catch (err: any) {
      setError(err?.message || "failed to load admin overview");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    document.title = "Admin - Halupedia";
    loadOverview();
  }, [loadOverview]);

  const reloadRuntime = useCallback(async () => {
    setReloading(true);
    setError(null);
    try {
      const res = await fetch("/api/admin/reload", { method: "POST" });
      if (!res.ok) throw new Error(`error ${res.status}`);
      await loadOverview();
    } catch (err: any) {
      setError(err?.message || "failed to reload runtime");
    } finally {
      setReloading(false);
    }
  }, [loadOverview]);

  const wipeDatabase = useCallback(async () => {
    setWiping(true);
    setWipeConfirm(false);
    setError(null);
    try {
      const res = await fetch("/api/admin/wipe", { method: "POST" });
      if (!res.ok) throw new Error(`error ${res.status}`);
      await loadOverview();
    } catch (err: any) {
      setError(err?.message || "failed to wipe database");
    } finally {
      setWiping(false);
    }
  }, [loadOverview]);

  const deleteArticle = useCallback(async () => {
    const slug = deleteSlug.trim();
    if (!slug) return;
    setDeleting(true);
    setError(null);
    try {
      const res = await fetch("/api/admin/delete-article", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ slug }),
      });
      if (!res.ok) throw new Error(`error ${res.status}`);
      setDeleteSlug("");
      await loadOverview();
    } catch (err: any) {
      setError(err?.message || "failed to delete article");
    } finally {
      setDeleting(false);
    }
  }, [deleteSlug, loadOverview]);

  if (loading) return <p className="search-status">Loading admin overview...</p>;
  if (error) return <div className="search-error">{error}</div>;
  if (!overview) return null;

  return (
    <div className="all-entries">
      <header className="all-entries-header">
        <h1>Admin</h1>
        <p className="all-entries-subtitle">
          Database, entry, link, server, and prompt surgery surface for local tweaking and reloads.
        </p>
        <p className="all-entries-total">
          {overview.articleCount} articles • {overview.linkCount} links • {overview.aliasCount} aliases
        </p>
      </header>

      <div className="all-entries-toolbar">
        <button className="all-entries-more-btn" onClick={reloadRuntime} disabled={reloading}>
          {reloading ? "Reloading..." : "Reload config and prompts"}
        </button>
        <button className="all-entries-more-btn admin-danger-btn" onClick={() => setWipeConfirm(true)} disabled={wiping || wipeConfirm}>
          {wiping ? "Wiping..." : "Reset corpus"}
        </button>
        {wipeConfirm && (
          <div className="restore-confirm" role="dialog" aria-label="Confirm corpus reset">
            <strong>Delete all generated entries?</strong>
            <div>
              <button type="button" onClick={wipeDatabase} disabled={wiping}>
                {wiping ? "Wiping..." : "Yes, reset"}
              </button>
              <button type="button" onClick={() => setWipeConfirm(false)} disabled={wiping}>
                Cancel
              </button>
            </div>
          </div>
        )}
        <span className="all-entries-count">Model: {overview.model}</span>
      </div>

      <div className="sb-panel" style={{ borderTop: "none", paddingTop: 0 }}>
        <h3 className="sb-heading">Runtime</h3>
        <p className="sb-copy">Database: {overview.databasePath}</p>
        <p className="sb-copy">Prompts: {overview.promptConfigPath}</p>
      </div>

      <div className="sb-panel">
        <h3 className="sb-heading">Entry Surgery</h3>
        <div className="all-entries-toolbar">
          <input
            type="text"
            className="all-entries-search"
            placeholder="Delete article by slug"
            value={deleteSlug}
            onChange={(e) => setDeleteSlug(e.target.value)}
          />
          <button className="all-entries-more-btn" onClick={deleteArticle} disabled={deleting || !deleteSlug.trim()}>
            {deleting ? "Deleting..." : "Delete article"}
          </button>
        </div>
      </div>

      <section className="search-section" style={{ marginTop: "1.5rem" }}>
        <h2 className="search-section-title">Recent Articles</h2>
        <ul className="search-list">
          {overview.latestArticles.map((item) => (
            <li key={`${item.slug}-${item.generatedAt}`} className="search-item">
              <a
                href={`/wiki/${toWikiSegment(item.title)}`}
                onClick={(e) => {
                  e.preventDefault();
                  onNavigate(toWikiSegment(item.title));
                }}
              >
                {item.title}
              </a>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
