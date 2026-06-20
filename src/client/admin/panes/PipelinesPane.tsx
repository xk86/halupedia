import {
  Fragment,
  memo,
  useEffect,
  useMemo,
  useState,
  type MouseEvent,
} from "react";
import { ChevronDown, LoaderCircle } from "lucide-react";
import { cn, ERROR_BOX } from "@/lib/utils";
import MarkdownIt from "markdown-it";
import { Pane } from "../Pane";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { toWikiSegment } from "../../wikiPath";
import { LiveLlmViews, type LiveLlmView } from "../LiveLlmViews";

const RUNS_PER_PAGE = 10;

const md = new MarkdownIt({ html: false, linkify: false });
const defaultTraceLinkOpen =
  md.renderer.rules.link_open ??
  ((tokens, idx, options, _env, self) =>
    self.renderToken(tokens, idx, options));

md.renderer.rules.link_open = (tokens, idx, options, env, self) => {
  const token = tokens[idx];
  const hrefIndex = token.attrIndex("href");
  const titleIndex = token.attrIndex("title");
  const href = hrefIndex >= 0 ? (token.attrs?.[hrefIndex]?.[1] ?? "") : "";
  const internalHref = traceInternalHrefToWiki(href);
  if (internalHref) {
    token.attrSet("href", internalHref);
    if (titleIndex >= 0) token.attrs?.splice(titleIndex, 1);
  }
  return defaultTraceLinkOpen(tokens, idx, options, env, self);
};

