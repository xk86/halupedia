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
  /** Name of the `when` predicate function, e.g. "skipIfProtected". */
  whenLabel?: string;
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

/** Expand an edge into all its nodes (primary + any parallel siblings). */
function edgeNodes<Deps>(edge: { node: CompiledNode<Deps>; when?: unknown; parallel?: CompiledNode<Deps>[] }): CompiledNode<Deps>[] {
  return edge.parallel ? [edge.node, ...edge.parallel] : [edge.node];
}

export function describeWorkflow<Deps>(
  workflow: WorkflowDefinition<Deps>,
): DescribedWorkflow {
  // Flatten edges into a linear node list; parallel siblings get the same
  // `index` as their primary node so the UI can group them visually.
  const nodes: DescribedNode[] = [];
  for (let i = 0; i < workflow.edges.length; i += 1) {
    const edge = workflow.edges[i];
    for (const node of edgeNodes(edge)) {
      nodes.push({
        name: node.name,
        kind: node.kind,
        description: node.description,
        reads: node.reads,
        writes: node.writes,
        index: i,
        conditional: Boolean(edge.when),
        whenLabel: edge.when?.name || undefined,
      });
    }
  }

  // Control edges: connect the last node of each edge-group to the first node
  // of the next group. Parallel siblings within a group get no control edge
  // between them (they are independent).
  const controlEdges: DescribedEdge[] = [];
  for (let i = 0; i < workflow.edges.length - 1; i += 1) {
    const fromGroup = edgeNodes(workflow.edges[i]);
    const toGroup = edgeNodes(workflow.edges[i + 1]);
    for (const from of fromGroup) {
      for (const to of toGroup) {
        controlEdges.push({ from: from.name, to: to.name, kind: "control" });
      }
    }
  }

  // Data edges: for each `writes` field of a node, point at the next node
  // (in order) that lists the same field in its `reads`. Multiple consumers
  // are allowed — emit one edge per consumer until the field is overwritten.
  const flatNodes = nodes; // already linearised above
  const dataEdges: DescribedEdge[] = [];
  for (let i = 0; i < flatNodes.length; i += 1) {
    const producer = flatNodes[i];
    for (const field of producer.writes) {
      for (let j = i + 1; j < flatNodes.length; j += 1) {
        const consumer = flatNodes[j];
        if (consumer.writes.includes(field as string)) break;
        if (consumer.reads.includes(field as string)) {
          dataEdges.push({ from: producer.name, to: consumer.name, kind: "data", field: field as string });
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
    for (const node of edgeNodes(edge)) {
      counts[node.kind] = (counts[node.kind] ?? 0) + 1;
    }
  }
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  const parts = Object.entries(counts).map(([k, v]) => `${k}=${v}`);
  return `${workflow.name} (${total} nodes, ${parts.join(",")})`;
}

/** Surface declared node references so admin pages can list them. */
export function listNodes<Deps>(
  workflow: WorkflowDefinition<Deps>,
): CompiledNode<Deps>[] {
  return workflow.edges.flatMap((edge) => edgeNodes(edge));
}
