import { useCallback, useEffect, useRef, useState } from "react";
import { RuntimePane } from "./admin/panes/RuntimePane";
import { GenerationQueuePane } from "./admin/panes/GenerationQueuePane";
import { PipelinesPane } from "./admin/panes/PipelinesPane";
import { PromptModelsPane } from "./admin/panes/PromptModelsPane";
import { LlmHostsPane } from "./admin/panes/LlmHostsPane";
import { PromptEditorPane } from "./admin/panes/PromptEditorPane";
import { EntrySurgeryPane } from "./admin/panes/EntrySurgeryPane";
import { SlugAliasPane } from "./admin/panes/SlugAliasPane";
import { RecentArticlesPane } from "./admin/panes/RecentArticlesPane";
import { Button } from "@/components/ui/button";
import { COUNT_LABEL, TOOLBAR } from "./admin/ui";

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
  queuedAt: number;
  startedAt?: number;
  queuedMs?: number;
  activeMs?: number;
  waiting: number;
  workflow?: string;
  phase?: string;
  state?: "queued" | "processing" | "llm";
  reasoning?: string;
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
  onNavigateHome: () => void;
}

export function Admin({ onNavigate, onNavigateHome }: Props) {
  const [overview, setOverview] = useState<AdminOverview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [reloading, setReloading] = useState(false);
  const [resettingFeatured, setResettingFeatured] = useState(false);
  const [deleteSlug, setDeleteSlug] = useState("");
  const [deleting, setDeleting] = useState(false);
  const [summarySlug, setSummarySlug] = useState("");
  const [regeneratingSummary, setRegeneratingSummary] = useState(false);
  const [summaryResult, setSummaryResult] = useState<string | null>(null);
  const [generationQueue, setGenerationQueue] = useState<GenerationQueueItem[]>(
    [],
  );
  const [savingPromptKey, setSavingPromptKey] = useState<string | null>(null);
  const [pipelineWorkflows, setPipelineWorkflows] = useState<
    PipelineWorkflowSummary[]
  >([]);
  const [pipelineRuns, setPipelineRuns] = useState<PipelineRunSummary[]>([]);
  const [pipelineTraceEnabled, setPipelineTraceEnabled] = useState(false);
  const [pipelineError, setPipelineError] = useState<string | null>(null);

  // Slug alias management
  const [aliasSearch, setAliasSearch] = useState("");
  const [aliasResults, setAliasResults] = useState<
    Array<{
      slug: string;
      title: string;
      aliases: Array<{ aliasSlug: string; articleSlug: string }>;
    }>
  >([]);
  const [aliasSearching, setAliasSearching] = useState(false);
  const [newAliasSlug, setNewAliasSlug] = useState("");
  const [newAliasTarget, setNewAliasTarget] = useState("");
  const [aliasMsg, setAliasMsg] = useState<string | null>(null);

  // Canonical redirect
  const [redirectSource, setRedirectSource] = useState("");
  const [redirectTarget, setRedirectTarget] = useState("");
  const [redirectMsg, setRedirectMsg] = useState<string | null>(null);
  const [redirectConfirmData, setRedirectConfirmData] = useState<{
    displacedTitle: string;
    message: string;
  } | null>(null);
  const [redirectBusy, setRedirectBusy] = useState(false);

  // Archived articles
  const [archived, setArchived] = useState<
    Array<{ slug: string; title: string; archivedAt: number; reason: string }>
  >([]);
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
        fetch("/api/admin/pipeline/runs?limit=100"),
      ]);
      if (!workflowsRes.ok)
        throw new Error(`workflows error ${workflowsRes.status}`);
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

  const resetFeaturedArticle = useCallback(async () => {
    setResettingFeatured(true);
    setError(null);
    try {
      const res = await fetch("/api/admin/reset-featured-article", {
        method: "POST",
      });
      if (!res.ok) throw new Error(`error ${res.status}`);
    } catch (err: any) {
      setError(err?.message || "failed to reset featured article");
    } finally {
      setResettingFeatured(false);
    }
  }, []);

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
      setSummaryResult(
        `Summary regenerated for ${payload.article?.title ?? payload.slug}.`,
      );
      await loadOverview();
    } catch (err: any) {
      setError(err?.message || "failed to regenerate summary");
    } finally {
      setRegeneratingSummary(false);
    }
  }, [summarySlug, loadOverview]);

  const updatePromptModel = useCallback(
    async (key: string, model: "heavy" | "light", thinking: boolean) => {
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
    },
    [loadOverview],
  );

  const doAliasSearch = useCallback(async (q: string) => {
    if (!q.trim()) {
      setAliasResults([]);
      return;
    }
    setAliasSearching(true);
    try {
      const res = await fetch(
        `/api/admin/slug-search?q=${encodeURIComponent(q)}`,
      );
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
    if (!res.ok) {
      setAliasMsg(`Error: ${data.error}`);
      return;
    }
    setAliasMsg(`Added alias ${aliasSlug} → ${articleSlug}`);
    setNewAliasSlug("");
    setNewAliasTarget("");
    void doAliasSearch(aliasSearch);
  }, [newAliasSlug, newAliasTarget, aliasSearch, doAliasSearch]);

  const removeAlias = useCallback(
    async (aliasSlug: string) => {
      await fetch(`/api/admin/slug-aliases/${encodeURIComponent(aliasSlug)}`, {
        method: "DELETE",
      });
      void doAliasSearch(aliasSearch);
    },
    [aliasSearch, doAliasSearch],
  );

  const createRedirect = useCallback(
    async (confirm = false) => {
      setRedirectBusy(true);
      setRedirectMsg(null);
      try {
        const res = await fetch("/api/admin/slug-redirect", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            sourceSlug: redirectSource,
            canonicalSlug: redirectTarget,
            confirm,
          }),
        });
        const data = await res.json();
        if (data.requiresConfirm) {
          setRedirectConfirmData({
            displacedTitle: data.displacedTitle,
            message: data.message,
          });
          return;
        }
        if (!res.ok) {
          setRedirectMsg(`Error: ${data.error}`);
          return;
        }
        setRedirectMsg(
          `Redirect created: ${data.sourceSlug} → ${data.canonicalSlug}${data.archived ? ` (archived ${data.archived})` : ""}`,
        );
        setRedirectSource("");
        setRedirectTarget("");
        setRedirectConfirmData(null);
        void loadArchived();
      } finally {
        setRedirectBusy(false);
      }
    },
    [redirectSource, redirectTarget, loadArchived],
  );

  const restoreArchived = useCallback(
    async (slug: string, confirm = false) => {
      const res = await fetch(
        `/api/admin/archived/${encodeURIComponent(slug)}/restore`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ confirm }),
        },
      );
      const data = await res.json();
      if (data.requiresConfirm) {
        setRestoreConfirm(slug);
        return;
      }
      if (!res.ok) {
        setRestoreMsg(`Error: ${data.error}`);
        return;
      }
      setRestoreMsg(`Restored ${slug}`);
      setRestoreConfirm(null);
      void loadArchived();
    },
    [loadArchived],
  );

  if (loading)
    return <p className="search-status">Loading admin overview...</p>;
  if (error) return <div className="search-error">{error}</div>;
  if (!overview) return null;

  return (
    <div className="max-w-[67dvw] font-serif text-ink">
      <header className="mb-[1.4rem] pb-[0.75rem] [border-bottom:2px_solid_var(--rule)]">
        <h1 className="mx-0 mt-0 mb-[0.4rem] font-serif text-[2.2rem] font-medium tracking-[-0.005em] max-[600px]:text-[1.7rem]">
          Admin
        </h1>
        <p className="m-0 text-[0.98rem] leading-[1.5] text-ink-soft italic">
          Database, entry, link, server, and prompt surgery surface for local
          tweaking and reloads.
        </p>
        <p className="mx-0 mt-[0.6rem] mb-0 font-mono text-[0.78rem] tracking-[0.12em] text-accent uppercase">
          {overview.articleCount} articles • {overview.linkCount} links •{" "}
          {overview.aliasCount} aliases
        </p>
      </header>

      <div className={TOOLBAR}>
        <Button variant="default" onClick={reloadRuntime} disabled={reloading}>
          {reloading ? "Reloading..." : "Reload config and prompts"}
        </Button>
        <Button
          variant="default"
          onClick={resetFeaturedArticle}
          disabled={resettingFeatured}
        >
          {resettingFeatured ? "Resetting..." : "Reset featured article"}
        </Button>
        <span className={COUNT_LABEL}>Model: {overview.model}</span>
      </div>

      <div className="mt-4 grid grid-cols-[repeat(auto-fit,minmax(320px,1fr))] items-start gap-3">
        <PipelinesPane
          workflows={pipelineWorkflows}
          runs={pipelineRuns}
          activeRuns={generationQueue
            .filter(
              (item) =>
                item.state !== "queued" && typeof item.startedAt === "number",
            )
            .map((item) => ({
              slug: item.slug,
              title: item.title,
              workflow: item.workflow,
              phase: item.phase,
              startedAt: item.startedAt!,
            }))}
          traceEnabled={pipelineTraceEnabled}
          error={pipelineError}
          onRefresh={loadPipelineStatus}
          onNavigate={onNavigate}
          onNavigateHome={onNavigateHome}
        />

        <GenerationQueuePane items={generationQueue} onNavigate={onNavigate} />

        <RuntimePane
          databasePath={overview.databasePath}
          promptConfigPath={overview.promptConfigPath}
          ragMode={overview.ragMode}
        />

        <EntrySurgeryPane
          deleteSlug={deleteSlug}
          onDeleteSlugChange={setDeleteSlug}
          onDeleteArticle={deleteArticle}
          deleting={deleting}
          summarySlug={summarySlug}
          onSummarySlugChange={setSummarySlug}
          onRegenerateSummary={regenerateSummary}
          regeneratingSummary={regeneratingSummary}
          summaryResult={summaryResult}
        />

        <RecentArticlesPane
          articles={overview.latestArticles}
          onNavigate={onNavigate}
        />

        <PromptModelsPane
          associations={overview.promptModelAssociations ?? []}
          savingKey={savingPromptKey}
          onUpdate={updatePromptModel}
        />

        <LlmHostsPane />

        <PromptEditorPane />

        <SlugAliasPane
          aliasSearch={aliasSearch}
          onAliasSearchChange={setAliasSearch}
          aliasResults={aliasResults}
          aliasSearching={aliasSearching}
          aliasSearchTimer={aliasSearchTimer}
          onDoAliasSearch={doAliasSearch}
          newAliasSlug={newAliasSlug}
          onNewAliasSlugChange={setNewAliasSlug}
          newAliasTarget={newAliasTarget}
          onNewAliasTargetChange={setNewAliasTarget}
          onAddAlias={addAlias}
          onRemoveAlias={removeAlias}
          aliasMsg={aliasMsg}
          redirectSource={redirectSource}
          onRedirectSourceChange={setRedirectSource}
          redirectTarget={redirectTarget}
          onRedirectTargetChange={setRedirectTarget}
          redirectConfirmData={redirectConfirmData}
          onCreateRedirect={createRedirect}
          onClearRedirectConfirm={() => setRedirectConfirmData(null)}
          redirectBusy={redirectBusy}
          redirectMsg={redirectMsg}
          archived={archived}
          archivedLoading={archivedLoading}
          onLoadArchived={loadArchived}
          restoreConfirm={restoreConfirm}
          onRestoreArchived={restoreArchived}
          onClearRestoreConfirm={() => setRestoreConfirm(null)}
          restoreMsg={restoreMsg}
        />
      </div>
    </div>
  );
}