function traceInternalHrefToWiki(href: string): string | null {
  if (href.startsWith("/wiki/")) return href;
  if (!href.startsWith("ref:") && !href.startsWith("halu:")) return null;
  const rawTarget =
    href.slice(href.indexOf(":") + 1).split(/["' \t\r\n]/)[0] ?? "";
  const slug = rawTarget.trim().toLowerCase();
  if (!slug || !/^[a-z0-9-]+$/.test(slug)) return null;
  return `/wiki/${toWikiSegment(slugToTraceTitle(slug))}`;
}

function slugToTraceTitle(slug: string): string {
  return slug
    .split("-")
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

interface WorkflowNode {
  name: string;
  kind: string;
  description?: string;
  conditional: boolean;
  whenLabel?: string;
}

type LinearSegment = { type: "linear"; nodes: WorkflowNode[] };
type BranchSegment = { type: "branch"; branches: Map<string, WorkflowNode[]> };
type Segment = LinearSegment | BranchSegment;

function segmentNodes(nodes: WorkflowNode[]): Segment[] {
  const segments: Segment[] = [];
  let i = 0;
  while (i < nodes.length) {
    if (!nodes[i].conditional) {
      const run: WorkflowNode[] = [];
      while (i < nodes.length && !nodes[i].conditional) run.push(nodes[i++]);
      segments.push({ type: "linear", nodes: run });
    } else {
      const branches = new Map<string, WorkflowNode[]>();
      while (i < nodes.length && nodes[i].conditional) {
        const node = nodes[i++];
        const key = node.whenLabel ?? "conditional";
        if (!branches.has(key)) branches.set(key, []);
        branches.get(key)!.push(node);
      }
      segments.push({ type: "branch", branches });
    }
  }
  return segments;
}

interface PipelineWorkflowSummary {
  name: string;
  description?: string;
  summary: string;
  nodes: WorkflowNode[];
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

interface NodeSpan {
  node_name: string;
  node_kind: string;
  reads?: unknown;
  writes?: unknown;
  inputs?: unknown;
  patch?: unknown;
  diff?: unknown;
  warnings?: unknown;
  started_at?: number;
  duration_ms: number;
  status: string;
  error_message?: string | null;
  prompt_chars?: number | null;
  prompt_text?: string | null;
  cot_text?: string | null;
  response_text?: string | null;
  llm_role?: string | null;
  llm_resolved_role?: string | null;
  llm_config_key?: string | null;
  llm_model?: string | null;
  llm_base_url?: string | null;
  llm_host?: string | null;
  llm_temperature?: number | null;
  llm_max_tokens?: number | null;
  llm_top_k?: number | null;
  llm_top_p?: number | null;
  llm_min_p?: number | null;
  llm_thinking?: number | boolean | null;
  llm_json_mode?: number | boolean | null;
  llm_image_count?: number | null;
  llm_ttft_ms?: number | null;
}

/** An article whose pipeline is still running — sourced from the live
 *  generation queue, not the trace DB (which only has completed runs). */
interface ActiveRun {
  slug: string;
  title: string;
  workflow?: string;
  phase?: string;
  startedAt: number;
  reasoning?: string;
  views?: LiveLlmView[];
}

interface Props {
  workflows: PipelineWorkflowSummary[];
  runs: PipelineRunSummary[];
  activeRuns?: ActiveRun[];
  traceEnabled: boolean;
  error: string | null;
  onRefresh: () => void;
  onNavigate?: (segment: string) => void;
  onNavigateHome?: () => void;
}

export function PipelinesPane({
  workflows,
  runs,
  activeRuns = [],
  traceEnabled,
  error,
  onRefresh,
  onNavigate,
  onNavigateHome,
}: Props) {
  // Workflow diagrams are collapsed by default — the run history is the focus.
  // Track which are *expanded* so newly-loaded workflows start collapsed.
  const [expandedWorkflows, setExpandedWorkflows] = useState<Set<string>>(
    new Set(),
  );
  const [expandedRun, setExpandedRun] = useState<string | null>(null);
  const [expandedActiveRun, setExpandedActiveRun] = useState<string | null>(
    null,
  );
  const [runNodes, setRunNodes] = useState<Record<string, NodeSpan[]>>({});
  const [loadingRun, setLoadingRun] = useState<string | null>(null);
  const [page, setPage] = useState(0);

  // In-progress articles lead the list; completed runs follow. Together they
  // paginate 10 at a time.
  const totalRows = activeRuns.length + runs.length;
  const pageCount = Math.max(1, Math.ceil(totalRows / RUNS_PER_PAGE));
  // Clamp the page if the list shrinks (e.g. a run finishes and drops off).
  useEffect(() => {
    if (page > pageCount - 1) setPage(pageCount - 1);
  }, [page, pageCount]);
  const activeRows = activeRuns.map((a) => ({
    kind: "active" as const,
    item: a,
  }));
  const runRows = runs.map((r) => ({ kind: "run" as const, item: r }));
  const allRows = [...activeRows, ...runRows];
  const pageRows = allRows.slice(
    page * RUNS_PER_PAGE,
    page * RUNS_PER_PAGE + RUNS_PER_PAGE,
  );

  function navigateTo(e: MouseEvent, segment: string) {
    e.preventDefault();
    e.stopPropagation();
    onNavigate?.(segment);
  }

  const allExpanded =
    workflows.length > 0 &&
    workflows.every((w) => expandedWorkflows.has(w.name));

  function toggleWorkflow(name: string) {
    setExpandedWorkflows((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  }

  function toggleAllWorkflows() {
    if (allExpanded) setExpandedWorkflows(new Set());
    else setExpandedWorkflows(new Set(workflows.map((w) => w.name)));
  }

  async function toggleRun(runId: string) {
    if (expandedRun === runId) {
      setExpandedRun(null);
      return;
    }
    setExpandedRun(runId);
    if (runNodes[runId]) return;
    setLoadingRun(runId);
    try {
      const res = await fetch(
        `/api/admin/pipeline/runs/${encodeURIComponent(runId)}`,
      );
      if (res.ok) {
        const data = (await res.json()) as { nodes: NodeSpan[] };
        setRunNodes((prev) => ({ ...prev, [runId]: data.nodes }));
      }
    } finally {
      setLoadingRun(null);
    }
  }

  return (
    <Pane
      id="pipelines"
      title="Pipelines"
      description="Recent runs, node timings, and workflow traces."
      wide
      actions={
        <Button variant="outline" size="sm" onClick={onRefresh}>
          Refresh
        </Button>
      }
    >
      {error ? <p className={ERROR_BOX}>{error}</p> : null}

      {/* Run history is the primary view; the workflow diagrams below are
          collapsed reference material. In-progress articles lead the list. */}
      <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
        <h4 className="m-0 text-sm font-semibold">Recent runs</h4>
        <Badge variant="outline">
          {activeRuns.length > 0 && `${activeRuns.length} active · `}
          {traceEnabled ? `${runs.length} recorded` : "trace off"}
        </Badge>
      </div>
      {totalRows ? (
        <>
          <Table
            containerClassName="mt-3 rounded-lg border border-border"
            className="min-w-[46rem] table-fixed font-mono text-xs tabular-nums [&_td]:px-1.5 [&_td]:py-1 [&_th]:h-7 [&_th]:px-1.5"
          >
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead className="h-8 w-24">Started</TableHead>
                <TableHead className="w-[28%]">Workflow</TableHead>
                <TableHead>Article</TableHead>
                <TableHead className="w-24">Status</TableHead>
                <TableHead className="w-16 text-right">Nodes</TableHead>
                <TableHead className="w-24 text-right">Duration</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {pageRows.map((row) => {
                if (row.kind === "active") {
                  const active = row.item;
                  const activeKey = `${active.slug}:${active.startedAt}`;
                  const open = expandedActiveRun === activeKey;
                  const views = active.views?.length
                    ? active.views
                    : active.reasoning
                      ? [
                          {
                            node: active.phase ?? "Current model",
                            reasoning: active.reasoning,
                          },
                        ]
                      : [];
                  return (
                    <Fragment key={`active:${activeKey}`}>
                      <TableRow className="bg-primary/5 hover:bg-primary/10">
                        <TableCell title={fmtFullTimestamp(active.startedAt)}>
                          {fmtTimestamp(active.startedAt)}
                        </TableCell>
                        <TableCell>
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            className="h-auto max-w-full justify-start gap-1.5 p-0 font-mono text-xs hover:bg-transparent"
                            aria-expanded={open}
                            onClick={() =>
                              setExpandedActiveRun(open ? null : activeKey)
                            }
                          >
                            <ChevronDown
                              aria-hidden
                              className={cn(
                                "size-3.5 shrink-0 transition-transform",
                                !open && "-rotate-90",
                              )}
                            />
                            <span className="truncate">
                              {active.workflow ?? "Active pipeline"}
                            </span>
                          </Button>
                        </TableCell>
                        <TableCell>
                          <SlugCell
                            slug={active.slug}
                            segment={toWikiSegment(active.title || active.slug)}
                            onNavigate={navigateTo}
                            onNavigateHome={onNavigateHome}
                          />
                        </TableCell>
                        <TableCell>
                          <Badge>In progress</Badge>
                        </TableCell>
                        <TableCell className="truncate text-right">
                          {formatActivePhase(active.phase)}
                        </TableCell>
                        <TableCell className="text-right">Running</TableCell>
                      </TableRow>
                      {open ? (
                        <TableRow className="hover:bg-transparent">
                          <TableCell
                            colSpan={6}
                            className="p-2 whitespace-normal"
                          >
                            <LiveLlmViews views={views} />
                          </TableCell>
                        </TableRow>
                      ) : null}
                    </Fragment>
                  );
                }

                const run = row.item;
                const open = expandedRun === run.run_id;
                return (
                  <Fragment key={run.run_id}>
                    <TableRow
                      className={cn(open && "bg-muted/60 font-semibold")}
                      title={run.error_message ?? "Expand node timing"}
                    >
                      <TableCell title={fmtFullTimestamp(run.started_at)}>
                        {fmtTimestamp(run.started_at)}
                      </TableCell>
                      <TableCell>
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          className="h-auto max-w-full justify-start gap-1.5 p-0 font-mono text-xs hover:bg-transparent"
                          aria-expanded={open}
                          onClick={() => void toggleRun(run.run_id)}
                        >
                          <ChevronDown
                            aria-hidden
                            className={cn(
                              "size-3.5 shrink-0 transition-transform",
                              !open && "-rotate-90",
                            )}
                          />
                          <span className="truncate">{run.workflow}</span>
                        </Button>
                      </TableCell>
                      <TableCell>
                        {run.slug ? (
                          <SlugCell
                            slug={run.slug}
                            segment={toWikiSegment(run.slug)}
                            onNavigate={navigateTo}
                            onNavigateHome={onNavigateHome}
                          />
                        ) : (
                          "—"
                        )}
                      </TableCell>
                      <TableCell>
                        <Badge
                          variant={
                            run.status === "error" ? "destructive" : "secondary"
                          }
                        >
                          {run.status}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-right">
                        {run.nodes_executed}
                      </TableCell>
                      <TableCell className="text-right">
                        {run.duration_ms} ms
                      </TableCell>
                    </TableRow>
                    {open ? (
                      <TableRow className="hover:bg-transparent">
                        <TableCell
                          colSpan={6}
                          className="p-2 whitespace-normal"
                        >
                          {loadingRun === run.run_id ? (
                            <span className="flex items-center gap-2 text-sm text-muted-foreground">
                              <LoaderCircle
                                data-icon="inline-start"
                                className="animate-spin"
                              />
                              Loading trace…
                            </span>
                          ) : runNodes[run.run_id] ? (
                            <NodeBreakdown
                              nodes={runNodes[run.run_id]}
                              totalMs={run.duration_ms}
                              runStartedAt={run.started_at}
                            />
                          ) : null}
                        </TableCell>
                      </TableRow>
                    ) : null}
                  </Fragment>
                );
              })}
            </TableBody>
          </Table>
          {pageCount > 1 && (
            <div className="mt-3 flex items-center gap-3">
              <Button
                variant="outline"
                size="sm"
                onClick={() => setPage((p) => Math.max(0, p - 1))}
                disabled={page === 0}
              >
                ← Prev
              </Button>
              <Badge variant="secondary">
                Page {page + 1} of {pageCount}
              </Badge>
              <Button
                variant="outline"
                size="sm"
                onClick={() => setPage((p) => Math.min(pageCount - 1, p + 1))}
                disabled={page >= pageCount - 1}
              >
                Next →
              </Button>
            </div>
          )}
        </>
      ) : (
        <p className="mt-3 mb-0 text-sm text-muted-foreground italic">
          {traceEnabled
            ? "No recorded pipeline runs."
            : "Pipeline trace storage is disabled."}
        </p>
      )}

      <div className="mt-6 flex flex-wrap items-center justify-between gap-2">
        <h4 className="m-0 text-sm font-semibold">Workflows</h4>
        <Button variant="outline" size="sm" onClick={toggleAllWorkflows}>
          {allExpanded ? "Collapse all" : "Expand all"}
        </Button>
      </div>

      <div className="mt-3 grid grid-cols-1 gap-2 lg:grid-cols-2">
        {workflows.map((workflow) => {
          const open = expandedWorkflows.has(workflow.name);
          return (
            <Card key={workflow.name} size="sm">
              <Collapsible
                open={open}
                onOpenChange={() => toggleWorkflow(workflow.name)}
              >
                <CardHeader>
                  <CollapsibleTrigger className="group/trigger flex w-full cursor-pointer items-center gap-2 border-0 bg-transparent p-0 text-left">
                    <CardTitle className="min-w-0 flex-1 truncate font-mono">
                      {workflow.name}
                    </CardTitle>
                    <ChevronDown
                      aria-hidden
                      className="shrink-0 text-muted-foreground transition-transform group-not-data-[panel-open]/trigger:-rotate-90"
                    />
                  </CollapsibleTrigger>
                </CardHeader>
                <CollapsibleContent>
                  <CardContent className="flex flex-col gap-3 pt-2">
                    <p className="m-0 text-sm text-muted-foreground">
                      {workflow.summary}
                    </p>
                    <div className="flex flex-wrap items-start gap-2">
                      {segmentNodes(workflow.nodes).map((seg, si, all) => {
                        const isLast = si === all.length - 1;
                        if (seg.type === "linear") {
                          return (
                            <span
                              key={si}
                              className="flex flex-wrap items-center gap-1.5"
                            >
                              {seg.nodes.map((node, ni) => (
                                <Fragment key={node.name}>
                                  <WorkflowNodeBadge node={node} />
                                  {ni < seg.nodes.length - 1 ? (
                                    <span className="text-muted-foreground">
                                      →
                                    </span>
                                  ) : null}
                                </Fragment>
                              ))}
                              {!isLast ? (
                                <span className="text-muted-foreground">→</span>
                              ) : null}
                            </span>
                          );
                        }
                        const branchEntries = [...seg.branches.entries()];
                        return (
                          <div key={si} className="flex items-center gap-2">
                            <div className="flex flex-col gap-1.5 border-l border-border pl-2">
                              {branchEntries.map(([label, nodes]) => (
                                <div
                                  key={label}
                                  className="flex flex-wrap items-center gap-1.5"
                                >
                                  <Badge variant="outline" title={label}>
                                    {label}
                                  </Badge>
                                  {nodes.map((node, ni) => (
                                    <Fragment key={node.name}>
                                      <WorkflowNodeBadge node={node} />
                                      {ni < nodes.length - 1 ? (
                                        <span className="text-muted-foreground">
                                          →
                                        </span>
                                      ) : null}
                                    </Fragment>
                                  ))}
                                </div>
                              ))}
                            </div>
                            {!isLast ? (
                              <span className="text-muted-foreground">→</span>
                            ) : null}
                          </div>
                        );
                      })}
                    </div>
                  </CardContent>
                </CollapsibleContent>
              </Collapsible>
            </Card>
          );
        })}
      </div>
    </Pane>
  );
}

function WorkflowNodeBadge({ node }: { node: WorkflowNode }) {
  const variant =
    node.kind === "llm"
      ? "warn"
      : node.kind === "write"
        ? "destructive"
        : node.kind === "read"
          ? "secondary"
          : "outline";
  return (
    <Badge variant={variant} title={node.description ?? node.name}>
      <span className="max-w-56 truncate font-mono">{node.name}</span>
    </Badge>
  );
}

function formatActivePhase(phase?: string): string {
  if (!phase || phase === "starting") return "Starting";
  return phase.replace(/^[^.]+\./, "").replaceAll("_", " ");
}

function fmtK(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}

// The homepage-refresh workflow runs under this reserved pseudo-slug. It is not
// a real article — the homepage lives at "/", so its slug must not be rendered
// as a /wiki/ link.
const HOMEPAGE_PSEUDO_SLUG = "homepage";

// Renders a run's slug as a wiki link. `segment` is the /wiki/ path segment
// (slugs resolve via the server's legacy-slug handling); clicking navigates
// without toggling the row's expansion. The homepage pseudo-slug instead links
// to "/" so it lands on the real homepage rather than a dead /wiki/Homepage.
function SlugCell({
  slug,
  segment,
  onNavigate,
  onNavigateHome,
}: {
  slug: string;
  segment: string;
  onNavigate: (e: MouseEvent, segment: string) => void;
  onNavigateHome?: () => void;
}) {
  if (slug === HOMEPAGE_PSEUDO_SLUG) {
    return (
      <a
        className="font-mono text-xs text-primary underline underline-offset-4"
        href="/"
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          onNavigateHome?.();
        }}
      >
        {slug}
      </a>
    );
  }
  return (
    <a
      className="font-mono text-xs text-primary underline underline-offset-4"
      href={`/wiki/${segment}`}
      onClick={(e) => onNavigate(e, segment)}
    >
      {slug}
    </a>
  );
}

// Clock time for a run/step. Epoch ms in, "HH:MM:SS" out (local time).
function fmtTimestamp(ms: number): string {
  if (!ms) return "";
  return new Date(ms).toLocaleTimeString([], { hour12: false });
}

// Full date + time, for the row's title/hover tooltip.
function fmtFullTimestamp(ms: number): string {
  if (!ms) return "";
  return new Date(ms).toLocaleString();
}

function NodeBreakdown({
  nodes,
  totalMs,
  runStartedAt,
}: {
  nodes: NodeSpan[];
  totalMs: number;
  runStartedAt?: number;
}) {
  const maxMs = Math.max(...nodes.map((node) => node.duration_ms), 1);
  const [openPanels, setOpenPanels] = useState<Set<string>>(new Set());
  function togglePanel(key: string) {
    setOpenPanels((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }
  return (
    <div className="flex flex-col gap-0.5" data-testid="node-breakdown">
      {nodes.map((node, i) => {
        const pct = Math.round((node.duration_ms / Math.max(totalMs, 1)) * 100);
        const barPct = Math.max(
          1,
          Math.round((node.duration_ms / maxMs) * 100),
        );
        const hasMetadata = Boolean(
          node.llm_role || node.llm_model || node.llm_config_key,
        );
        const hasPrompt = Boolean(
          node.prompt_text ||
          node.cot_text ||
          node.response_text ||
          hasMetadata,
        );
        const ragDetail = getRagTraceDetail(node);
        const hasRag = Boolean(ragDetail);
        const promptKey = `${i}:prompt`;
        const ragKey = `${i}:rag`;
        const promptOpen = openPanels.has(promptKey);
        const ragOpen = openPanels.has(ragKey);
        return (
          <Fragment key={i}>
            <div
              className="grid grid-cols-[minmax(9rem,14rem)_5rem_minmax(5rem,1fr)_4.5rem_2.5rem_auto_auto] items-center gap-2 py-0.5 font-mono text-xs tabular-nums max-lg:grid-cols-[minmax(8rem,1fr)_minmax(5rem,1fr)_4.5rem_auto_auto]"
              data-testid="node-timing-row"
              data-node-kind={node.node_kind ?? "unknown"}
            >
              <span
                className="truncate text-muted-foreground"
                title={node.error_message ?? node.node_name}
              >
                {node.node_name}
                {node.status === "error" ? (
                  <span className="text-destructive"> ✕</span>
                ) : null}
              </span>
              <span
                className="text-muted-foreground max-lg:hidden"
                title={
                  node.started_at
                    ? runStartedAt
                      ? `${fmtFullTimestamp(node.started_at)} (+${node.started_at - runStartedAt} ms)`
                      : fmtFullTimestamp(node.started_at)
                    : undefined
                }
              >
                {node.started_at ? fmtTimestamp(node.started_at) : ""}
              </span>
              <span className="h-1.5 overflow-hidden rounded-sm bg-muted">
                <span
                  className={cn(
                    "block h-full min-w-px rounded-sm",
                    nodeBarClass(node.node_kind),
                  )}
                  data-testid="node-timing-bar"
                  style={{ width: `${barPct}%` }}
                />
              </span>
              <span className="text-right text-foreground">
                {node.duration_ms} ms
              </span>
              <span className="text-right text-muted-foreground">{pct}%</span>
              <span className="flex justify-end">
                {node.prompt_chars != null ? (
                  hasPrompt ? (
                    <Button
                      type="button"
                      variant={promptOpen ? "secondary" : "outline"}
                      size="sm"
                      className="h-6 px-1.5 text-[0.68rem]"
                      title="Show prompt, reasoning, and output"
                      onClick={() => togglePanel(promptKey)}
                    >
                      {fmtK(node.prompt_chars)}c
                      <ChevronDown
                        data-icon="inline-end"
                        className={cn(!promptOpen && "-rotate-90")}
                      />
                    </Button>
                  ) : (
                    <Badge variant="outline">{fmtK(node.prompt_chars)}c</Badge>
                  )
                ) : null}
              </span>
              <span className="flex justify-end">
                {hasRag ? (
                  <Button
                    type="button"
                    variant={ragOpen ? "secondary" : "outline"}
                    size="sm"
                    className="h-6 px-1.5 text-[0.68rem]"
                    title="Show retrieved RAG context and selected source segments"
                    onClick={() => togglePanel(ragKey)}
                  >
                    RAG {ragDetail?.displayCount ?? 0}
                    <ChevronDown
                      data-icon="inline-end"
                      className={cn(!ragOpen && "-rotate-90")}
                    />
                  </Button>
                ) : null}
              </span>
            </div>
            {promptOpen && hasPrompt && (
              <div className="flex flex-col gap-1" data-testid="trace-detail">
                {hasMetadata && <LlmMetadata node={node} />}
                {node.prompt_text && (
                  <PromptTraceSections text={node.prompt_text} />
                )}
                {node.cot_text && (
                  <PromptSection
                    label="Chain of thought"
                    text={node.cot_text}
                    variant="cot"
                  />
                )}
                {node.response_text && (
                  <PromptSection
                    label="Output"
                    text={node.response_text}
                    variant="output"
                  />
                )}
              </div>
            )}
            {ragOpen && ragDetail && <RagDetail detail={ragDetail} />}
          </Fragment>
        );
      })}
    </div>
  );
}

function nodeBarClass(kind: string): string {
  switch (kind) {
    case "llm":
      return "bg-orange-500";
    case "read":
      return "bg-blue-500";
    case "write":
      return "bg-red-500";
    case "transform":
      return "bg-green-500";
    case "validate":
      return "bg-purple-500";
    default:
      return "bg-primary";
  }
}

interface RagSourceTrace {
  slug: string;
  title: string;
  content: string;
  score?: number;
}

interface ReferenceTrace {
  slug: string;
  title: string;
  content: string;
  kind?: string;
  pinned?: boolean;
  score?: number;
  source?: string;
}

interface RagTraceDetail {
  promptContext?: string;
  relatedTitlesPrompt?: string;
  promptRefs?: string;
  displayCount: number;
  promptRefCount: number;
  sources: RagSourceTrace[];
  references: ReferenceTrace[];
  ragTitles: string[];
  backlinks: Array<{ slug: string; title: string }>;
}

function getRagTraceDetail(node: NodeSpan): RagTraceDetail | null {
  const patch = asRecord(node.patch);
  const inputs = asRecord(node.inputs);
  const diff = asRecord(node.diff);
  const isLlm = node.node_kind === "llm";
  const retrieved =
    normalizeRetrievedContext(patch?.retrievedContext) ??
    normalizeRetrievedContext(diffAfter(diff, "retrievedContext")) ??
    normalizeRetrievedContext(inputs?.retrievedContext);
  const references =
    normalizeReferences(patch?.references) ??
    normalizeReferences(diffAfter(diff, "references")) ??
    normalizeReferences(inputs?.references) ??
    [];
  const rendered =
    asRecord(patch?.renderedPrompt) ??
    asRecord(diffAfter(diff, "renderedPrompt"));
  const vars = asRecord(rendered?.variables);
  const promptSections = isLlm
    ? extractPromptRagSections(node.prompt_text ?? "")
    : {};
  const promptContext =
    cleanTraceText(vars?.rag_context) ?? promptSections.ragContext;
  const relatedTitlesPrompt =
    cleanTraceText(vars?.related_titles) ?? promptSections.relatedTitles;
  const promptRefs =
    cleanTraceText(vars?.references_prompt_text) ??
    cleanTraceText(vars?.ref_links) ??
    promptSections.promptRefs;

  if (
    !retrieved &&
    references.length === 0 &&
    !promptContext &&
    !relatedTitlesPrompt &&
    !promptRefs
  ) {
    return null;
  }

  const promptRefCount = countPromptRefs(
    [promptContext, relatedTitlesPrompt, promptRefs].filter(Boolean).join("\n"),
  );

  return {
    promptContext,
    relatedTitlesPrompt,
    promptRefs,
    displayCount:
      retrieved?.sources.length || references.length || promptRefCount,
    promptRefCount,
    sources: retrieved?.sources ?? [],
    references,
    ragTitles: retrieved?.ragTitles ?? [],
    backlinks: retrieved?.backlinks ?? [],
  };
}

function RagDetail({ detail }: { detail: RagTraceDetail }) {
  const scoreValues = detail.sources
    .map((s) => s.score)
    .filter((s): s is number => typeof s === "number" && Number.isFinite(s));
  const rows = [
    ["Sources", detail.sources.length ? String(detail.sources.length) : null],
    [
      "References",
      detail.references.length ? String(detail.references.length) : null,
    ],
    [
      "Related titles",
      detail.ragTitles.length ? String(detail.ragTitles.length) : null,
    ],
    [
      "Backlinks",
      detail.backlinks.length ? String(detail.backlinks.length) : null,
    ],
    [
      "Prompt refs",
      detail.promptRefCount ? String(detail.promptRefCount) : null,
    ],
    [
      "Prompt context",
      detail.promptContext
        ? `${detail.promptContext.length.toLocaleString()} chars`
        : null,
    ],
    [
      "Score range",
      scoreValues.length
        ? `${Math.min(...scoreValues).toFixed(3)}-${Math.max(...scoreValues).toFixed(3)}`
        : null,
    ],
  ].filter((row): row is [string, string] => Boolean(row[1]));

  return (
    <div className="flex flex-col gap-2" data-testid="trace-detail">
      <TraceMetadata rows={rows} />
      {detail.promptContext && (
        <PromptSection
          label="RAG context in prompt"
          text={detail.promptContext}
        />
      )}
      {detail.sources.length > 0 && (
        <PromptSection
          label="Retrieved source segments"
          text={formatRagSources(detail.sources)}
        />
      )}
      {detail.references.length > 0 && (
        <PromptSection
          label="Reference list after step"
          text={formatReferences(detail.references)}
        />
      )}
      {detail.relatedTitlesPrompt && (
        <PromptSection
          label="Related titles in prompt"
          text={detail.relatedTitlesPrompt}
        />
      )}
      {detail.promptRefs && (
        <PromptSection
          label="Reference context in prompt"
          text={detail.promptRefs}
        />
      )}
      {detail.backlinks.length > 0 && (
        <PromptSection
          label="Backlinks"
          text={detail.backlinks
            .map((b) => `- ${b.title} (${b.slug})`)
            .join("\n")}
        />
      )}
    </div>
  );
}

function formatRagSources(sources: RagSourceTrace[]): string {
  return sources
    .map((s, i) => {
      const meta = [
        `slug: ${s.slug}`,
        typeof s.score === "number" ? `score: ${s.score.toFixed(3)}` : null,
      ]
        .filter(Boolean)
        .join(" · ");
      return `## ${i + 1}. ${s.title}\n${meta}\n\n${s.content}`;
    })
    .join("\n\n---\n\n");
}

function formatReferences(references: ReferenceTrace[]): string {
  return references
    .map((r, i) => {
      const meta = [
        `slug: ${r.slug}`,
        r.source ? `source: ${r.source}` : null,
        r.kind ? `kind: ${r.kind}` : null,
        r.pinned ? "pinned" : null,
        typeof r.score === "number" ? `score: ${r.score.toFixed(3)}` : null,
      ]
        .filter(Boolean)
        .join(" · ");
      return `## ${i + 1}. ${r.title}\n${meta}\n\n${r.content}`;
    })
    .join("\n\n---\n\n");
}

function normalizeRetrievedContext(value: unknown): {
  sources: RagSourceTrace[];
  ragTitles: string[];
  backlinks: Array<{ slug: string; title: string }>;
} | null {
  const obj = asRecord(value);
  if (!obj) return null;
  const sources = Array.isArray(obj.sourceArticles)
    ? obj.sourceArticles
        .map(normalizeRagSource)
        .filter((s): s is RagSourceTrace => Boolean(s))
    : [];
  const ragTitles = Array.isArray(obj.ragTitles)
    ? obj.ragTitles.filter((t): t is string => typeof t === "string")
    : [];
  const backlinks = Array.isArray(obj.backlinks)
    ? obj.backlinks
        .map(normalizeBacklink)
        .filter((b): b is { slug: string; title: string } => Boolean(b))
    : [];
  if (sources.length === 0 && ragTitles.length === 0 && backlinks.length === 0)
    return null;
  return { sources, ragTitles, backlinks };
}

function normalizeReferences(value: unknown): ReferenceTrace[] | null {
  if (!Array.isArray(value)) return null;
  const refs = value
    .map(normalizeReference)
    .filter((r): r is ReferenceTrace => Boolean(r));
  return refs;
}

function normalizeReference(value: unknown): ReferenceTrace | null {
  const obj = asRecord(value);
  if (!obj) return null;
  const slug = typeof obj.slug === "string" ? obj.slug : "";
  const title = typeof obj.title === "string" ? obj.title : slug;
  const content = typeof obj.content === "string" ? obj.content : "";
  const kind = typeof obj.kind === "string" ? obj.kind : undefined;
  const source = typeof obj.source === "string" ? obj.source : undefined;
  const pinned = typeof obj.pinned === "boolean" ? obj.pinned : undefined;
  const score = typeof obj.score === "number" ? obj.score : undefined;
  if (!slug && !title && !content) return null;
  return { slug, title, content, kind, source, pinned, score };
}

function PromptTraceSections({ text }: { text: string }) {
  const split = splitPromptTrace(text);
  if (!split) return <PromptSection label="Prompt" text={text} />;
  return (
    <>
      <PromptSection label="System prompt" text={split.system} />
      <PromptSection label="User prompt" text={split.user} />
    </>
  );
}

function splitPromptTrace(
  text: string,
): { system: string; user: string } | null {
  const match = text.match(/^### System\n([\s\S]*?)\n\n### User\n([\s\S]*)$/);
  if (!match) return null;
  return { system: match[1].trim(), user: match[2].trim() };
}

function extractPromptRagSections(promptText: string): {
  ragContext?: string;
  relatedTitles?: string;
  promptRefs?: string;
} {
  const split = splitPromptTrace(promptText);
  const user = split?.user ?? promptText;
  return {
    ragContext: extractLabeledBlock(user, /^Retrieved context\b.*:/im, [
      /^Suggested related existing topics\b.*:/im,
      /^Output\b/im,
    ]),
    relatedTitles: extractLabeledBlock(
      user,
      /^Suggested related existing topics\b.*:/im,
      [/^Output\b/im],
    ),
    promptRefs:
      extractLabeledBlock(user, /^References\s+[—–-].*$/im, [
        /^Retrieved context\b.*:/im,
        /^Suggested related existing topics\b.*:/im,
        /^Recent edit history\b.*:/im,
        /^Output\b/im,
      ]) ??
      extractLabeledBlock(user, /^Known encyclopedia articles\b.*:/im, [
        /^Generate the infobox JSON\b/im,
        /^Output\b/im,
      ]),
  };
}

function extractLabeledBlock(
  text: string,
  startPattern: RegExp,
  endPatterns: RegExp[],
): string | undefined {
  const start = startPattern.exec(text);
  if (!start || start.index == null) return undefined;
  const bodyStart = start.index + start[0].length;
  const rest = text.slice(bodyStart);
  let end = rest.length;
  for (const pattern of endPatterns) {
    const match = pattern.exec(rest);
    if (match && match.index != null) end = Math.min(end, match.index);
  }
  return cleanTraceText(rest.slice(0, end));
}

function countPromptRefs(text: string): number {
  const refs = new Set<string>();
  for (const match of text.matchAll(/\(ref:([^)]+)\)/g)) {
    const slug = match[1]?.trim();
    if (slug) refs.add(slug);
  }
  if (refs.size > 0) return refs.size;
  const nonEmptyLines = text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  return nonEmptyLines.length;
}

function normalizeRagSource(value: unknown): RagSourceTrace | null {
  const obj = asRecord(value);
  if (!obj) return null;
  const slug = typeof obj.slug === "string" ? obj.slug : "";
  const title = typeof obj.title === "string" ? obj.title : slug;
  const content = typeof obj.content === "string" ? obj.content : "";
  const score = typeof obj.score === "number" ? obj.score : undefined;
  if (!slug && !title && !content) return null;
  return { slug, title, content, score };
}

function normalizeBacklink(
  value: unknown,
): { slug: string; title: string } | null {
  const obj = asRecord(value);
  if (!obj) return null;
  const slug = typeof obj.slug === "string" ? obj.slug : "";
  const title = typeof obj.title === "string" ? obj.title : slug;
  if (!slug && !title) return null;
  return { slug, title };
}

function diffAfter(diff: Record<string, unknown> | null, key: string): unknown {
  const entry = asRecord(diff?.[key]);
  return entry?.after;
}

function cleanTraceText(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = value.trim();
  if (!text || text === "(none)" || text === "(none yet)") return undefined;
  return text;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function boolText(value: number | boolean | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  return value === true || value === 1 ? "on" : "off";
}

function LlmMetadata({ node }: { node: NodeSpan }) {
  const role =
    node.llm_resolved_role &&
    node.llm_role &&
    node.llm_resolved_role !== node.llm_role
      ? `${node.llm_role} -> ${node.llm_resolved_role}`
      : node.llm_role;
  const rows = [
    ["Config", node.llm_config_key],
    ["Role", role],
    ["Model", node.llm_model],
    ["Host", node.llm_host],
    ["Base URL", node.llm_base_url],
    [
      "Temperature",
      node.llm_temperature == null ? null : String(node.llm_temperature),
    ],
    [
      "Max tokens",
      node.llm_max_tokens == null ? null : String(node.llm_max_tokens),
    ],
    ["Top K", node.llm_top_k == null ? null : String(node.llm_top_k)],
    ["Top P", node.llm_top_p == null ? null : String(node.llm_top_p)],
    ["Min P", node.llm_min_p == null ? null : String(node.llm_min_p)],
    ["TTFT", node.llm_ttft_ms == null ? null : `${node.llm_ttft_ms} ms`],
    ["Thinking", boolText(node.llm_thinking)],
    ["JSON mode", boolText(node.llm_json_mode)],
    [
      "Images",
      node.llm_image_count == null ? null : String(node.llm_image_count),
    ],
  ].filter((row): row is [string, string] => Boolean(row[1]));

  if (rows.length === 0) return null;
  return <TraceMetadata rows={rows} />;
}

function TraceMetadata({ rows }: { rows: Array<[string, string]> }) {
  return (
    <dl className="grid grid-cols-[repeat(auto-fit,minmax(11rem,1fr))] gap-x-3 gap-y-1 rounded-md bg-muted/50 px-2 py-1.5 font-mono text-[0.7rem]">
      {rows.map(([label, value]) => (
        <div key={label} className="flex min-w-0 gap-1.5">
          <dt className="shrink-0 text-muted-foreground">{label}</dt>
          <dd className="m-0 min-w-0 truncate text-foreground" title={value}>
            {value}
          </dd>
        </div>
      ))}
    </dl>
  );
}

const PromptSection = memo(function PromptSection({
  label,
  text,
  variant,
}: {
  label: string;
  text: string;
  variant?: "cot" | "output";
}) {
  const [mode, setMode] = useState<"source" | "rendered">("rendered");
  const copy = () => {
    void navigator.clipboard?.writeText(text).catch(() => {});
  };
  const html = useMemo(
    () => (mode === "rendered" ? md.render(text) : ""),
    [mode, text],
  );
  const lineCount = text.split("\n").length;
  return (
    <Card size="sm" data-testid="prompt-section">
      <CardHeader>
        <CardTitle>{label}</CardTitle>
        <CardDescription>
          {text.length.toLocaleString()} chars · {lineCount.toLocaleString()}
          {" lines"}
        </CardDescription>
        <CardAction>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={copy}
            title="Copy to clipboard"
          >
            Copy
          </Button>
        </CardAction>
      </CardHeader>
      <CardContent>
        <Tabs
          value={mode}
          onValueChange={(value) => setMode(value as "source" | "rendered")}
        >
          <TabsList variant="line">
            <TabsTrigger value="rendered">Rendered</TabsTrigger>
            <TabsTrigger value="source">Source</TabsTrigger>
          </TabsList>
          <TabsContent value="rendered">
            {/* font-serif: this lives inside a font-mono trace table, so the
                prose would otherwise inherit monospace. max-h/overflow: nested
                scroll (requested), which also clips the rasterized area. */}
            <div
              data-testid="markdown-trace"
              className={cn(
                "prose-halu prose prose-sm max-h-80 max-w-none overflow-auto font-serif",
                variant === "cot" && "italic",
              )}
              dangerouslySetInnerHTML={{ __html: html }}
            />
          </TabsContent>
          <TabsContent value="source">
            <pre
              data-testid="trace-source"
              aria-label={`${label} source`}
              className="max-h-80 overflow-auto rounded-md border border-input px-2.5 py-2 font-mono text-xs whitespace-pre-wrap"
            >{text}</pre>
          </TabsContent>
        </Tabs>
      </CardContent>
    </Card>
  );
});
