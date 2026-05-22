/**
 * Runtime-driven graph introspection.
 *
 * The viz endpoint (`/api/admin/pipeline/graph`) consumes the output of
 * `describeWorkflow` directly — there is no hand-maintained diagram. If a
 * node disappears from a workflow's `edges`, it disappears from the viz.
 *
 * Two formats are emitted:
 *
 *   - `describeWorkflow(workflow)` → JSON suitable for client-side D3/Cytoscape.
 *   - `describeWorkflowAsDot(workflow)` → Graphviz DOT for CLI/debug rendering.
 *
 * Both formats are pure functions of the `WorkflowDefinition`; calling them
 * cannot accidentally execute a node.
 */

import type { CompiledNode } from "./nodeFactory";
import type { WorkflowDefinition } from "./graph";

export interface DescribedNode {
  name: string;
  kind: string;
  description?: string;
  reads: readonly string[];
  writes: readonly string[];
  /** Position in the linear edge list; useful for ordering in the UI. */
  index: number;
  /** True if this node has a `when` predicate (may be skipped at runtime). */
  conditional: boolean;
}

export interface DescribedEdge {
  from: string;
  to: string;
  /** "data" edges are inferred from reads/writes; "control" edges from order. */
  kind: "control" | "data";
  /** The state field that links producer → consumer (only for data edges). */
  field?: string;
}

export interface DescribedWorkflow {
  name: string;
  description?: string;
  nodes: DescribedNode[];
  edges: DescribedEdge[];
}

export function describeWorkflow<Deps>(
  workflow: WorkflowDefinition<Deps>,
): DescribedWorkflow {
  const nodes: DescribedNode[] = workflow.edges.map((edge, index) => ({
    name: edge.node.name,
    kind: edge.node.kind,
    description: edge.node.description,
    reads: edge.node.reads,
    writes: edge.node.writes,
    index,
    conditional: Boolean(edge.when),
  }));

  const controlEdges: DescribedEdge[] = [];
  for (let i = 0; i < nodes.length - 1; i += 1) {
    controlEdges.push({
      from: nodes[i].name,
      to: nodes[i + 1].name,
      kind: "control",
    });
  }

  // Data edges: for each `writes` field of a node, point at the next node
  // (in order) that lists the same field in its `reads`. Multiple consumers
  // are allowed — emit one edge per consumer until the field is overwritten.
  const dataEdges: DescribedEdge[] = [];
  for (let i = 0; i < workflow.edges.length; i += 1) {
    const producer = workflow.edges[i].node;
    for (const field of producer.writes) {
      for (let j = i + 1; j < workflow.edges.length; j += 1) {
        const consumer = workflow.edges[j].node;
        if (consumer.writes.includes(field)) break; // overwritten; downstream sees the new value
        if (consumer.reads.includes(field)) {
          dataEdges.push({
            from: producer.name,
            to: consumer.name,
            kind: "data",
            field,
          });
        }
      }
    }
  }

  return {
    name: workflow.name,
    description: workflow.description,
    nodes,
    edges: [...controlEdges, ...dataEdges],
  };
}

export function describeWorkflowAsDot<Deps>(
  workflow: WorkflowDefinition<Deps>,
): string {
  const described = describeWorkflow(workflow);
  const lines: string[] = [
    `digraph "${escapeDot(workflow.name)}" {`,
    `  rankdir=LR;`,
    `  node [shape=box, style=rounded, fontname="Helvetica"];`,
  ];
  for (const node of described.nodes) {
    const color = NODE_COLORS[node.kind] ?? "black";
    const label =
      `${node.name}\\n` +
      `[${node.kind}]` +
      (node.reads.length ? `\\nreads: ${node.reads.join(",")}` : "") +
      (node.writes.length ? `\\nwrites: ${node.writes.join(",")}` : "");
    lines.push(`  "${node.name}" [color=${color}, label="${label}"];`);
  }
  for (const edge of described.edges) {
    const style = edge.kind === "data" ? "dashed" : "solid";
    const label = edge.field ? ` [label="${edge.field}"]` : "";
    lines.push(
      `  "${edge.from}" -> "${edge.to}" [style=${style}]${label};`,
    );
  }
  lines.push("}");
  return lines.join("\n");
}

const NODE_COLORS: Record<string, string> = {
  read: "deepskyblue3",
  llm: "darkorange",
  transform: "forestgreen",
  validate: "purple3",
  write: "firebrick",
};

function escapeDot(s: string): string {
  return s.replace(/"/g, '\\"');
}

/** Compact summary line used in startup logs / smoke tests. */
export function workflowSummary<Deps>(
  workflow: WorkflowDefinition<Deps>,
): string {
  const counts: Record<string, number> = {};
  for (const edge of workflow.edges) {
    counts[edge.node.kind] = (counts[edge.node.kind] ?? 0) + 1;
  }
  const parts = Object.entries(counts).map(([k, v]) => `${k}=${v}`);
  return `${workflow.name} (${workflow.edges.length} nodes, ${parts.join(",")})`;
}

/** Surface declared node references so admin pages can list them. */
export function listNodes<Deps>(
  workflow: WorkflowDefinition<Deps>,
): CompiledNode<Deps>[] {
  return workflow.edges.map((edge) => edge.node);
}
