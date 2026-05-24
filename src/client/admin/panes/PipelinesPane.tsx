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

interface Props {
  workflows: PipelineWorkflowSummary[];
  runs: PipelineRunSummary[];
  traceEnabled: boolean;
  error: string | null;
  onRefresh: () => void;
}

export function PipelinesPane({ workflows, runs, traceEnabled, error, onRefresh }: Props) {
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
      <div className="admin-pipeline-grid">
        {workflows.map((workflow) => (
          <div key={workflow.name} className="admin-pipeline-workflow">
            <div className="admin-pipeline-name">{workflow.name}</div>
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
          </div>
        ))}
      </div>
      <div className="admin-section-title-row admin-pipeline-runs-heading">
        <h4 className="sb-heading">Recent Runs</h4>
        <span className="all-entries-count">
          {traceEnabled ? `${runs.length} recorded` : "trace off"}
        </span>
      </div>
      {runs.length ? (
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
              {runs.map((run) => (
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
          {traceEnabled ? "No recorded pipeline runs." : "Pipeline trace storage is disabled."}
        </p>
      )}
    </Pane>
  );
}
