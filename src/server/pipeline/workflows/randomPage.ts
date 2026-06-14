/**
 * random.page workflow — a single traced LLM call that picks a random article
 * to navigate to. Wrapped as a workflow so it is timed in the pipeline run
 * traces like every other model-backed operation.
 */

import type { WorkflowDefinition } from "../runtime/graph";
import type { PipelineDeps } from "../deps";
import { chooseRandomPageNode } from "../nodes/randomPage";

export const randomPageWorkflow: WorkflowDefinition<PipelineDeps> = {
  name: "random.page",
  description: "Pick a random (possibly unwritten) article title/slug to visit.",
  edges: [{ node: chooseRandomPageNode }],
};
