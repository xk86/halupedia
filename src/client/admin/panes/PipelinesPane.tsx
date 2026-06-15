import { Fragment, useEffect, useState, type MouseEvent } from "react";
import MarkdownIt from "markdown-it";
import { Pane } from "../Pane";
import { toWikiSegment } from "../../wikiPath";

const RUNS_PER_PAGE = 10;

const md = new MarkdownIt({ html: false, linkify: false });

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
}

interface Props {
  workflows: PipelineWorkflowSummary[];
  runs: PipelineRunSummary[];
  activeRuns?: ActiveRun[];
  traceEnabled: boolean;
  error: string | null;
  onRefresh: () => void;
  onNavigate?: (segment: string) => void;
}

export function PipelinesPane({ workflows, runs, activeRuns = [], traceEnabled, error, onRefresh, onNavigate }: Props) {
  // Workflow diagrams are collapsed by default — the run history is the focus.
  // Track which are *expanded* so newly-loaded workflows start collapsed.
  const [expandedWorkflows, setExpandedWorkflows] = useState<Set<string>>(new Set());
  const [expandedRun, setExpandedRun] = useState<string | null>(null);
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
  const activeRows = activeRuns.map((a) => ({ kind: "active" as const, item: a }));
  const runRows = runs.map((r) => ({ kind: "run" as const, item: r }));
  const allRows = [...activeRows, ...runRows];
  const pageRows = allRows.slice(page * RUNS_PER_PAGE, page * RUNS_PER_PAGE + RUNS_PER_PAGE);

  function navigateTo(e: MouseEvent, segment: string) {
    e.preventDefault();
    e.stopPropagation();
    onNavigate?.(segment);
  }

  const allExpanded =
    workflows.length > 0 && workflows.every((w) => expandedWorkflows.has(w.name));

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
      const res = await fetch(`/api/admin/pipeline/runs/${encodeURIComponent(runId)}`);
      if (res.ok) {
        const data = await res.json() as { nodes: NodeSpan[] };
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
      wide
      actions={
        <button className="admin-btn" type="button" onClick={onRefresh}>
          Refresh
        </button>
      }
    >
      {error ? <p className="search-error">{error}</p> : null}

      {/* Run history is the primary view; the workflow diagrams below are
          collapsed reference material. In-progress articles lead the list. */}
      <div className="admin-section-title-row admin-pipeline-runs-heading">
        <h4 className="sb-heading">Recent Runs</h4>
        <span className="all-entries-count">
          {activeRuns.length > 0 && `${activeRuns.length} active · `}
          {traceEnabled ? `${runs.length} recorded` : "trace off"}
        </span>
      </div>
      {totalRows ? (
        <>
          <div className="admin-model-table-wrap admin-pipeline-runs-wrap">
            <table className="admin-model-table admin-pipeline-runs-table">
              <thead>
                <tr>
                  <th>Started</th>
                  <th>Workflow</th>
                  <th>Slug</th>
                  <th>Status</th>
                  <th>Nodes</th>
                  <th>Duration</th>
                </tr>
              </thead>
              <tbody>
                {pageRows.map((row) => {
                  if (row.kind === "active") {
                    const a = row.item;
                    return (
                      <tr key={`active:${a.slug}`} className="admin-pipeline-run-row admin-pipeline-run-row--active">
                        <td className="admin-pipeline-run-time" title={fmtFullTimestamp(a.startedAt)}>
                          {fmtTimestamp(a.startedAt)}
                        </td>
                        <td>{a.workflow ?? "—"}</td>
                        <td><SlugCell slug={a.slug} segment={toWikiSegment(a.title || a.slug)} onNavigate={navigateTo} /></td>
                        <td className="admin-pipeline-run-inprogress">in progress</td>
                        <td>{a.phase && a.phase !== "starting" ? a.phase.replace(/^[^.]+\./, "") : "…"}</td>
                        <td>—</td>
                      </tr>
                    );
                  }
                  const run = row.item;
                  return (
                    <Fragment key={run.run_id}>
                      <tr
                        className={`admin-pipeline-run-row${expandedRun === run.run_id ? " admin-pipeline-run-row--expanded" : ""}`}
                        onClick={() => void toggleRun(run.run_id)}
                        title={run.error_message ?? "Click to see node breakdown"}
                      >
                        <td className="admin-pipeline-run-time" title={fmtFullTimestamp(run.started_at)}>
                          {fmtTimestamp(run.started_at)}
                        </td>
                        <td>{run.workflow}</td>
                        <td>
                          {run.slug
                            ? <SlugCell slug={run.slug} segment={toWikiSegment(run.slug)} onNavigate={navigateTo} />
                            : ""}
                        </td>
                        <td className={run.status === "error" ? "admin-pipeline-run-error" : ""}>{run.status}</td>
                        <td>{run.nodes_executed}</td>
                        <td>{run.duration_ms} ms</td>
                      </tr>
                      {expandedRun === run.run_id && (
                        <tr className="admin-pipeline-run-detail-row">
                          <td colSpan={6}>
                            {loadingRun === run.run_id ? (
                              <span className="admin-pipeline-run-loading">Loading…</span>
                            ) : runNodes[run.run_id] ? (
                              <NodeBreakdown
                                nodes={runNodes[run.run_id]}
                                totalMs={run.duration_ms}
                                runStartedAt={run.started_at}
                              />
                            ) : null}
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
          {pageCount > 1 && (
            <div className="admin-pipeline-runs-pager">
              <button
                type="button"
                className="admin-btn admin-btn--small"
                onClick={() => setPage((p) => Math.max(0, p - 1))}
                disabled={page === 0}
              >
                ← Prev
              </button>
              <span className="all-entries-count">Page {page + 1} of {pageCount}</span>
              <button
                type="button"
                className="admin-btn admin-btn--small"
                onClick={() => setPage((p) => Math.min(pageCount - 1, p + 1))}
                disabled={page >= pageCount - 1}
              >
                Next →
              </button>
            </div>
          )}
        </>
      ) : (
        <p className="sb-copy">
          {traceEnabled ? "No recorded pipeline runs." : "Pipeline trace storage is disabled."}
        </p>
      )}

      <div className="admin-section-title-row" style={{ marginTop: "1.5rem", marginBottom: "0.5rem" }}>
        <h4 className="sb-heading">Workflows</h4>
        <button
          type="button"
          className="admin-btn admin-btn--small"
          onClick={toggleAllWorkflows}
        >
          {allExpanded ? "Collapse all" : "Expand all"}
        </button>
      </div>

      <div className="admin-pipeline-grid">
        {workflows.map((workflow) => {
          const collapsed = !expandedWorkflows.has(workflow.name);
          return (
            <div key={workflow.name} className="admin-pipeline-workflow">
              <button
                type="button"
                className="admin-pipeline-name admin-pipeline-name--toggle"
                onClick={() => toggleWorkflow(workflow.name)}
                aria-expanded={!collapsed}
              >
                <span>{workflow.name}</span>
                <span className="admin-pipeline-toggle-icon">{collapsed ? "▸" : "▾"}</span>
              </button>
              {!collapsed && (
                <>
                  <div className="admin-pipeline-summary">{workflow.summary}</div>
                  <div className="admin-pipeline-flow">
                    {segmentNodes(workflow.nodes).map((seg, si, all) => {
                      const isLast = si === all.length - 1;
                      if (seg.type === "linear") {
                        return (
                          <span key={si} className={`admin-pipeline-segment${isLast ? "" : " admin-pipeline-segment--arrow"}`}>
                            {seg.nodes.map((node, ni) => (
                              <span
                                key={node.name}
                                className={`admin-pipeline-node admin-pipeline-node--${node.kind}${ni < seg.nodes.length - 1 ? " admin-pipeline-node--arrow" : ""}`}
                                title={node.description ?? node.name}
                              >
                                {node.name}
                              </span>
                            ))}
                          </span>
                        );
                      }
                      const branchEntries = [...seg.branches.entries()];
                      return (
                        <span key={si} className={`admin-pipeline-branch${isLast ? "" : " admin-pipeline-segment--arrow"}`}>
                          {branchEntries.map(([label, nodes]) => (
                            <span key={label} className="admin-pipeline-branch-row">
                              <span className="admin-pipeline-branch-label" title={label}>{label}</span>
                              {nodes.map((node, ni) => (
                                <span
                                  key={node.name}
                                  className={`admin-pipeline-node admin-pipeline-node--${node.kind}${ni < nodes.length - 1 ? " admin-pipeline-node--arrow" : ""}`}
                                  title={node.description ?? node.name}
                                >
                                  {node.name}
                                </span>
                              ))}
                            </span>
                          ))}
                        </span>
                      );
                    })}
                  </div>
                </>
              )}
            </div>
          );
        })}
      </div>
    </Pane>
  );
}

function fmtK(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}

// Renders a run's slug as a wiki link. `segment` is the /wiki/ path segment
// (slugs resolve via the server's legacy-slug handling); clicking navigates
// without toggling the row's expansion.
function SlugCell({
  slug,
  segment,
  onNavigate,
}: {
  slug: string;
  segment: string;
  onNavigate: (e: MouseEvent, segment: string) => void;
}) {
  return (
    <a
      className="admin-pipeline-run-slug"
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

function NodeBreakdown({ nodes, totalMs, runStartedAt }: { nodes: NodeSpan[]; totalMs: number; runStartedAt?: number }) {
  const maxMs = Math.max(...nodes.map((n) => n.duration_ms), 1);
  const [openNode, setOpenNode] = useState<number | null>(null);
  return (
    <div className="admin-pipeline-node-breakdown">
      {nodes.map((node, i) => {
        const pct = Math.round((node.duration_ms / Math.max(totalMs, 1)) * 100);
        const barPct = Math.round((node.duration_ms / maxMs) * 100);
        const hasMetadata = Boolean(node.llm_role || node.llm_model || node.llm_config_key);
        const hasPrompt = Boolean(node.prompt_text || node.cot_text || node.response_text || hasMetadata);
        const isOpen = openNode === i;
        return (
          <Fragment key={i}>
            <div className={`admin-pipeline-node-row admin-pipeline-node-row--${node.node_kind ?? "unknown"}`}>
              <span className="admin-pipeline-node-name" title={node.error_message ?? node.node_name}>
                {node.node_name}
                {node.status === "error" && <span className="admin-pipeline-node-err"> ✕</span>}
              </span>
              {node.started_at ? (
                <span
                  className="admin-pipeline-node-time"
                  title={
                    runStartedAt
                      ? `${fmtFullTimestamp(node.started_at)} (+${node.started_at - runStartedAt} ms)`
                      : fmtFullTimestamp(node.started_at)
                  }
                >
                  {fmtTimestamp(node.started_at)}
                </span>
              ) : null}
              <span className="admin-pipeline-node-bar-wrap">
                <span
                  className="admin-pipeline-node-bar"
                  style={{ width: `${barPct}%` }}
                />
              </span>
              <span className="admin-pipeline-node-ms">{node.duration_ms} ms</span>
              <span className="admin-pipeline-node-pct">{pct}%</span>
              {node.prompt_chars != null ? (
                hasPrompt ? (
                  <button
                    type="button"
                    className={`admin-pipeline-node-ctx admin-pipeline-node-ctx--btn${isOpen ? " admin-pipeline-node-ctx--open" : ""}`}
                    title="Show prompt, chain-of-thought, and output"
                    onClick={() => setOpenNode(isOpen ? null : i)}
                  >
                    {fmtK(node.prompt_chars)}c {isOpen ? "▾" : "▸"}
                  </button>
                ) : (
                  <span className="admin-pipeline-node-ctx" title="prompt chars (system + user)">
                    {fmtK(node.prompt_chars)}c
                  </span>
                )
              ) : (
                <span className="admin-pipeline-node-ctx" />
              )}
            </div>
            {isOpen && hasPrompt && (
              <div className="admin-prompt-detail">
                {hasMetadata && <LlmMetadata node={node} />}
                {node.prompt_text && (
                  <PromptSection label="Prompt" text={node.prompt_text} />
                )}
                {node.cot_text && (
                  <PromptSection label="Chain of thought" text={node.cot_text} variant="cot" />
                )}
                {node.response_text && (
                  <PromptSection label="Output" text={node.response_text} variant="output" />
                )}
              </div>
            )}
          </Fragment>
        );
      })}
    </div>
  );
}

function boolText(value: number | boolean | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  return value === true || value === 1 ? "on" : "off";
}

function LlmMetadata({ node }: { node: NodeSpan }) {
  const role =
    node.llm_resolved_role && node.llm_role && node.llm_resolved_role !== node.llm_role
      ? `${node.llm_role} -> ${node.llm_resolved_role}`
      : node.llm_role;
  const rows = [
    ["Config", node.llm_config_key],
    ["Role", role],
    ["Model", node.llm_model],
    ["Host", node.llm_host],
    ["Base URL", node.llm_base_url],
    ["Temperature", node.llm_temperature == null ? null : String(node.llm_temperature)],
    ["Max tokens", node.llm_max_tokens == null ? null : String(node.llm_max_tokens)],
    ["TTFT", node.llm_ttft_ms == null ? null : `${node.llm_ttft_ms} ms`],
    ["Thinking", boolText(node.llm_thinking)],
    ["JSON mode", boolText(node.llm_json_mode)],
    ["Images", node.llm_image_count == null ? null : String(node.llm_image_count)],
  ].filter((row): row is [string, string] => Boolean(row[1]));

  if (rows.length === 0) return null;
  return (
    <dl className="admin-prompt-meta-grid">
      {rows.map(([label, value]) => (
        <Fragment key={label}>
          <dt>{label}</dt>
          <dd>{value}</dd>
        </Fragment>
      ))}
    </dl>
  );
}

function PromptSection({ label, text, variant }: { label: string; text: string; variant?: "cot" | "output" }) {
  const copy = () => { void navigator.clipboard?.writeText(text).catch(() => {}); };
  const html = md.render(text);
  return (
    <section className={`admin-prompt-section${variant ? ` admin-prompt-section--${variant}` : ""}`}>
      <header className="admin-prompt-section-head">
        <span className="admin-prompt-section-label">{label}</span>
        <span className="admin-prompt-section-meta">{text.length.toLocaleString()} chars</span>
        <button type="button" className="admin-prompt-section-copy" onClick={copy} title="Copy to clipboard">Copy</button>
      </header>
      <div
        className="admin-prompt-section-body"
        dangerouslySetInnerHTML={{ __html: html }}
      />
    </section>
  );
}
