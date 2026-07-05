import {
  Fragment,
  memo,
  useEffect,
  useMemo,
  useState,
  type MouseEvent,
} from "react";
import {
  AlertTriangle,
  ChevronDown,
  GitBranch,
  LoaderCircle,
} from "lucide-react";
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
import { Separator } from "@/components/ui/separator";
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
import {
  normalizeOntologyExtraction,
  OntologyFacts,
  type OntologyExtractionTrace,
} from "./OntologyTraceDetail";

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
  warning_count?: number;
  warning_messages?: string[];
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
  prompt_tokens?: number | null;
  system_prompt_tokens?: number | null;
  user_prompt_tokens?: number | null;
  cot_text?: string | null;
  cot_tokens?: number | null;
  response_text?: string | null;
  response_tokens?: number | null;
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
  llm_calls?: LlmCallSpan[];
  /** Byte-exact RAG values placed into the prompt (render nodes); server-tokenized. */
  rag?: RagExactCapture | null;
}

interface LlmCallSpan {
  promptChars: number;
  prompt: string;
  promptTokens?: number | null;
  systemPromptTokens?: number | null;
  userPromptTokens?: number | null;
  cot: string;
  cotTokens?: number | null;
  response: string;
  responseTokens?: number | null;
  role: string;
  resolvedRole?: string;
  configKey?: string;
  model?: string;
  baseUrl?: string;
  host?: string;
  temperature?: number;
  maxTokens?: number;
  topK?: number;
  topP?: number;
  minP?: number;
  thinking?: boolean;
  jsonMode?: boolean;
  imageCount?: number;
  ttftMs?: number;
}

/**
 * The exact RAG variable values a render node interpolated into the prompt, with
 * server-side tiktoken counts. Distinct from the reconstructed view: these are
 * the literal strings the model received — evidence and link allowlist kept
 * separate. Surfaced via the `rag_json` trace column at every trace level.
 */
interface RagExactCapture {
  promptKey: string;
  evidenceContext: string;
  linkAllowlist: string;
  relatedTitles: string;
  linkHints: string;
  articleVibe: string;
  retrieval: {
    strategy?: string;
    model?: string;
    host?: string;
    dimensions?: number;
    candidates: Array<{
      slug: string;
      title: string;
      score?: number;
      contentChars: number;
    }>;
  };
  tokens: {
    evidence: number;
    links: number;
    relatedTitles: number;
    linkHints: number;
    vibe: number;
  };
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

