import { Pane } from "../Pane";

interface WorkflowNode {
  name: string;
  kind: string;
  description?: string;
  conditional: boolean;
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
            <div className="admin-pipeline-kinds">
              {workflow.nodes.map((node, i) => (
                <span
                  key={`${workflow.name}-${node.name}`}
                  className={`admin-pipeline-node admin-pipeline-node--${node.kind}${node.conditional ? " admin-pipeline-node--conditional" : ""}${i < workflow.nodes.length - 1 ? " admin-pipeline-node--arrow" : ""}`}
                  title={node.description ?? node.name}
                >
                  {node.name}{node.conditional ? "?" : ""}
                </span>
              ))}
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
