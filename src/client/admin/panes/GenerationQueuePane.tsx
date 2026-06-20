import { useEffect, useState } from "react";
import clsx from "clsx";
import { Pane } from "../Pane";
import { Badge } from "@/components/ui/badge";
import { toWikiSegment } from "../../wikiPath";
import { LiveLlmViews, type LiveLlmView } from "../LiveLlmViews";

interface QueueItem {
  slug: string;
  title: string;
  seq: number;
  queuedAt: number;
  startedAt?: number;
  queuedMs?: number;
  activeMs?: number;
  waiting: number;
  workflow?: string;
  phase?: string;
  state?: "queued" | "processing" | "llm";
  /** Live chain-of-thought streamed from the model (admin-only). */
  reasoning?: string;
  views?: LiveLlmView[];
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

function formatDuration(ms?: number): string {
  const value = Math.max(0, Math.floor(ms ?? 0));
  if (value < 1000) return `${value} ms`;
  const sec = Math.floor(value / 1000);
  const min = Math.floor(sec / 60);
  const rem = sec % 60;
  return min > 0 ? `${min}m ${rem}s` : `${sec}s`;
}

function queueState(item: QueueItem): "queued" | "processing" | "llm" {
  if (item.state === "queued") return "queued";
  if (item.state === "llm" || item.phase?.startsWith("llm.")) return "llm";
  return "processing";
}

function stateLabel(state: "queued" | "processing" | "llm"): string {
  if (state === "queued") return "Queued";
  if (state === "llm") return "Ollama";
  return "Processing";
}

const STATE_CLASSES: Record<"queued" | "processing" | "llm", string> = {
  queued: "border-l-[3px] border-l-[#a87d2a] bg-[rgba(168,125,42,0.07)]",
  processing: "border-l-[3px] border-l-[#4d7f93] bg-[rgba(77,127,147,0.07)]",
  llm: "border-l-[3px] border-l-[var(--accent)] bg-accent-wash",
};

const STATE_BADGE: Record<
  "queued" | "processing" | "llm",
  "secondary" | "outline" | "default"
> = {
  queued: "outline",
  processing: "secondary",
  llm: "default",
};

/**
 * Live wall-clock tick, local to this pane. Elapsed timers are derived from the
 * stable startedAt/queuedAt timestamps so the parent's queue payload no longer
 * needs to carry (and re-render the whole admin on) a ticking activeMs.
 */
function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [active]);
  return now;
}

export function GenerationQueuePane({ items, onNavigate }: Props) {
  const queued = items.filter((item) => queueState(item) === "queued").length;
  const active = items.length - queued;
  const now = useNow(items.length > 0);
  return (
    <Pane
      id="generation-queue"
      title="Generation Queue"
      description="Queued and active article generation work."
      count={`${active} active · ${queued} queued`}
    >
      {items.length ? (
        <ul className="m-0 flex list-none flex-col gap-2 p-0">
          {items.map((item) => {
            const phase = formatPhase(item.phase);
            const workflowLabel = formatWorkflow(item.workflow);
            const state = queueState(item);
            const timer =
              state === "queued"
                ? `${formatDuration(now - item.queuedAt)} queued`
                : item.startedAt
                  ? `${formatDuration(now - item.startedAt)} active`
                  : `${formatDuration(item.activeMs)} active`;
            return (
              <li
                key={`${item.slug}-${item.seq}`}
                className={clsx(
                  "flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1.5 rounded-md px-3 py-2.5",
                  STATE_CLASSES[state],
                )}
              >
                <a
                  className="min-w-0 flex-1 truncate font-semibold text-[var(--link)] [text-decoration-thickness:1px] [text-underline-offset:0.18em]"
                  href={`/wiki/${toWikiSegment(item.title)}`}
                  onClick={(e) => {
                    e.preventDefault();
                    onNavigate(toWikiSegment(item.title));
                  }}
                  title={item.title}
                >
                  {item.title}
                </a>
                <Badge
                  variant={STATE_BADGE[state]}
                  className="shrink-0 font-mono text-[0.66rem] tracking-wide uppercase"
                >
                  {stateLabel(state)}
                </Badge>
                <span className="admin-queue-meta min-w-0 shrink-0 font-mono text-[0.7rem] tracking-wide text-muted-foreground tabular-nums">
                  {timer} · {workflowLabel}
                  {phase ? ` · ${phase}` : ""}
                  {item.waiting > 0 && ` · ${item.waiting} waiting`}
                </span>
                {item.views?.length || item.reasoning ? (
                  <div className="mt-1 w-full min-w-0 basis-full">
                    <LiveLlmViews
                      views={
                        item.views?.length
                          ? item.views
                          : [
                              {
                                node: item.phase ?? "Current model",
                                reasoning: item.reasoning,
                              },
                            ]
                      }
                    />
                  </div>
                ) : null}
              </li>
            );
          })}
        </ul>
      ) : (
        <p className="m-0 text-sm text-muted-foreground italic">
          No active article generations.
        </p>
      )}
    </Pane>
  );
}
