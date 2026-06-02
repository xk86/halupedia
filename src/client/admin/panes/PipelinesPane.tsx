import { useState } from "react";
import { Pane } from "../Pane";

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
  duration_ms: number;
  status: string;
  error_message?: string | null;
  prompt_chars?: number | null;
}

interface Props {
  workflows: PipelineWorkflowSummary[];
  runs: PipelineRunSummary[];
  traceEnabled: boolean;
  error: string | null;
  onRefresh: () => void;
}

export function PipelinesPane({ workflows, runs, traceEnabled, error, onRefresh }: Props) {
  const [collapsedWorkflows, setCollapsedWorkflows] = useState<Set<string>>(new Set());
  const [workflowsCollapsed, setWorkflowsCollapsed] = useState(false);
  const [expandedRun, setExpandedRun] = useState<string | null>(null);
  const [runNodes, setRunNodes] = useState<Record<string, NodeSpan[]>>({});
  const [loadingRun, setLoadingRun] = useState<string | null>(null);

  function toggleWorkflow(name: string) {
    setCollapsedWorkflows((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  }

  function toggleAllWorkflows() {
    if (workflowsCollapsed) {
      setCollapsedWorkflows(new Set());
      setWorkflowsCollapsed(false);
    } else {
      setCollapsedWorkflows(new Set(workflows.map((w) => w.name)));
      setWorkflowsCollapsed(true);
    }
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

      <div className="admin-section-title-row" style={{ marginBottom: "0.5rem" }}>
        <h4 className="sb-heading">Workflows</h4>
        <button
          type="button"
          className="admin-btn admin-btn--small"
          onClick={toggleAllWorkflows}
        >
          {workflowsCollapsed ? "Expand all" : "Collapse all"}
        </button>
      </div>

      <div className="admin-pipeline-grid">
        {workflows.map((workflow) => {
          const collapsed = collapsedWorkflows.has(workflow.name);
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

      <div className="admin-section-title-row admin-pipeline-runs-heading">
        <h4 className="sb-heading">Recent Runs</h4>
        <span className="all-entries-count">
          {traceEnabled ? `${runs.length} recorded` : "trace off"}
        </span>
      </div>
      {runs.length ? (
        <div className="admin-model-table-wrap">
          <table className="admin-model-table admin-pipeline-runs-table">
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
              {runs.map((run) => (
                <>
                  <tr
                    key={run.run_id}
                    className={`admin-pipeline-run-row${expandedRun === run.run_id ? " admin-pipeline-run-row--expanded" : ""}`}
                    onClick={() => void toggleRun(run.run_id)}
                    title={run.error_message ?? "Click to see node breakdown"}
                  >
                    <td>{run.workflow}</td>
                    <td>{run.slug ?? ""}</td>
                    <td className={run.status === "error" ? "admin-pipeline-run-error" : ""}>{run.status}</td>
                    <td>{run.nodes_executed}</td>
                    <td>{run.duration_ms} ms</td>
                  </tr>
                  {expandedRun === run.run_id && (
                    <tr key={`${run.run_id}-detail`} className="admin-pipeline-run-detail-row">
                      <td colSpan={5}>
                        {loadingRun === run.run_id ? (
                          <span className="admin-pipeline-run-loading">Loading…</span>
                        ) : runNodes[run.run_id] ? (
                          <NodeBreakdown nodes={runNodes[run.run_id]} totalMs={run.duration_ms} />
                        ) : null}
                      </td>
                    </tr>
                  )}
                </>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="sb-copy">
          {traceEnabled ? "No recorded pipeline runs." : "Pipeline trace storage is disabled."}
        </p>
      )}
    </Pane>
  );
}

function fmtK(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}

function NodeBreakdown({ nodes, totalMs }: { nodes: NodeSpan[]; totalMs: number }) {
  const maxMs = Math.max(...nodes.map((n) => n.duration_ms), 1);
  return (
    <div className="admin-pipeline-node-breakdown">
      {nodes.map((node, i) => {
        const pct = Math.round((node.duration_ms / Math.max(totalMs, 1)) * 100);
        const barPct = Math.round((node.duration_ms / maxMs) * 100);
        return (
          <div key={i} className={`admin-pipeline-node-row admin-pipeline-node-row--${node.node_kind ?? "unknown"}`}>
            <span className="admin-pipeline-node-name" title={node.error_message ?? node.node_name}>
              {node.node_name}
              {node.status === "error" && <span className="admin-pipeline-node-err"> ✕</span>}
            </span>
            <span className="admin-pipeline-node-bar-wrap">
              <span
                className="admin-pipeline-node-bar"
                style={{ width: `${barPct}%` }}
              />
            </span>
            <span className="admin-pipeline-node-ms">{node.duration_ms} ms</span>
            <span className="admin-pipeline-node-pct">{pct}%</span>
            <span className="admin-pipeline-node-ctx" title="prompt chars (system + user)">
              {node.prompt_chars != null ? `${fmtK(node.prompt_chars)}c` : ""}
            </span>
          </div>
        );
      })}
    </div>
  );
}
