/**
 * Workflow registry — the single place where every workflow declares its
 * existence to the runtime. The admin viz/trace endpoints iterate this
 * registry, never an ad-hoc list. Adding a workflow means importing its
 * definition here and adding it to `ALL_WORKFLOWS`.
 */

import type { WorkflowDefinition } from "./runtime/graph";
import type { PipelineDeps } from "./deps";
import { generateArticleWorkflow } from "./workflows/generateArticle";
import { postProcessWorkflow } from "./workflows/postProcess";
import { refreshArticleWorkflow } from "./workflows/refreshArticle";
import { rewriteArticleWorkflow } from "./workflows/rewriteArticle";

export const ALL_WORKFLOWS: WorkflowDefinition<PipelineDeps>[] = [
  generateArticleWorkflow,
  refreshArticleWorkflow,
  rewriteArticleWorkflow,
  postProcessWorkflow,
];

export function findWorkflow(
  name: string,
): WorkflowDefinition<PipelineDeps> | undefined {
  return ALL_WORKFLOWS.find((w) => w.name === name);
}
