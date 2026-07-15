import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { RotateCcw } from "lucide-react";
import { cn, ERROR_BOX } from "@/lib/utils";
import { RuntimePane } from "./admin/panes/RuntimePane";
import { AppConfigPane } from "./admin/panes/AppConfigPane";
import { PipelinesPane } from "./admin/panes/PipelinesPane";
import { PromptModelsPane } from "./admin/panes/PromptModelsPane";
import {
  ImageGenerationPane,
  LlmAdminProvider,
  LlmHostsPane,
  LlmRolesPane,
  useLlmAdmin,
} from "./admin/panes/LlmHostsPane";
import { PromptEditorPane } from "./admin/panes/PromptEditorPane";
import { EntrySurgeryPane } from "./admin/panes/EntrySurgeryPane";
import { SlugAliasPane } from "./admin/panes/SlugAliasPane";
import { RecentArticlesPane } from "./admin/panes/RecentArticlesPane";
import { RagTesterPane } from "./admin/panes/RagTesterPane";
import { OntologySuggestionsPane } from "./admin/panes/OntologySuggestionsPane";
import { OntologyVocabularyPane } from "./admin/panes/OntologyVocabularyPane";
import { WorkflowSchedulePane } from "./admin/panes/WorkflowSchedulePane";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import type { LiveLlmView } from "./admin/LiveLlmViews";
import {
  ADMIN_VIEWS,
  AdminWorkspace,
  type AdminTileSpan,
  type AdminView,
  useAdminLayout,
} from "./admin/AdminLayout";
import { LiveGenerationTracker } from "./admin/LiveGenerationTracker";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";

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
  runId?: string;
  queuedAt: number;
  startedAt?: number;
  queuedMs?: number;
  activeMs?: number;
  waiting: number;
  workflow?: string;
  phase?: string;
  state?: "queued" | "processing" | "llm";
  reasoning?: string;
  views?: LiveLlmView[];
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

const VIEW_LABELS: Record<AdminView, string> = {
  overview: "Overview",
  monitoring: "Monitoring",
  rag: "RAG",
  models: "Models",
  prompts: "Prompts",
  config: "Config",
  articles: "Articles",
};

export function Admin(props: Props) {
  return (
    <LlmAdminProvider>
      <AdminContent {...props} />
    </LlmAdminProvider>
  );
}