      {/* In-progress articles lead the run history. */}
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
            containerClassName="mt-3 rounded-lg border border-border max-[700px]:overflow-x-hidden"
            className="w-full table-fixed font-mono text-xs tabular-nums max-[700px]:text-[0.7rem] [&_td]:px-1.5 [&_td]:py-1 [&_th]:h-7 [&_th]:px-1.5"
          >
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead className="h-8 w-24 max-[700px]:hidden">
                  Started
                </TableHead>
                <TableHead className="w-[28%] max-[700px]:w-[48%]">
                  Workflow
                </TableHead>
                <TableHead className="max-[700px]:w-[32%]">Article</TableHead>
                <TableHead className="w-24 max-[700px]:w-[20%]">
                  Status
                </TableHead>
                <TableHead className="w-16 text-right max-[700px]:hidden">
                  Nodes
                </TableHead>
                <TableHead className="w-24 text-right max-[700px]:hidden">
                  Duration
                </TableHead>
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
                        <TableCell
                          className="max-[700px]:hidden"
                          title={fmtFullTimestamp(active.startedAt)}
                        >
                          {fmtTimestamp(active.startedAt)}
                        </TableCell>
                        <TableCell className="min-w-0">
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            className="h-auto w-full max-w-full justify-start gap-1.5 p-0 font-mono text-xs hover:bg-transparent max-[700px]:text-[0.7rem]"
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
                          <span className="mt-0.5 hidden truncate text-[0.65rem] font-normal text-muted-foreground max-[700px]:block">
                            {fmtTimestamp(active.startedAt)} ·{" "}
                            {formatActivePhase(active.phase)}
                          </span>
                        </TableCell>
                        <TableCell>
                          <SlugCell
                            slug={active.slug}
                            segment={toWikiSegment(
                              active.title || slugToTraceTitle(active.slug),
                            )}
                            onNavigate={navigateTo}
                            onNavigateHome={onNavigateHome}
                          />
                        </TableCell>
                        <TableCell>
                          <Badge>In progress</Badge>
                        </TableCell>
                        <TableCell className="truncate text-right max-[700px]:hidden">
                          {formatActivePhase(active.phase)}
                        </TableCell>
                        <TableCell className="text-right max-[700px]:hidden">
                          Running
                        </TableCell>
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
                const warningCount = run.warning_count ?? 0;
                const warningMessages = normalizeWarnings(run.warning_messages);
                const displayStatus =
                  run.status === "ok" && warningCount > 0
                    ? "partial"
                    : run.status;
                return (
                  <Fragment key={run.run_id}>
                    <TableRow
                      className={cn(
                        open && "bg-muted/60 font-semibold",
                        displayStatus === "partial" &&
                          "bg-amber-50/50 dark:bg-amber-950/20",
                      )}
                      title={
                        run.error_message ??
                        warningMessages[0] ??
                        "Expand node timing"
                      }
                    >
                      <TableCell
                        className="max-[700px]:hidden"
                        title={fmtFullTimestamp(run.started_at)}
                      >
                        {fmtTimestamp(run.started_at)}
                      </TableCell>
                      <TableCell className="min-w-0">
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          className="h-auto w-full max-w-full justify-start gap-1.5 p-0 font-mono text-xs hover:bg-transparent max-[700px]:text-[0.7rem]"
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
                        <span
                          className="mt-0.5 hidden truncate text-[0.65rem] font-normal text-muted-foreground max-[700px]:block"
                          data-testid="run-mobile-metadata"
                        >
                          {fmtTimestamp(run.started_at)} · {run.nodes_executed}{" "}
                          {run.nodes_executed === 1 ? "node" : "nodes"} ·{" "}
                          {run.duration_ms} ms
                        </span>
                      </TableCell>
                      <TableCell>
                        {run.slug ? (
                          <SlugCell
                            slug={run.slug}
                            segment={toWikiSegment(slugToTraceTitle(run.slug))}
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
                            displayStatus === "error"
                              ? "destructive"
                              : "secondary"
                          }
                          className={cn(
                            displayStatus === "partial" &&
                              "gap-1 border border-amber-300 bg-amber-100 text-amber-900 dark:border-amber-700 dark:bg-amber-950/50 dark:text-amber-100",
                          )}
                        >
                          {displayStatus === "partial" ? (
                            <AlertTriangle
                              data-icon="inline-start"
                              className="size-3"
                            />
                          ) : null}
                          {displayStatus}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-right max-[700px]:hidden">
                        {run.nodes_executed}
                      </TableCell>
                      <TableCell className="text-right max-[700px]:hidden">
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
                    {!open && run.status === "error" && run.error_message ? (
                      <TableRow className="hover:bg-transparent">
                        <TableCell
                          colSpan={6}
                          className="px-2 pt-0 pb-2 whitespace-normal"
                        >
                          <p className={cn(ERROR_BOX, "m-0 text-xs")}>
                            {run.error_message}
                          </p>
                        </TableCell>
                      </TableRow>
                    ) : null}
                    {!open &&
                    displayStatus === "partial" &&
                    warningMessages.length ? (
                      <TableRow className="hover:bg-transparent">
                        <TableCell
                          colSpan={6}
                          className="px-2 pt-0 pb-2 whitespace-normal"
                        >
                          <p className="m-0 rounded-md border border-amber-300/80 bg-amber-50 px-2 py-1.5 text-xs text-amber-900 dark:border-amber-700/80 dark:bg-amber-950/40 dark:text-amber-100">
                            {warningMessages[0]}
                            {warningCount > 1
                              ? ` (+${warningCount - 1} more)`
                              : ""}
                          </p>
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
        <Badge variant="outline">{workflows.length} workflows</Badge>
      </div>

      <div className="mt-3 grid grid-cols-1 gap-2 lg:grid-cols-2">
        {workflows.map((workflow) => (
          <Card key={workflow.name} size="sm">
            <CardHeader>
              <CardTitle className="font-mono">{workflow.name}</CardTitle>
              <CardDescription>
                {workflow.description ?? workflow.summary}
              </CardDescription>
              <CardAction>
                <Badge variant="outline">
                  {workflow.nodes.length}{" "}
                  {workflow.nodes.length === 1 ? "node" : "nodes"}
                </Badge>
              </CardAction>
            </CardHeader>
            <CardContent>
              <ol
                className="flex flex-col"
                data-testid="workflow-flow"
                aria-label={`${workflow.name} workflow`}
              >
                {workflow.nodes.map((node, index) => (
                  <WorkflowNodeStep
                    key={`${node.name}:${index}`}
                    node={node}
                    index={index}
                    isLast={index === workflow.nodes.length - 1}
                  />
                ))}
              </ol>
            </CardContent>
          </Card>
        ))}
      </div>
    </Pane>
  );
}

function WorkflowNodeStep({
  node,
  index,
  isLast,
}: {
  node: WorkflowNode;
  index: number;
  isLast: boolean;
}) {
  const variant =
    node.kind === "llm"
      ? "warn"
      : node.kind === "write"
        ? "destructive"
        : node.kind === "read"
          ? "secondary"
          : "outline";
  return (
    <li className="grid grid-cols-[auto_minmax(0,1fr)] gap-2">
      <div className="flex flex-col items-center gap-1">
        <Badge variant="outline" aria-label={`Step ${index + 1}`}>
          {index + 1}
        </Badge>
        {!isLast ? (
          <Separator orientation="vertical" className="min-h-4 flex-1" />
        ) : null}
      </div>
      <div className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-1 pb-2">
        <Badge variant={variant}>{node.kind}</Badge>
        <span className="min-w-0 flex-1 break-words text-xs">
          <span className="font-mono font-medium break-all">{node.name}</span>
          <span className="text-muted-foreground">
            {" "}
            — {node.description ?? "No description."}
          </span>
        </span>
        {node.conditional ? (
          <Badge variant="outline">
            <GitBranch data-icon="inline-start" />
            {node.whenLabel ?? "conditional"}
          </Badge>
        ) : null}
      </div>
    </li>
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
  // Slugs can be long and hyphen-free; break anywhere so they wrap inside the
  // fixed-width Article column instead of overflowing it.
  // whitespace-normal overrides the table cell's default nowrap so the slug can
  // actually wrap; overflow-wrap:anywhere breaks long hyphen-free slugs.
  const linkClass =
    "font-mono text-xs text-primary underline underline-offset-4 whitespace-normal [overflow-wrap:anywhere]";
  if (slug === HOMEPAGE_PSEUDO_SLUG) {
    return (
      <a
        className={linkClass}
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
      className={linkClass}
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

function nodeLlmCalls(node: NodeSpan): NodeSpan[] {
  if (node.llm_calls?.length) {
    return node.llm_calls.map((call) => ({
      node_name: node.node_name,
      node_kind: node.node_kind,
      duration_ms: node.duration_ms,
      status: node.status,
      prompt_chars: call.promptChars,
      prompt_text: call.prompt,
      prompt_tokens: call.promptTokens,
      system_prompt_tokens: call.systemPromptTokens,
      user_prompt_tokens: call.userPromptTokens,
      cot_text: call.cot,
      cot_tokens: call.cotTokens,
      response_text: call.response,
      response_tokens: call.responseTokens,
      llm_role: call.role,
      llm_resolved_role: call.resolvedRole,
      llm_config_key: call.configKey,
      llm_model: call.model,
      llm_base_url: call.baseUrl,
      llm_host: call.host,
      llm_temperature: call.temperature,
      llm_max_tokens: call.maxTokens,
      llm_top_k: call.topK,
      llm_top_p: call.topP,
      llm_min_p: call.minP,
      llm_thinking: call.thinking,
      llm_json_mode: call.jsonMode,
      llm_image_count: call.imageCount,
      llm_ttft_ms: call.ttftMs,
    }));
  }
  return node.prompt_text ||
    node.cot_text ||
    node.response_text ||
    node.llm_role
    ? [node]
    : [];
}

function traceTokenCount(node: NodeSpan): number {
  return (
    (node.prompt_tokens ?? 0) +
    (node.cot_tokens ?? 0) +
    (node.response_tokens ?? 0)
  );
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
        const llmCalls = nodeLlmCalls(node);
        const hasPrompt = llmCalls.length > 0;
        const llmTokens = llmCalls.reduce(
          (total, call) => total + traceTokenCount(call),
          0,
        );
        const ragDetail = getRagTraceDetail(node);
        const hasRag = Boolean(ragDetail);
        const ontologyDetail = getOntologyTraceDetail(node);
        const hasOntology = Boolean(ontologyDetail);
        const warnings = normalizeWarnings(node.warnings);
        const promptKey = `${i}:prompt`;
        const ragKey = `${i}:rag`;
        const ontologyKey = `${i}:ontology`;
        const promptOpen = openPanels.has(promptKey);
        const ragOpen = openPanels.has(ragKey);
        const ontologyOpen = openPanels.has(ontologyKey);
        return (
          <Fragment key={i}>
            <div
              className="grid grid-cols-[minmax(9rem,14rem)_5rem_minmax(5rem,1fr)_4.5rem_2.5rem_auto] items-center gap-2 py-0.5 font-mono text-xs tabular-nums max-[700px]:grid-cols-[minmax(0,1fr)_4.5rem_auto] max-[700px]:gap-1 max-[700px]:text-[0.7rem] max-lg:grid-cols-[minmax(8rem,1fr)_minmax(5rem,1fr)_4.5rem_2.5rem_auto]"
              data-testid="node-timing-row"
              data-node-kind={node.node_kind ?? "unknown"}
            >
              <div className="min-w-0">
                <span
                  className="block truncate text-muted-foreground"
                  title={node.error_message ?? node.node_name}
                >
                  {node.node_name}
                  {node.status === "error" ? (
                    <span className="text-destructive"> ✕</span>
                  ) : null}
                </span>
                <NodeTimingBar barPct={barPct} kind={node.node_kind} mobile />
              </div>
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
              <NodeTimingBar barPct={barPct} kind={node.node_kind} />
              <span className="text-right text-foreground">
                {node.duration_ms} ms
              </span>
              <span className="text-right text-muted-foreground max-[700px]:hidden">
                {pct}%
              </span>
              <span className="flex items-center justify-end gap-1">
                {hasPrompt ? (
                  <Button
                    type="button"
                    variant={promptOpen ? "secondary" : "outline"}
                    size="sm"
                    className="h-6 px-1.5 text-[0.68rem]"
                    title="Show prompt, reasoning, and output"
                    onClick={() => togglePanel(promptKey)}
                  >
                    {llmCalls.length > 1 && `${llmCalls.length} calls · `}
                    {llmTokens.toLocaleString()}t
                    <ChevronDown
                      data-icon="inline-end"
                      className={cn(!promptOpen && "-rotate-90")}
                    />
                  </Button>
                ) : null}
                {warnings.length ? (
                  <Badge
                    variant="outline"
                    className="h-6 gap-1 border-amber-300 text-amber-700 dark:border-amber-700 dark:text-amber-300"
                    title={warnings.join("\n")}
                  >
                    <AlertTriangle
                      data-icon="inline-start"
                      className="size-3"
                    />
                    {warnings.length}
                  </Badge>
                ) : null}
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
                {hasOntology ? (
                  <Button
                    type="button"
                    variant={ontologyOpen ? "secondary" : "outline"}
                    size="sm"
                    className="h-6 px-1.5 text-[0.68rem]"
                    title="Show entities/relations/categories extracted for this article"
                    onClick={() => togglePanel(ontologyKey)}
                  >
                    Ontology {ontologyDetail?.relations ?? 0}
                    <ChevronDown
                      data-icon="inline-end"
                      className={cn(!ontologyOpen && "-rotate-90")}
                    />
                  </Button>
                ) : null}
              </span>
            </div>
            {promptOpen && hasPrompt && (
              <div className="flex flex-col gap-1" data-testid="trace-detail">
                {llmCalls.map((call, callIndex) => (
                  <LlmCallDetail
                    key={callIndex}
                    call={call}
                    index={callIndex}
                    count={llmCalls.length}
                  />
                ))}
              </div>
            )}
            {ragOpen && ragDetail && <RagDetail detail={ragDetail} />}
            {ontologyOpen && ontologyDetail && (
              <OntologyDetail detail={ontologyDetail} />
            )}
            {warnings.length ? (
              <div className="rounded-md border border-amber-300/80 bg-amber-50 px-2 py-1.5 text-xs text-amber-900 dark:border-amber-700/80 dark:bg-amber-950/40 dark:text-amber-100">
                {warnings.map((warning, warningIndex) => (
                  <p key={warningIndex} className="m-0">
                    {warning}
                  </p>
                ))}
              </div>
            ) : null}
          </Fragment>
        );
      })}
    </div>
  );
}

function NodeTimingBar({
  barPct,
  kind,
  mobile = false,
}: {
  barPct: number;
  kind: string;
  mobile?: boolean;
}) {
  return (
    <span
      className={cn(
        "h-1.5 overflow-hidden rounded-sm bg-muted",
        mobile ? "mt-1 hidden max-[700px]:block" : "max-[700px]:hidden",
      )}
    >
      <span
        className={cn("block h-full min-w-px rounded-sm", nodeBarClass(kind))}
        data-testid={mobile ? "node-timing-bar-mobile" : "node-timing-bar"}
        style={{ width: `${barPct}%` }}
      />
    </span>
  );
}

function normalizeWarnings(warnings: unknown): string[] {
  if (!Array.isArray(warnings)) return [];
  return warnings
    .map((warning) => (typeof warning === "string" ? warning.trim() : ""))
    .filter(Boolean);
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

interface EmbeddingTrace {
  strategy: string;
  model?: string;
  host?: string;
  baseUrl?: string;
  dimensions?: number;
  corpusChunks?: number;
  embeddedChunks?: number;
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
  embedding?: EmbeddingTrace;
  /** Byte-exact capture (render nodes) — authoritative over the reconstruction. */
  exact?: RagExactCapture;
}

interface OntologyTraceDetail {
  entities: number;
  relations: number;
  categories: number;
  llmEnabled: boolean;
  llmReason?: string;
  extraction?: OntologyExtractionTrace;
}

const LLM_REASON_LABEL: Record<string, string> = {
  first_extraction: "first extraction — never run for this article before",
  content_changed: "article body changed since the last extraction",
  vocabulary_changed: "ontology vocabulary changed since the last extraction",
  cache_hit: "cache hit — content and vocabulary unchanged, model not called",
};

/** Extraction summary written by write.extract_ontology (patch, falling back
 *  to diff so it's visible at the default "normal" trace level). */
function getOntologyTraceDetail(node: NodeSpan): OntologyTraceDetail | null {
  if (node.node_name !== "write.extract_ontology") return null;
  const patch = asRecord(node.patch);
  const diff = asRecord(node.diff);
  const summary =
    asRecord(patch?.ontologyExtraction) ??
    asRecord(diffAfter(diff, "ontologyExtraction"));
  if (!summary) return null;
  return {
    entities: typeof summary.entities === "number" ? summary.entities : 0,
    relations: typeof summary.relations === "number" ? summary.relations : 0,
    categories: typeof summary.categories === "number" ? summary.categories : 0,
    llmEnabled: summary.llmEnabled === true,
    llmReason:
      typeof summary.llmReason === "string" ? summary.llmReason : undefined,
    extraction: normalizeOntologyExtraction(summary.extraction),
  };
}

function OntologyDetail({ detail }: { detail: OntologyTraceDetail }) {
  const rows: Array<[string, string]> = [
    ["LLM extraction", detail.llmEnabled ? "on" : "off (deterministic only)"],
  ];
  if (!detail.extraction) {
    rows.unshift(
      ["Entities", String(detail.entities)],
      ["Relations", String(detail.relations)],
      ["Categories", String(detail.categories)],
    );
  }
  if (detail.llmEnabled) {
    rows.push([
      "Why the model ran",
      detail.llmReason
        ? (LLM_REASON_LABEL[detail.llmReason] ?? detail.llmReason)
        : "n/a",
    ]);
  }
  const extraction = detail.extraction;
  return (
    <div className="flex flex-col gap-2" data-testid="trace-detail">
      <TraceMetadata rows={rows} />
      {extraction && <OntologyFacts extraction={extraction} />}
    </div>
  );
}

function getRagTraceDetail(node: NodeSpan): RagTraceDetail | null {
  // Prefer the byte-exact render-node capture when present: it is the literal
  // text the model received, with server-computed token counts.
  const exact =
    node.rag && typeof node.rag === "object"
      ? (node.rag as RagExactCapture)
      : undefined;
  if (exact) {
    return {
      promptContext: exact.evidenceContext || undefined,
      relatedTitlesPrompt: exact.relatedTitles || undefined,
      promptRefs: exact.linkAllowlist || undefined,
      displayCount: exact.retrieval.candidates.length,
      promptRefCount: countPromptRefs(exact.linkAllowlist),
      sources: [],
      references: [],
      ragTitles: [],
      backlinks: [],
      embedding: exact.retrieval.strategy
        ? {
            strategy: exact.retrieval.strategy,
            model: exact.retrieval.model,
            host: exact.retrieval.host,
            dimensions: exact.retrieval.dimensions,
          }
        : undefined,
      exact,
    };
  }
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
    embedding: retrieved?.embedding,
  };
}

/**
 * Byte-exact RAG view: the literal values a render node placed into the prompt,
 * with server-side token counts. Evidence and the link allowlist are shown as
 * separate sections — a reference being linkable does not mean its text was in
 * the prompt. This is exactly what the model received.
 */
function RagExactDetail({ capture }: { capture: RagExactCapture }) {
  const r = capture.retrieval;
  const scoreValues = r.candidates
    .map((c) => c.score)
    .filter((s): s is number => typeof s === "number" && Number.isFinite(s));
  const rows = [
    ["Prompt template", capture.promptKey],
    ["Retrieval strategy", r.strategy ?? null],
    ["Embedding model", r.model ?? null],
    ["Embedding host", r.host ?? null],
    ["Embedding dims", r.dimensions ? String(r.dimensions) : null],
    ["Candidate articles", String(r.candidates.length)],
    [
      "Score range",
      scoreValues.length
        ? `${Math.min(...scoreValues).toFixed(3)}–${Math.max(...scoreValues).toFixed(3)}`
        : null,
    ],
    ["Evidence tokens", `${capture.tokens.evidence.toLocaleString()}t`],
    ["Link allowlist tokens", `${capture.tokens.links.toLocaleString()}t`],
  ].filter((row): row is [string, string] => Boolean(row[1]));

  const candidatesText = r.candidates
    .map((c, i) => {
      const meta = [
        `slug: ${c.slug}`,
        typeof c.score === "number" ? `score: ${c.score.toFixed(3)}` : null,
        `${c.contentChars.toLocaleString()} chars`,
      ]
        .filter(Boolean)
        .join(" · ");
      return `${i + 1}. ${c.title}\n   ${meta}`;
    })
    .join("\n");

  return (
    <div className="flex flex-col gap-2" data-testid="trace-detail">
      <p className="m-0 text-[0.7rem] text-muted-foreground">
        Byte-exact — the literal RAG values placed into this prompt. Evidence
        and the link allowlist are separate: a linkable reference does not imply
        its text was included.
      </p>
      <TraceMetadata rows={rows} />
      {candidatesText && (
        <PromptSection
          label={`Candidate articles (${r.candidates.length})`}
          text={candidatesText}
        />
      )}
      {capture.evidenceContext && (
        <PromptSection
          label="Evidence context — sent to model"
          text={capture.evidenceContext}
          promptTokens={capture.tokens.evidence}
        />
      )}
      {capture.linkAllowlist && (
        <PromptSection
          label="Link allowlist — sent to model"
          text={capture.linkAllowlist}
          promptTokens={capture.tokens.links}
        />
      )}
      {capture.relatedTitles && (
        <PromptSection
          label="Related titles — sent to model"
          text={capture.relatedTitles}
          promptTokens={capture.tokens.relatedTitles}
        />
      )}
      {capture.linkHints && capture.linkHints !== "(none)" && (
        <PromptSection
          label="Link hints — sent to model"
          text={capture.linkHints}
          promptTokens={capture.tokens.linkHints}
        />
      )}
      {capture.articleVibe && (
        <PromptSection
          label="Article vibe — sent to model"
          text={capture.articleVibe}
          promptTokens={capture.tokens.vibe}
        />
      )}
    </div>
  );
}

function RagDetail({ detail }: { detail: RagTraceDetail }) {
  if (detail.exact) return <RagExactDetail capture={detail.exact} />;
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
        ? `${detail.promptContext.length.toLocaleString()} chars · ~${estimateTokens(detail.promptContext).toLocaleString()}t`
        : null,
    ],
    [
      "Score range",
      scoreValues.length
        ? `${Math.min(...scoreValues).toFixed(3)}-${Math.max(...scoreValues).toFixed(3)}`
        : null,
    ],
    ["Retrieval strategy", detail.embedding?.strategy ?? null],
    ["Embedding model", detail.embedding?.model ?? null],
    [
      "Embedding host",
      detail.embedding?.host
        ? detail.embedding.baseUrl
          ? `${detail.embedding.host} (${detail.embedding.baseUrl})`
          : detail.embedding.host
        : null,
    ],
    [
      "Embedding dims",
      detail.embedding?.dimensions ? String(detail.embedding.dimensions) : null,
    ],
    [
      "Embedded chunks",
      detail.embedding?.embeddedChunks != null &&
      detail.embedding?.corpusChunks != null
        ? `${detail.embedding.embeddedChunks} / ${detail.embedding.corpusChunks}`
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
          approxTokens
        />
      )}
      {detail.sources.length > 0 && (
        <PromptSection
          label="Retrieved source segments"
          text={formatRagSources(detail.sources)}
          approxTokens
        />
      )}
      {detail.references.length > 0 && (
        <PromptSection
          label="Reference list after step"
          text={formatReferences(detail.references)}
          approxTokens
        />
      )}
      {detail.relatedTitlesPrompt && (
        <PromptSection
          label="Related titles in prompt"
          text={detail.relatedTitlesPrompt}
          approxTokens
        />
      )}
      {detail.promptRefs && (
        <PromptSection
          label="Reference context in prompt"
          text={detail.promptRefs}
          approxTokens
        />
      )}
      {detail.backlinks.length > 0 && (
        <PromptSection
          label="Backlinks"
          text={detail.backlinks
            .map((b) => `- ${b.title} (${b.slug})`)
            .join("\n")}
          approxTokens
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
  embedding?: EmbeddingTrace;
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
  const embedding = normalizeEmbedding(obj.embedding);
  if (
    sources.length === 0 &&
    ragTitles.length === 0 &&
    backlinks.length === 0 &&
    !embedding
  )
    return null;
  return { sources, ragTitles, backlinks, embedding };
}

function normalizeEmbedding(value: unknown): EmbeddingTrace | undefined {
  const obj = asRecord(value);
  if (!obj || typeof obj.strategy !== "string") return undefined;
  const num = (v: unknown) => (typeof v === "number" ? v : undefined);
  const str = (v: unknown) => (typeof v === "string" ? v : undefined);
  return {
    strategy: obj.strategy,
    model: str(obj.model),
    host: str(obj.host),
    baseUrl: str(obj.baseUrl),
    dimensions: num(obj.dimensions),
    corpusChunks: num(obj.corpusChunks),
    embeddedChunks: num(obj.embeddedChunks),
  };
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

function PromptTraceSections({
  text,
  promptTokens,
  systemTokens,
  userTokens,
}: {
  text: string;
  promptTokens?: number | null;
  systemTokens?: number | null;
  userTokens?: number | null;
}) {
  const split = splitPromptTrace(text);
  if (!split)
    return (
      <PromptSection label="Prompt" text={text} promptTokens={promptTokens} />
    );
  return (
    <>
      <PromptSection
        label="System prompt"
        text={split.system}
        promptTokens={systemTokens}
      />
      <PromptSection
        label="User prompt"
        text={split.user}
        promptTokens={userTokens ?? promptTokens}
      />
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
  return refs.size;
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

function LlmCallDetail({
  call,
  index,
  count,
}: {
  call: NodeSpan;
  index: number;
  count: number;
}) {
  const hasMetadata = Boolean(
    call.llm_role || call.llm_model || call.llm_config_key,
  );
  return (
    <Card
      size="sm"
      className="min-w-0 data-[size=sm]:[--card-spacing:--spacing(2)]"
      data-testid="llm-call-trace"
    >
      <CardHeader>
        <CardTitle>
          LLM call {index + 1}
          {count > 1 ? ` of ${count}` : ""}
        </CardTitle>
        <CardDescription>
          {traceTokenCount(call).toLocaleString()} tokens
        </CardDescription>
      </CardHeader>
      <CardContent className="flex min-w-0 flex-col gap-1">
        {hasMetadata && <LlmMetadata node={call} />}
        {call.prompt_text && (
          <PromptTraceSections
            text={call.prompt_text}
            promptTokens={call.prompt_tokens}
            systemTokens={call.system_prompt_tokens}
            userTokens={call.user_prompt_tokens}
          />
        )}
        {call.cot_text && (
          <PromptSection
            label="Chain of thought"
            text={call.cot_text}
            promptTokens={call.cot_tokens}
            variant="cot"
          />
        )}
        {call.response_text && (
          <PromptSection
            label="Output"
            text={call.response_text}
            promptTokens={call.response_tokens}
            variant="output"
          />
        )}
      </CardContent>
    </Card>
  );
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

/** Cheap client-side token estimate (~4 chars/token) for text the server
 *  didn't tokenise — the RAG context blocks. Shown with a leading ~ so it's
 *  never mistaken for the exact tiktoken counts on the prompt/output sections. */
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

const PromptSection = memo(function PromptSection({
  label,
  text,
  variant,
  promptTokens,
  approxTokens = false,
}: {
  label: string;
  text: string;
  variant?: "cot" | "output";
  promptTokens?: number | null;
  /** Show an estimated (~) token count instead of an exact one. */
  approxTokens?: boolean;
}) {
  const [mode, setMode] = useState<"source" | "rendered">("rendered");
  const [open, setOpen] = useState(false);
  const copy = () => {
    void navigator.clipboard?.writeText(text).catch(() => {});
  };
  const html = useMemo(
    () => (mode === "rendered" ? md.render(text) : ""),
    [mode, text],
  );
  const lineCount = text.split("\n").length;
  const hasExact = promptTokens !== undefined && promptTokens !== null;
  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <Card
        className="min-w-0 data-[size=sm]:[--card-spacing:--spacing(2)]"
        size="sm"
        data-testid="prompt-section"
      >
        <CardHeader>
          <CollapsibleTrigger className="group/section col-start-1 row-span-2 row-start-1 grid min-w-0 cursor-pointer grid-cols-[auto_1fr] items-center gap-x-1.5 border-0 bg-transparent p-0 text-left">
            <ChevronDown
              aria-hidden
              className={cn("transition-transform", !open && "-rotate-90")}
            />
            <span className="min-w-0">
              <CardTitle>{label}</CardTitle>
              <CardDescription>
                {text.length.toLocaleString()} chars ·{" "}
                {lineCount.toLocaleString()} lines
                {hasExact ? (
                  <>
                    {" · "}
                    {promptTokens.toLocaleString()}t
                  </>
                ) : approxTokens && text.length > 0 ? (
                  <>
                    {" · ~"}
                    {estimateTokens(text).toLocaleString()}t
                  </>
                ) : null}
              </CardDescription>
            </span>
          </CollapsibleTrigger>
          <CardAction>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={copy}
              title="Copy to clipboard"
            >
              Copy
            </Button>
          </CardAction>
        </CardHeader>
        <CollapsibleContent>
          <CardContent className="min-w-0 pt-1">
            <Tabs
              value={mode}
              onValueChange={(value) => setMode(value as "source" | "rendered")}
            >
              <TabsList variant="line">
                <TabsTrigger value="rendered">Rendered</TabsTrigger>
                <TabsTrigger value="source">Source</TabsTrigger>
              </TabsList>
              <TabsContent value="rendered">
                <div
                  data-testid="markdown-trace"
                  className={cn(
                    "prose-halu prose prose-sm max-h-64 max-w-none overflow-x-auto overflow-y-auto font-serif max-[600px]:text-xs",
                    variant === "cot" && "italic",
                  )}
                  dangerouslySetInnerHTML={{ __html: html }}
                />
              </TabsContent>
              <TabsContent value="source">
                <pre
                  data-testid="trace-source"
                  aria-label={`${label} source`}
                  className="max-h-64 max-w-full overflow-x-auto overflow-y-auto rounded-md border border-input px-2 py-1.5 font-mono text-xs whitespace-pre max-[600px]:text-[0.7rem]"
                >
                  {text}
                </pre>
              </TabsContent>
            </Tabs>
          </CardContent>
        </CollapsibleContent>
      </Card>
    </Collapsible>
  );
});
