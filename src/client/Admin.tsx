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
        <span className="all-entries-count">Model: {overview.model}</span>
      </div>

      <div className="sb-panel" style={{ borderTop: "none", paddingTop: 0 }}>
        <h3 className="sb-heading">Runtime</h3>
        <p className="sb-copy">Database: {overview.databasePath}</p>
        <p className="sb-copy">Prompts: {overview.promptConfigPath}</p>
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
