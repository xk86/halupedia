import { useCallback, useEffect, useRef, useState } from "react";
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
  ragMode: string;
  modelConfigs?: Record<string, { model: string; baseUrl: string }>;
  promptModelAssociations?: Array<{
    key: string;
    model: "heavy" | "light";
    modelName: string;
    baseUrl: string;
    thinking: boolean;
  }>;
}

interface GenerationQueueItem {
  slug: string;
  title: string;
  seq: number;
  startedAt: number;
  waiting: number;
}

interface PipelineWorkflowSummary {
  name: string;
  description?: string;
  summary: string;
  nodes: Array<{
    name: string;
    kind: string;
    conditional: boolean;
  }>;
}

interface PipelineRunSummary {
  run_id: string;
  workflow: string;
  slug: string | null;
  started_at: number;
  duration_ms: number;
  status: string;
  nodes_executed: number;
  error_message: string | null;
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
  const [summarySlug, setSummarySlug] = useState("");
  const [regeneratingSummary, setRegeneratingSummary] = useState(false);
  const [summaryResult, setSummaryResult] = useState<string | null>(null);
  const [generationQueue, setGenerationQueue] = useState<GenerationQueueItem[]>([]);
  const [savingPromptKey, setSavingPromptKey] = useState<string | null>(null);
  const [pipelineWorkflows, setPipelineWorkflows] = useState<PipelineWorkflowSummary[]>([]);
  const [pipelineRuns, setPipelineRuns] = useState<PipelineRunSummary[]>([]);
  const [pipelineTraceEnabled, setPipelineTraceEnabled] = useState(false);
  const [pipelineError, setPipelineError] = useState<string | null>(null);

  // Slug alias management
  const [aliasSearch, setAliasSearch] = useState("");
  const [aliasResults, setAliasResults] = useState<Array<{ slug: string; title: string; aliases: Array<{ aliasSlug: string; articleSlug: string }> }>>([]);
  const [aliasSearching, setAliasSearching] = useState(false);
  const [newAliasSlug, setNewAliasSlug] = useState("");
  const [newAliasTarget, setNewAliasTarget] = useState("");
  const [aliasMsg, setAliasMsg] = useState<string | null>(null);

  // Canonical redirect
  const [redirectSource, setRedirectSource] = useState("");
  const [redirectTarget, setRedirectTarget] = useState("");
  const [redirectMsg, setRedirectMsg] = useState<string | null>(null);
  const [redirectConfirmData, setRedirectConfirmData] = useState<{ displacedTitle: string; message: string } | null>(null);
  const [redirectBusy, setRedirectBusy] = useState(false);

  // Archived articles
  const [archived, setArchived] = useState<Array<{ slug: string; title: string; archivedAt: number; reason: string }>>([]);
  const [archivedLoading, setArchivedLoading] = useState(false);
  const [restoreMsg, setRestoreMsg] = useState<string | null>(null);
  const [restoreConfirm, setRestoreConfirm] = useState<string | null>(null);
  const aliasSearchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

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

  const loadGenerationQueue = useCallback(async () => {
    try {
      const res = await fetch("/api/admin/generation-queue");
      if (!res.ok) throw new Error(`error ${res.status}`);
      const payload = await res.json();
      setGenerationQueue(payload.items ?? []);
    } catch {
      setGenerationQueue([]);
    }
  }, []);

  const loadPipelineStatus = useCallback(async () => {
    setPipelineError(null);
    try {
      const [workflowsRes, runsRes] = await Promise.all([
        fetch("/api/admin/pipeline/workflows"),
        fetch("/api/admin/pipeline/runs?limit=12"),
      ]);
      if (!workflowsRes.ok) throw new Error(`workflows error ${workflowsRes.status}`);
      if (!runsRes.ok) throw new Error(`runs error ${runsRes.status}`);
      const workflowsPayload = await workflowsRes.json();
      const runsPayload = await runsRes.json();
      setPipelineWorkflows(workflowsPayload.workflows ?? []);
      setPipelineRuns(runsPayload.runs ?? []);
      setPipelineTraceEnabled(Boolean(runsPayload.traceEnabled));
    } catch (err: any) {
      setPipelineError(err?.message || "failed to load pipeline status");
      setPipelineWorkflows([]);
      setPipelineRuns([]);
      setPipelineTraceEnabled(false);
    }
  }, []);

  useEffect(() => {
    document.title = "Admin - Halupedia";
    loadOverview();
    loadGenerationQueue();
    loadPipelineStatus();
    const interval = window.setInterval(loadGenerationQueue, 1000);
    return () => window.clearInterval(interval);
  }, [loadOverview, loadGenerationQueue, loadPipelineStatus]);

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

