import type { StructuredToolInterface } from "@langchain/core/tools";
import type { AgentToolContext } from "./context";
import { createSearchArticlesTool } from "./searchArticles";
import { createReadArticleTool } from "./readArticle";
import { createGetOntologyFactsTool } from "./ontologyFacts";
import { createFindArticlesByTitleTool } from "./findArticlesByTitle";

export type { AgentToolContext } from "./context";

/** The research subagent's full retrieval/ranking tool set. Read-only. */
export function createResearchTools(
  ctx: AgentToolContext,
): StructuredToolInterface[] {
  return [
    createSearchArticlesTool(ctx),
    createReadArticleTool(ctx),
    createGetOntologyFactsTool(ctx),
    createFindArticlesByTitleTool(ctx),
  ];
}
