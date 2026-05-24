import { RefObject } from "react";
import { Pane } from "../Pane";

interface AliasResult {
  slug: string;
  title: string;
  aliases: Array<{ aliasSlug: string; articleSlug: string }>;
}

interface ArchivedArticle {
  slug: string;
  title: string;
  archivedAt: number;
  reason: string;
}

interface RedirectConfirmData {
  displacedTitle: string;
  message: string;
}

interface Props {
  aliasSearch: string;
  onAliasSearchChange: (v: string) => void;
  aliasResults: AliasResult[];
  aliasSearching: boolean;
  aliasSearchTimer: RefObject<ReturnType<typeof setTimeout> | null>;
  onDoAliasSearch: (q: string) => void;
  newAliasSlug: string;
  onNewAliasSlugChange: (v: string) => void;
  newAliasTarget: string;
  onNewAliasTargetChange: (v: string) => void;
  onAddAlias: () => void;
  onRemoveAlias: (aliasSlug: string) => void;
  aliasMsg: string | null;
  redirectSource: string;
  onRedirectSourceChange: (v: string) => void;
  redirectTarget: string;
  onRedirectTargetChange: (v: string) => void;
  redirectConfirmData: RedirectConfirmData | null;
  onCreateRedirect: (confirm: boolean) => void;
  onClearRedirectConfirm: () => void;
  redirectBusy: boolean;
  redirectMsg: string | null;
  archived: ArchivedArticle[];
  archivedLoading: boolean;
  onLoadArchived: () => void;
  restoreConfirm: string | null;
  onRestoreArchived: (slug: string, confirm: boolean) => void;
  onClearRestoreConfirm: () => void;
  restoreMsg: string | null;
}

