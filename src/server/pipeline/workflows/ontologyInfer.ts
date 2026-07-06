import type { WorkflowDefinition } from "../runtime/graph";
import type { PipelineDeps } from "../deps";
import {
  appendOntologySuggestionsNode,
  mergeOntologySuggestionsNode,
  ontologyInferLlmNode,
} from "../nodes/ontologyInfer";

export const ontologyInferWorkflow: WorkflowDefinition<PipelineDeps> = {
  name: "ontology.infer",
  description: "On-demand LLM extraction of ontology facts from an article.",
  edges: [{ node: ontologyInferLlmNode }],
};

export const ontologySuggestionsAppendWorkflow: WorkflowDefinition<PipelineDeps> =
  {
    name: "ontology.suggestions.append",
    description: "Append selected persisted ontology suggestions.",
    edges: [{ node: appendOntologySuggestionsNode }],
  };

export const ontologySuggestionsMergeWorkflow: WorkflowDefinition<PipelineDeps> =
  {
    name: "ontology.suggestions.merge",
    description:
      "Merge selected persisted suggestions and prune covered infobox facts.",
    edges: [{ node: mergeOntologySuggestionsNode }],
  };
