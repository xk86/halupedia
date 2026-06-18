import { useEffect, useRef, useState } from "react";
import clsx from "clsx";
import { Pane } from "../Pane";
import { toWikiSegment } from "../../wikiPath";

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

/**
 * Live model chain-of-thought for the currently-generating item. Admin-only —
 * this pane lives entirely behind the admin panel. Auto-scrolls to follow the
 * stream unless the user has scrolled up to read earlier reasoning.
 */
function LiveCot({ text }: { text: string }) {
  const [open, setOpen] = useState(true);
  const boxRef = useRef<HTMLPreElement>(null);
  const pinnedToBottom = useRef(true);

  useEffect(() => {
    const box = boxRef.current;
    if (!box || !open || !pinnedToBottom.current) return;
    box.scrollTop = box.scrollHeight;
  }, [text, open]);

  return (
    <div className="mt-[0.2rem] flex-[1_1_100%]">
      <button
        type="button"
        className="cursor-pointer border-none bg-none p-0 font-mono text-[0.72rem] tracking-[0.06em] text-ink-fade hover:text-ink"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
      >
        {open ? "▾" : "▸"} thinking ({text.length.toLocaleString()} chars)
      </button>
      {open && (
        <pre
          ref={boxRef}
          className="mx-0 mt-[0.35rem] mb-0 max-h-[14rem] overflow-y-auto rounded-[4px] bg-[var(--surface-sunken,rgba(0,0,0,0.04))] px-[0.7rem] py-[0.55rem] font-mono text-[0.72rem] leading-[1.5] break-words whitespace-pre-wrap text-ink-fade [border:1px_solid_var(--rule)]"
          onScroll={(e) => {
            const el = e.currentTarget;
            pinnedToBottom.current =
              el.scrollHeight - el.scrollTop - el.clientHeight < 24;
          }}
        >
          {text}
        </pre>
      )}
    </div>
  );
}

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
  queued: "[border-left:3px_solid_#a87d2a] bg-[rgba(168,125,42,0.08)]",
  processing: "[border-left:3px_solid_#4d7f93] bg-[rgba(77,127,147,0.08)]",
  llm: "[border-left:3px_solid_var(--accent)] bg-accent-wash",
};

export function GenerationQueuePane({ items, onNavigate }: Props) {
  const queued = items.filter((item) => queueState(item) === "queued").length;
  const active = items.length - queued;
  return (
    <Pane
      id="generation-queue"
      title="Generation Queue"
      count={`${active} active · ${queued} queued`}
    >
      {items.length ? (
        <ul className="mx-0 mt-[0.85rem] mb-0 flex list-none flex-col gap-[0.55rem] p-0">
          {items.map((item) => {
            const phase = formatPhase(item.phase);
            const workflowLabel = formatWorkflow(item.workflow);
            const state = queueState(item);
            const timer =
              state === "queued"
                ? `${formatDuration(item.queuedMs)} queued`
                : `${formatDuration(item.activeMs)} active`;
            return (
              <li
                key={`${item.slug}-${item.seq}`}
                className={clsx(
                  "flex flex-wrap items-center justify-between gap-x-4 gap-y-[0.4rem] px-[0.7rem] py-[0.65rem] [border-top:1px_solid_var(--rule)] max-[600px]:flex-col max-[600px]:items-start max-[600px]:gap-1",
                  STATE_CLASSES[state],
                )}
              >
                <a
                  className="font-semibold text-[var(--link)] [text-decoration-thickness:1px] [text-underline-offset:0.18em]"
                  href={`/wiki/${toWikiSegment(item.title)}`}
                  onClick={(e) => {
                    e.preventDefault();
                    onNavigate(toWikiSegment(item.title));
                  }}
                >
                  {item.title}
                </a>
                <span className="admin-queue-meta shrink-0 font-mono text-[0.72rem] tracking-[0.08em] text-ink-fade uppercase">
                  {stateLabel(state)} · {timer} · {workflowLabel}
                  {phase ? ` · ${phase}` : ""}
                  {item.waiting > 0 && ` · ${item.waiting} waiting`}
                </span>
                {item.reasoning ? <LiveCot text={item.reasoning} /> : null}
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