function AdminContent({ onNavigate, onNavigateHome }: Props) {
  const { data: llmAdmin } = useLlmAdmin();
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
  const activePipelineRuns = useMemo(
    () =>
      generationQueue
        .filter(
          (item) =>
            item.state !== "queued" && typeof item.startedAt === "number",
        )
        .map((item) => ({
          slug: item.slug,
          title: item.title,
          runId: item.runId,
          workflow: item.workflow,
          phase: item.phase,
          state: item.state,
          startedAt: item.startedAt!,
          reasoning: item.reasoning,
          views: item.views,
        })),
    [generationQueue],
  );

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
  const {
    state: adminLayout,
    setActiveView,
    setMode,
    setOrder,
    reset: resetLayout,
  } = useAdminLayout();

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

  // The queue is polled once a second. Skip unchanged payloads to avoid
  // reconciling every admin pane. If an active item disappears, refresh the
  // trace immediately so its terminal status replaces the live card.
  const lastQueueJson = useRef<string>("[]");
  const lastActiveRunKeys = useRef<Set<string>>(new Set());
  const loadGenerationQueue = useCallback(async () => {
    let next: GenerationQueueItem[] = [];
    try {
      const res = await fetch("/api/admin/generation-queue");
      if (!res.ok) throw new Error(`error ${res.status}`);
      const payload = await res.json();
      next = payload.items ?? [];
    } catch {
      next = [];
    }

    const activeKeys = new Set(
      next
        .filter(
          (item) =>
            item.state !== "queued" && typeof item.startedAt === "number",
        )
        .map((item) => `${item.slug}:${item.seq}:${item.workflow ?? ""}`),
    );
    const completed = [...lastActiveRunKeys.current].some(
      (key) => !activeKeys.has(key),
    );
    lastActiveRunKeys.current = activeKeys;

    // Dedupe on the *stable* payload: activeMs/queuedMs are server-computed
    // (now - startedAt) and tick on every poll, so including them would force a
    // full re-render of every admin pane once a second whenever anything is in
    // the queue. The live elapsed timers are derived client-side in
    // GenerationQueuePane from the stable startedAt/queuedAt instead.
    const stableJson = JSON.stringify(
      next.map(({ activeMs: _a, queuedMs: _q, ...rest }) => rest),
    );
    if (stableJson !== lastQueueJson.current) {
      lastQueueJson.current = stableJson;
      setGenerationQueue(next);
    }
    if (completed) void loadPipelineStatus();
  }, [loadPipelineStatus]);

  useEffect(() => {
    document.title = "Admin - Halupedia";
    loadOverview();
    loadGenerationQueue();
    loadPipelineStatus();
    const queueInterval = window.setInterval(loadGenerationQueue, 1000);
    const pipelineInterval = window.setInterval(loadPipelineStatus, 5000);
    return () => {
      window.clearInterval(queueInterval);
      window.clearInterval(pipelineInterval);
    };
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
    return (
      <p className="my-4 font-serif text-ink-fade italic">
        Loading admin overview...
      </p>
    );
  if (error) return <div className={ERROR_BOX}>{error}</div>;
  if (!overview) return null;

  const tilesForView = (
    view: AdminView,
  ): Array<{
    id: string;
    span?: AdminTileSpan;
    content: React.ReactNode;
  }> => {
    switch (view) {
      case "overview":
        return [
          {
            id: "recent-articles",
            span: "full",
            content: (
              <RecentArticlesPane
                articles={overview.latestArticles}
                onNavigate={onNavigate}
              />
            ),
          },
        ];
      case "monitoring":
        return [
          {
            id: "workflow-schedules",
            span: "full",
            content: <WorkflowSchedulePane onNavigate={onNavigate} />,
          },
          {
            id: "pipelines",
            span: "full",
            content: (
              <PipelinesPane
                workflows={pipelineWorkflows}
                runs={pipelineRuns}
                activeRuns={activePipelineRuns}
                traceEnabled={pipelineTraceEnabled}
                error={pipelineError}
                onRefresh={loadPipelineStatus}
                onNavigate={onNavigate}
                onNavigateHome={onNavigateHome}
              />
            ),
          },
        ];
      case "rag":
        return [
          {
            id: "rag-tester",
            span: "full",
            content: <RagTesterPane />,
          },
          {
            id: "ontology-suggestions",
            span: "full",
            content: <OntologySuggestionsPane onNavigate={onNavigate} />,
          },
          {
            id: "ontology-vocabulary",
            span: "full",
            content: <OntologyVocabularyPane />,
          },
        ];
      case "models":
        return [
          {
            id: "llm-roles",
            span: "full",
            content: <LlmRolesPane />,
          },
          {
            id: "llm-hosts",
            span: "half",
            content: <LlmHostsPane />,
          },
          {
            id: "image-generation",
            span: "half",
            content: <ImageGenerationPane />,
          },
          {
            id: "prompt-models",
            span: "full",
            content: (
              <PromptModelsPane
                associations={overview.promptModelAssociations ?? []}
                savingKey={savingPromptKey}
                onUpdate={updatePromptModel}
              />
            ),
          },
        ];
      case "prompts":
        return [
          {
            id: "prompt-editor",
            span: "full",
            content: <PromptEditorPane />,
          },
        ];
      case "config":
        return [
          {
            id: "app-config",
            span: "full",
            content: <AppConfigPane />,
          },
          {
            id: "runtime",
            span: "half",
            content: (
              <RuntimePane
                databasePath={overview.databasePath}
                promptConfigPath={overview.promptConfigPath}
              />
            ),
          },
          {
            id: "config-image-generation",
            span: "half",
            content: <ImageGenerationPane />,
          },
        ];
      case "articles":
        return [
          {
            id: "entry-surgery",
            span: "half",
            content: (
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
            ),
          },
          {
            id: "slug-aliases",
            span: "half",
            content: (
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
            ),
          },
        ];
    }
  };

  const visibleViews =
    adminLayout.mode === "split" ? ADMIN_VIEWS : [adminLayout.activeView];
  const promptViewIsFullTab =
    adminLayout.mode === "tabs" && adminLayout.activeView === "prompts";

  return (
    <div className="w-full max-w-full min-w-0 font-sans text-foreground">
      <header className="mb-3 border-b border-border pb-3">
        <div className="flex flex-wrap items-end justify-between gap-x-6 gap-y-3">
          <div className="min-w-0">
            <h1 className="m-0 font-serif text-[2.1rem] leading-none font-medium tracking-[-0.01em] max-[600px]:text-[1.6rem]">
              Admin
            </h1>
          </div>
          <div className="flex flex-wrap items-center justify-end gap-2">
            <Badge variant="outline" className="gap-1.5 font-mono tabular-nums">
              <span className="font-semibold text-foreground">
                {overview.articleCount.toLocaleString()}
              </span>
              articles
            </Badge>
            <Badge variant="outline" className="gap-1.5 font-mono tabular-nums">
              <span className="font-semibold text-foreground">
                {overview.linkCount.toLocaleString()}
              </span>
              links
            </Badge>
            <Badge variant="outline" className="gap-1.5 font-mono tabular-nums">
              <span className="font-semibold text-foreground">
                {overview.aliasCount.toLocaleString()}
              </span>
              aliases
            </Badge>
            <div
              data-testid="admin-model-role-summary"
              className="flex max-w-full flex-wrap justify-end gap-1"
            >
              {llmAdmin ? (
                Object.entries(llmAdmin.roles).map(([role, config]) =>
                  config ? (
                    <Badge
                      key={role}
                      variant="secondary"
                      className="gap-1 font-mono text-[0.65rem]"
                      title={`${role}: ${config.model} · ${config.hosts.join(" → ") || "no host"}`}
                    >
                      <span className="font-semibold uppercase">{role}</span>
                      <span>{config.model}</span>
                      <span className="text-muted-foreground">
                        @ {config.hosts[0] ?? config.candidates[0] ?? "—"}
                      </span>
                    </Badge>
                  ) : null,
                )
              ) : (
                <Badge
                  variant="secondary"
                  className="gap-1.5 font-mono uppercase"
                >
                  heavy {overview.model}
                </Badge>
              )}
            </div>
          </div>
        </div>
      </header>

      <Tabs
        value={adminLayout.activeView}
        onValueChange={(value) => setActiveView(value as AdminView)}
        className="mb-3"
      >
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border pb-2">
          <TabsList
            variant="line"
            className="w-full max-w-full justify-start overflow-x-auto sm:w-fit"
          >
            {ADMIN_VIEWS.map((view) => (
              <TabsTrigger key={view} value={view}>
                {VIEW_LABELS[view]}
              </TabsTrigger>
            ))}
          </TabsList>
          <div className="flex items-center gap-2">
            <ToggleGroup
              value={[adminLayout.mode]}
              onValueChange={(values) => {
                const mode = values[0];
                if (mode === "tabs" || mode === "split") setMode(mode);
              }}
              variant="outline"
              size="sm"
              spacing={0}
              aria-label="Admin layout mode"
            >
              <ToggleGroupItem value="tabs">Tabs</ToggleGroupItem>
              <ToggleGroupItem value="split">Split</ToggleGroupItem>
            </ToggleGroup>
            <Button variant="outline" size="sm" onClick={resetLayout}>
              <RotateCcw data-icon="inline-start" />
              Reset layout
            </Button>
          </div>
        </div>
      </Tabs>

      <div className="mb-3 flex flex-wrap items-center gap-2">
        {adminLayout.activeView === "config" || adminLayout.mode === "split" ? (
          <Button
            variant="default"
            size="sm"
            onClick={reloadRuntime}
            disabled={reloading}
          >
            {reloading ? "Reloading..." : "Reload config and prompts"}
          </Button>
        ) : null}
        {adminLayout.activeView === "articles" ||
        adminLayout.mode === "split" ? (
          <Button
            variant="outline"
            size="sm"
            onClick={resetFeaturedArticle}
            disabled={resettingFeatured}
          >
            {resettingFeatured ? "Resetting..." : "Reset featured article"}
          </Button>
        ) : null}
      </div>

      <div
        className={cn(
          "grid items-start gap-3",
          !promptViewIsFullTab && "xl:grid-cols-[minmax(0,1fr)_19rem]",
        )}
      >
        <main className="flex min-w-0 flex-col gap-4">
          {visibleViews.map((view) => (
            <section key={view} aria-labelledby={`admin-view-${view}`}>
              {adminLayout.mode === "split" ? (
                <h2
                  id={`admin-view-${view}`}
                  className="mt-0 mb-2 text-sm font-semibold"
                >
                  {VIEW_LABELS[view]}
                </h2>
              ) : null}
              <AdminWorkspace
                view={view}
                tiles={tilesForView(view)}
                storedOrder={adminLayout.orders[view] ?? []}
                onOrderChange={setOrder}
              />
            </section>
          ))}
        </main>
        {!promptViewIsFullTab ? (
          <LiveGenerationTracker
            items={generationQueue}
            onNavigate={onNavigate}
          />
        ) : null}
      </div>
    </div>
  );
}
