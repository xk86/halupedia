/**
 * Homepage refresh workflow.
 */

import type { WorkflowDefinition } from "../runtime/graph";
import type { PipelineDeps } from "../deps";
import { refreshHomepageCacheNode } from "../nodes/homepage";

export const homepageRefreshWorkflow: WorkflowDefinition<PipelineDeps> = {
  name: "homepage.refresh",
  description: "Refresh the DB-backed homepage cache and DYK side content.",
  edges: [{ node: refreshHomepageCacheNode }],
};