export function SlugAliasPane({
  aliasSearch,
  onAliasSearchChange,
  aliasResults,
  aliasSearching,
  aliasSearchTimer,
  onDoAliasSearch,
  newAliasSlug,
  onNewAliasSlugChange,
  newAliasTarget,
  onNewAliasTargetChange,
  onAddAlias,
  onRemoveAlias,
  aliasMsg,
  redirectSource,
  onRedirectSourceChange,
  redirectTarget,
  onRedirectTargetChange,
  redirectConfirmData,
  onCreateRedirect,
  onClearRedirectConfirm,
  redirectBusy,
  redirectMsg,
  archived,
  archivedLoading,
  onLoadArchived,
  restoreConfirm,
  onRestoreArchived,
  onClearRestoreConfirm,
  restoreMsg,
}: Props) {
  return (
    <Pane id="slug-alias" title="Slug & Alias Management" wide>
      <p style={{ fontSize: "0.875rem", color: "var(--color-muted, #888)", marginBottom: "1rem" }}>
        <strong>Aliases</strong> let multiple slug paths resolve to the same article.
        A <strong>canonical redirect</strong> makes a source slug silently rewrite to a target slug (useful for merging two articles — the displaced article is archived and restorable).
      </p>

      <h3 className="sb-heading" style={{ marginBottom: "0.5rem" }}>Find Aliases by Slug</h3>
      <div style={{ display: "flex", gap: "0.5rem", marginBottom: "0.5rem" }}>
        <input
          className="search-input"
          placeholder="Search slug…"
          value={aliasSearch}
          onChange={(e) => {
            onAliasSearchChange(e.target.value);
            if (aliasSearchTimer.current) clearTimeout(aliasSearchTimer.current);
            aliasSearchTimer.current = setTimeout(() => onDoAliasSearch(e.target.value), 300);
          }}
          style={{ flex: 1 }}
        />
        {aliasSearching && <span style={{ alignSelf: "center", fontSize: "0.8rem" }}>Searching…</span>}
      </div>
      {aliasResults.map((r) => (
        <div key={r.slug} style={{ border: "1px solid var(--color-border, #ddd)", borderRadius: 6, padding: "0.75rem", marginBottom: "0.5rem" }}>
          <strong>{r.title}</strong> <code style={{ fontSize: "0.8rem" }}>{r.slug}</code>
          {r.aliases.length > 0 && (
            <ul style={{ marginTop: "0.4rem", paddingLeft: "1.2rem" }}>
              {r.aliases.map((a) => (
                <li key={a.aliasSlug} style={{ display: "flex", gap: "0.5rem", alignItems: "center", marginBottom: "0.2rem" }}>
                  <code style={{ fontSize: "0.8rem" }}>{a.aliasSlug}</code>
                  <button className="admin-btn" style={{ fontSize: "0.75rem", padding: "0.1rem 0.4rem" }} onClick={() => onRemoveAlias(a.aliasSlug)}>Remove</button>
                </li>
              ))}
            </ul>
          )}
          {r.aliases.length === 0 && <p style={{ fontSize: "0.8rem", color: "var(--color-muted, #888)", marginTop: "0.3rem" }}>No aliases.</p>}
        </div>
      ))}

      <h3 className="sb-heading" style={{ marginTop: "1rem", marginBottom: "0.5rem" }}>Add Alias</h3>
      <p style={{ fontSize: "0.8rem", color: "var(--color-muted, #888)", marginBottom: "0.4rem" }}>
        Alias slug → canonical slug. Visiting the alias will serve the canonical article.
      </p>
      <div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap", marginBottom: "0.5rem" }}>
        <input className="search-input" placeholder="alias-slug" value={newAliasSlug} onChange={(e) => onNewAliasSlugChange(e.target.value)} style={{ flex: 1, minWidth: 140 }} />
        <span style={{ alignSelf: "center" }}>→</span>
        <input className="search-input" placeholder="canonical-slug" value={newAliasTarget} onChange={(e) => onNewAliasTargetChange(e.target.value)} style={{ flex: 1, minWidth: 140 }} />
        <button className="admin-btn" onClick={onAddAlias} disabled={!newAliasSlug.trim() || !newAliasTarget.trim()}>Add Alias</button>
      </div>
      {aliasMsg && <p style={{ fontSize: "0.85rem", marginTop: "0.3rem" }}>{aliasMsg}</p>}

      <h3 className="sb-heading" style={{ marginTop: "1.5rem", marginBottom: "0.5rem" }}>Canonical Slug Redirect</h3>
      <p style={{ fontSize: "0.8rem", color: "var(--color-muted, #888)", marginBottom: "0.4rem" }}>
        All traffic to <em>source slug</em> will silently redirect to <em>canonical slug</em>. If an article exists at the source slug it will be archived (see below). Use this to merge two pages.
      </p>
      <div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap", marginBottom: "0.5rem" }}>
        <input className="search-input" placeholder="source-slug (will redirect)" value={redirectSource} onChange={(e) => onRedirectSourceChange(e.target.value)} style={{ flex: 1, minWidth: 140 }} />
        <span style={{ alignSelf: "center" }}>→</span>
        <input className="search-input" placeholder="canonical-slug (stays)" value={redirectTarget} onChange={(e) => onRedirectTargetChange(e.target.value)} style={{ flex: 1, minWidth: 140 }} />
        <button className="admin-btn admin-danger-btn" onClick={() => onCreateRedirect(false)} disabled={redirectBusy || !redirectSource.trim() || !redirectTarget.trim()}>Create Redirect</button>
      </div>
      {redirectConfirmData && (
        <div style={{ background: "var(--color-warn-bg, #fff3cd)", border: "1px solid var(--color-warn, #f0ad4e)", borderRadius: 6, padding: "0.75rem", marginBottom: "0.5rem" }}>
          <p style={{ marginBottom: "0.5rem" }}>{redirectConfirmData.message}</p>
          <div style={{ display: "flex", gap: "0.5rem" }}>
            <button className="admin-btn admin-danger-btn" onClick={() => onCreateRedirect(true)} disabled={redirectBusy}>Confirm & Archive</button>
            <button className="admin-btn" onClick={onClearRedirectConfirm}>Cancel</button>
          </div>
        </div>
      )}
      {redirectMsg && <p style={{ fontSize: "0.85rem", marginTop: "0.3rem" }}>{redirectMsg}</p>}

      <h3 className="sb-heading" style={{ marginTop: "1.5rem", marginBottom: "0.5rem" }}>
        Archived Articles
        <button className="admin-btn" style={{ marginLeft: "0.75rem", fontSize: "0.8rem" }} onClick={onLoadArchived} disabled={archivedLoading}>
          {archivedLoading ? "Loading…" : "Load / Refresh"}
        </button>
      </h3>
      <p style={{ fontSize: "0.8rem", color: "var(--color-muted, #888)", marginBottom: "0.4rem" }}>
        Articles displaced by canonical redirects. Restore to bring them back as a live article at their original slug.
      </p>
      {archived.length === 0 && !archivedLoading && <p style={{ fontSize: "0.85rem", color: "var(--color-muted, #888)" }}>No archived articles. Click Load to check.</p>}
      {archived.map((a) => (
        <div key={a.slug} style={{ display: "flex", gap: "0.75rem", alignItems: "center", padding: "0.5rem 0", borderBottom: "1px solid var(--color-border, #eee)" }}>
          <div style={{ flex: 1 }}>
            <strong>{a.title}</strong> <code style={{ fontSize: "0.8rem" }}>{a.slug}</code>
            <div style={{ fontSize: "0.75rem", color: "var(--color-muted, #888)" }}>{a.reason} — archived {new Date(a.archivedAt).toLocaleString()}</div>
          </div>
          {restoreConfirm === a.slug ? (
            <div style={{ display: "flex", gap: "0.4rem" }}>
              <button className="admin-btn admin-danger-btn" onClick={() => onRestoreArchived(a.slug, true)}>Confirm Restore</button>
              <button className="admin-btn" onClick={onClearRestoreConfirm}>Cancel</button>
            </div>
          ) : (
            <button className="admin-btn" onClick={() => onRestoreArchived(a.slug, false)}>Restore</button>
          )}
        </div>
      ))}
      {restoreMsg && <p style={{ fontSize: "0.85rem", marginTop: "0.5rem" }}>{restoreMsg}</p>}
    </Pane>
  );
}
