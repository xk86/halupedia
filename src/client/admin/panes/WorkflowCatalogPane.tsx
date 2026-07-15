import { GitBranch } from "lucide-react";
import { Pane } from "../Pane";
import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";

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
        <span className="min-w-0 flex-1 text-xs break-words">
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

interface WorkflowCatalogPaneProps {
  workflows: PipelineWorkflowSummary[];
}

/** Static reference catalog of every registered workflow's node list — large
 *  and rarely needed day-to-day, so it's its own pane (collapsed by default)
 *  rather than always-expanded content inside PipelinesPane. */
export function WorkflowCatalogPane({ workflows }: WorkflowCatalogPaneProps) {
  return (
    <Pane
      id="workflow-catalog"
      title="Workflows"
      description="Every registered workflow's node sequence."
      count={`${workflows.length} workflows`}
      defaultCollapsed
      wide
    >
      <div className="grid grid-cols-1 gap-2 lg:grid-cols-2">
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
