import { Pane } from "../Pane";
import { toWikiSegment } from "../../wikiPath";

interface QueueItem {
  slug: string;
  title: string;
  seq: number;
  startedAt: number;
  waiting: number;
  workflow?: string;
  phase?: string;
}

interface Props {
  items: QueueItem[];
  onNavigate: (slug: string) => void;
}

const WORKFLOW_LABELS: Record<string, string> = {
  "article.generate": "Generating",
  "article.refresh": "Refreshing",
  "article.rewrite": "Rewriting",
  "article.post_process": "Post-processing",
};

const NODE_LABELS: Record<string, string> = {
  "read.reload_article": "Loading",
  "transform.load_body": "Loading body",
  "transform.rebuild_reference_list": "Rebuilding refs",
  "transform.resolve_links_post": "Resolving links",
  "llm.generate_see_also": "Generating see-also",
  "llm.regenerate_summary": "Writing summary",
  "llm.generate_infobox": "Generating infobox",
  "write.persist_infobox": "Saving infobox",
  "llm.generate_sidebar_caption": "Writing caption",
  "write.update_article_in_place": "Saving",
  "write.index_rag_chunks": "Indexing",
  "write.persist_article": "Saving",
  "validate.body_invariants": "Validating",
  "llm.call_article_model": "Writing article",
  "llm.call_refresh_model": "Rewriting",
  "read.load_article": "Loading",
  "read.retrieve_context": "Retrieving context",
};

function formatPhase(phase?: string): string {
  if (!phase || phase === "starting") return "";
  return NODE_LABELS[phase] ?? phase.replace(/^[^.]+\./, "").replace(/_/g, " ");
}

function formatWorkflow(workflow?: string): string {
  return workflow ? (WORKFLOW_LABELS[workflow] ?? workflow) : "Active";
}

export function GenerationQueuePane({ items, onNavigate }: Props) {
  return (
    <Pane id="generation-queue" title="Generation Queue" count={`${items.length} active`}>
      {items.length ? (
        <ul className="admin-queue-list">
          {items.map((item) => {
            const phase = formatPhase(item.phase);
            const workflowLabel = formatWorkflow(item.workflow);
            return (
              <li key={`${item.slug}-${item.seq}`} className="admin-queue-item">
                <a
                  href={`/wiki/${toWikiSegment(item.title)}`}
                  onClick={(e) => {
                    e.preventDefault();
                    onNavigate(toWikiSegment(item.title));
                  }}
                >
                  {item.title}
                </a>
                <span className="admin-queue-meta">
                  {workflowLabel}{phase ? ` · ${phase}` : ""}
                  {item.waiting > 0 && ` · ${item.waiting} waiting`}
                </span>
              </li>
            );
          })}
        </ul>
      ) : (
        <p className="sb-copy">No active article generations.</p>
      )}
    </Pane>
  );
}
