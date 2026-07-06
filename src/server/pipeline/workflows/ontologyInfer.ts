import type { WorkflowDefinition } from "../runtime/graph";
import type { PipelineDeps } from "../deps";
import { ontologyInferLlmNode } from "../nodes/ontologyInfer";

export const ontologyInferWorkflow: WorkflowDefinition<PipelineDeps> = {
  name: "ontology.infer",
  description: "On-demand LLM extraction of ontology facts from an article.",
  edges: [{ node: ontologyInferLlmNode }],
};
