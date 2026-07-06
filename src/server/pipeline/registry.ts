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
import {
  addLinkArticleWorkflow,
  rawSaveArticleWorkflow,
} from "./workflows/deterministicArticleSave";
import { homepageRefreshWorkflow } from "./workflows/homepageRefresh";
import { captionImageWorkflow } from "./workflows/captionImage";
import { articleImageGenerationWorkflow } from "./workflows/articleImageGeneration";
import { regenerateSummaryWorkflow } from "./workflows/utilities";
import { randomPageWorkflow } from "./workflows/randomPage";
import {
  ontologyInferWorkflow,
  ontologySuggestionsAppendWorkflow,
  ontologySuggestionsMergeWorkflow,
} from "./workflows/ontologyInfer";

export const ALL_WORKFLOWS: WorkflowDefinition<PipelineDeps>[] = [
  generateArticleWorkflow,
  refreshArticleWorkflow,
  rewriteArticleWorkflow,
  rawSaveArticleWorkflow,
  addLinkArticleWorkflow,
  homepageRefreshWorkflow,
  postProcessWorkflow,
  articleImageGenerationWorkflow,
  captionImageWorkflow,
  regenerateSummaryWorkflow,
  randomPageWorkflow,
  ontologyInferWorkflow,
  ontologySuggestionsAppendWorkflow,
  ontologySuggestionsMergeWorkflow,
];

export function findWorkflow(
  name: string,
): WorkflowDefinition<PipelineDeps> | undefined {
  return ALL_WORKFLOWS.find((w) => w.name === name);
}