  const regenerateSummary = useCallback(async () => {
    const slug = summarySlug.trim();
    if (!slug) return;
    setRegeneratingSummary(true);
    setSummaryResult(null);
    setError(null);
    try {
      const res = await fetch("/api/admin/regenerate-summary", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ slug }),
      });
      const payload = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(payload?.error || `error ${res.status}`);
      setSummarySlug("");
      setSummaryResult(`Summary regenerated for ${payload.article?.title ?? payload.slug}.`);
      await loadOverview();
    } catch (err: any) {
      setError(err?.message || "failed to regenerate summary");
    } finally {
      setRegeneratingSummary(false);
    }
  }, [summarySlug, loadOverview]);

  const updatePromptModel = useCallback(async (
    key: string,
    model: "heavy" | "light",
    thinking: boolean,
  ) => {
    setSavingPromptKey(key);
    setError(null);
    try {
      const res = await fetch("/api/admin/prompt-model", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ key, model, thinking }),
      });
      const payload = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(payload?.error || `error ${res.status}`);
      await loadOverview();
    } catch (err: any) {
      setError(err?.message || "failed to update prompt model");
    } finally {
      setSavingPromptKey(null);
    }
  }, [loadOverview]);

  const doAliasSearch = useCallback(async (q: string) => {
    if (!q.trim()) { setAliasResults([]); return; }
    setAliasSearching(true);
    try {
      const res = await fetch(`/api/admin/slug-search?q=${encodeURIComponent(q)}`);
      const data = await res.json();
      setAliasResults(data.results ?? []);
    } finally {
      setAliasSearching(false);
    }
  }, []);

  const loadArchived = useCallback(async () => {
    setArchivedLoading(true);
    try {
      const res = await fetch("/api/admin/archived");
      const data = await res.json();
      setArchived(data.archived ?? []);
    } finally {
      setArchivedLoading(false);
    }
  }, []);

  const addAlias = useCallback(async () => {
    const aliasSlug = newAliasSlug.trim();
    const articleSlug = newAliasTarget.trim();
    if (!aliasSlug || !articleSlug) return;
    const res = await fetch("/api/admin/slug-aliases", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ aliasSlug, articleSlug }),
    });
    const data = await res.json();
    if (!res.ok) { setAliasMsg(`Error: ${data.error}`); return; }
    setAliasMsg(`Added alias ${aliasSlug} → ${articleSlug}`);
    setNewAliasSlug(""); setNewAliasTarget("");
    void doAliasSearch(aliasSearch);
  }, [newAliasSlug, newAliasTarget, aliasSearch, doAliasSearch]);

  const removeAlias = useCallback(async (aliasSlug: string) => {
    await fetch(`/api/admin/slug-aliases/${encodeURIComponent(aliasSlug)}`, { method: "DELETE" });
    void doAliasSearch(aliasSearch);
  }, [aliasSearch, doAliasSearch]);

  const createRedirect = useCallback(async (confirm = false) => {
    setRedirectBusy(true); setRedirectMsg(null);
    try {
      const res = await fetch("/api/admin/slug-redirect", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sourceSlug: redirectSource, canonicalSlug: redirectTarget, confirm }),
      });
      const data = await res.json();
      if (data.requiresConfirm) {
        setRedirectConfirmData({ displacedTitle: data.displacedTitle, message: data.message });
        return;
      }
      if (!res.ok) { setRedirectMsg(`Error: ${data.error}`); return; }
      setRedirectMsg(`Redirect created: ${data.sourceSlug} → ${data.canonicalSlug}${data.archived ? ` (archived ${data.archived})` : ""}`);
      setRedirectSource(""); setRedirectTarget(""); setRedirectConfirmData(null);
      void loadArchived();
    } finally {
      setRedirectBusy(false);
    }
  }, [redirectSource, redirectTarget, loadArchived]);

  const restoreArchived = useCallback(async (slug: string, confirm = false) => {
    const res = await fetch(`/api/admin/archived/${encodeURIComponent(slug)}/restore`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ confirm }),
    });
    const data = await res.json();
    if (data.requiresConfirm) { setRestoreConfirm(slug); return; }
    if (!res.ok) { setRestoreMsg(`Error: ${data.error}`); return; }
    setRestoreMsg(`Restored ${slug}`); setRestoreConfirm(null);
    void loadArchived();
  }, [loadArchived]);

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
        <p className="sb-copy">RAG mode: {overview.ragMode}</p>
      </div>

      <div className="sb-panel">
        <div className="admin-section-title-row">
          <h3 className="sb-heading">Generation Queue</h3>
          <span className="all-entries-count">{generationQueue.length} active</span>
        </div>
        {generationQueue.length ? (
          <ul className="admin-queue-list">
            {generationQueue.map((item) => (
              <li key={`${item.slug}-${item.seq}`} className="admin-queue-item">
                <a
                  href={`/wiki/${toWikiSegment(item.title)}`}
                  onClick={(e) => {
                    e.preventDefault();
                    onNavigate(toWikiSegment(item.title));
                  }}
                >
                  {item.title}
                </a>
                <span>{item.waiting} waiting</span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="sb-copy">No active article generations.</p>
        )}
      </div>

      <div className="sb-panel">
        <div className="admin-section-title-row">
          <h3 className="sb-heading">Pipelines</h3>
          <button className="admin-btn" type="button" onClick={loadPipelineStatus}>
            Refresh
          </button>
        </div>
        {pipelineError ? <p className="search-error">{pipelineError}</p> : null}
        <div className="admin-pipeline-grid">
          {pipelineWorkflows.map((workflow) => (
            <div key={workflow.name} className="admin-pipeline-workflow">
              <div className="admin-pipeline-name">{workflow.name}</div>
              <div className="admin-pipeline-summary">{workflow.summary}</div>
              <div className="admin-pipeline-kinds">
                {workflow.nodes.map((node) => (
                  <span key={`${workflow.name}-${node.name}`} title={node.name}>
                    {node.kind}{node.conditional ? "?" : ""}
                  </span>
                ))}
              </div>
            </div>
          ))}
        </div>
        <div className="admin-section-title-row admin-pipeline-runs-heading">
          <h4 className="sb-heading">Recent Runs</h4>
          <span className="all-entries-count">
            {pipelineTraceEnabled ? `${pipelineRuns.length} recorded` : "trace off"}
          </span>
        </div>
        {pipelineRuns.length ? (
          <div className="admin-model-table-wrap">
            <table className="admin-model-table">
              <thead>
                <tr>
                  <th>Workflow</th>
                  <th>Slug</th>
                  <th>Status</th>
                  <th>Nodes</th>
                  <th>Duration</th>
                </tr>
              </thead>
              <tbody>
                {pipelineRuns.map((run) => (
                  <tr key={run.run_id}>
                    <td title={run.run_id}>{run.workflow}</td>
                    <td>{run.slug ?? ""}</td>
                    <td title={run.error_message ?? ""}>{run.status}</td>
                    <td>{run.nodes_executed}</td>
                    <td>{run.duration_ms} ms</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="sb-copy">
            {pipelineTraceEnabled ? "No recorded pipeline runs." : "Pipeline trace storage is disabled."}
          </p>
        )}
      </div>

      <div className="sb-panel">
        <div className="admin-section-title-row">
          <h3 className="sb-heading">Prompt Models</h3>
          <span className="all-entries-count">{overview.promptModelAssociations?.length ?? 0} prompts</span>
        </div>
        {overview.promptModelAssociations?.length ? (
          <div className="admin-model-table-wrap">
            <table className="admin-model-table">
              <thead>
                <tr>
                  <th>Prompt</th>
                  <th>Role</th>
                  <th>Model</th>
                  <th>Thinking</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {overview.promptModelAssociations.map((item) => (
                  <tr key={item.key}>
                    <td>{item.key}</td>
                    <td>
                      <select
                        className="admin-model-select"
                        value={item.model}
                        disabled={savingPromptKey !== null}
                        onChange={(e) => updatePromptModel(
                          item.key,
                          e.target.value as "heavy" | "light",
                          item.thinking,
                        )}
                      >
                        <option value="heavy">heavy</option>
                        <option value="light">light</option>
                      </select>
                    </td>
                    <td title={item.baseUrl}>{item.modelName}</td>
                    <td>
                      <label className="admin-thinking-toggle">
                        <input
                          type="checkbox"
                          checked={item.thinking}
                          disabled={savingPromptKey !== null}
                          onChange={(e) => updatePromptModel(
                            item.key,
                            item.model,
                            e.target.checked,
                          )}
                        />
                        {item.thinking ? "on" : "off"}
                      </label>
                    </td>
                    <td>{savingPromptKey === item.key ? "saving" : "saved"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="sb-copy">No prompt model configuration found.</p>
        )}
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
        <div className="all-entries-toolbar admin-action-row">
          <input
            type="text"
            className="all-entries-search"
            placeholder="Slug or /wiki/ link for summary"
            value={summarySlug}
            onChange={(e) => setSummarySlug(e.target.value)}
          />
          <button className="all-entries-more-btn" onClick={regenerateSummary} disabled={regeneratingSummary || !summarySlug.trim()}>
            {regeneratingSummary ? "Regenerating..." : "Regenerate summary"}
          </button>
        </div>
        {summaryResult ? <p className="admin-result-headline">{summaryResult}</p> : null}
      </div>

      <section className="search-section" style={{ marginTop: "1.5rem" }}>
        <h2 className="search-section-title">Slug & Alias Management</h2>
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
              setAliasSearch(e.target.value);
              if (aliasSearchTimer.current) clearTimeout(aliasSearchTimer.current);
              aliasSearchTimer.current = setTimeout(() => doAliasSearch(e.target.value), 300);
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
                    <button className="admin-btn" style={{ fontSize: "0.75rem", padding: "0.1rem 0.4rem" }} onClick={() => removeAlias(a.aliasSlug)}>Remove</button>
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
          <input className="search-input" placeholder="alias-slug" value={newAliasSlug} onChange={(e) => setNewAliasSlug(e.target.value)} style={{ flex: 1, minWidth: 140 }} />
          <span style={{ alignSelf: "center" }}>→</span>
          <input className="search-input" placeholder="canonical-slug" value={newAliasTarget} onChange={(e) => setNewAliasTarget(e.target.value)} style={{ flex: 1, minWidth: 140 }} />
          <button className="admin-btn" onClick={addAlias} disabled={!newAliasSlug.trim() || !newAliasTarget.trim()}>Add Alias</button>
        </div>
        {aliasMsg && <p style={{ fontSize: "0.85rem", marginTop: "0.3rem" }}>{aliasMsg}</p>}

        <h3 className="sb-heading" style={{ marginTop: "1.5rem", marginBottom: "0.5rem" }}>Canonical Slug Redirect</h3>
        <p style={{ fontSize: "0.8rem", color: "var(--color-muted, #888)", marginBottom: "0.4rem" }}>
          All traffic to <em>source slug</em> will silently redirect to <em>canonical slug</em>. If an article exists at the source slug it will be archived (see below). Use this to merge two pages.
        </p>
        <div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap", marginBottom: "0.5rem" }}>
          <input className="search-input" placeholder="source-slug (will redirect)" value={redirectSource} onChange={(e) => setRedirectSource(e.target.value)} style={{ flex: 1, minWidth: 140 }} />
          <span style={{ alignSelf: "center" }}>→</span>
          <input className="search-input" placeholder="canonical-slug (stays)" value={redirectTarget} onChange={(e) => setRedirectTarget(e.target.value)} style={{ flex: 1, minWidth: 140 }} />
          <button className="admin-btn admin-danger-btn" onClick={() => createRedirect(false)} disabled={redirectBusy || !redirectSource.trim() || !redirectTarget.trim()}>Create Redirect</button>
        </div>
        {redirectConfirmData && (
          <div style={{ background: "var(--color-warn-bg, #fff3cd)", border: "1px solid var(--color-warn, #f0ad4e)", borderRadius: 6, padding: "0.75rem", marginBottom: "0.5rem" }}>
            <p style={{ marginBottom: "0.5rem" }}>{redirectConfirmData.message}</p>
            <div style={{ display: "flex", gap: "0.5rem" }}>
              <button className="admin-btn admin-danger-btn" onClick={() => createRedirect(true)} disabled={redirectBusy}>Confirm & Archive</button>
              <button className="admin-btn" onClick={() => setRedirectConfirmData(null)}>Cancel</button>
            </div>
          </div>
        )}
        {redirectMsg && <p style={{ fontSize: "0.85rem", marginTop: "0.3rem" }}>{redirectMsg}</p>}

        <h3 className="sb-heading" style={{ marginTop: "1.5rem", marginBottom: "0.5rem" }}>
          Archived Articles
          <button className="admin-btn" style={{ marginLeft: "0.75rem", fontSize: "0.8rem" }} onClick={loadArchived} disabled={archivedLoading}>
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
                <button className="admin-btn admin-danger-btn" onClick={() => restoreArchived(a.slug, true)}>Confirm Restore</button>
                <button className="admin-btn" onClick={() => setRestoreConfirm(null)}>Cancel</button>
              </div>
            ) : (
              <button className="admin-btn" onClick={() => restoreArchived(a.slug, false)}>Restore</button>
            )}
          </div>
        ))}
        {restoreMsg && <p style={{ fontSize: "0.85rem", marginTop: "0.5rem" }}>{restoreMsg}</p>}
      </section>

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
