import { useCallback, useEffect, useRef, useState } from "react";
import { ChevronRightIcon, SendIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { useChatStream } from "./useChatStream";
import { renderChatMarkdown } from "./renderChatMarkdown";
import { toWikiSegment } from "../wikiPath";
import type { ChatUiMessage, ResearchTraceEntry } from "./types";

/** Human-readable verb + target for a research step, from its tool + args. */
function describeStep(entry: ResearchTraceEntry): { label: string; target?: string } {
  const args = entry.args ?? {};
  const str = (v: unknown) => (typeof v === "string" ? v : undefined);
  switch (entry.tool) {
    case "search_articles":
      return { label: "Searched", target: str(args.query) };
    case "find_articles_by_title":
      return { label: "Looked up", target: str(args.query) };
    case "read_article":
      return {
        label: "Read",
        target: [str(args.slug), str(args.section)].filter(Boolean).join(" › "),
      };
    case "get_ontology_facts":
      return { label: "Fetched facts for", target: str(args.slug) };
    default:
      return { label: entry.tool ?? "Step", target: str(Object.values(args)[0]) };
  }
}

function ResearchTrace({ entries }: { entries: ResearchTraceEntry[] }) {
  return (
    <div className="mt-1 flex flex-col gap-2 border-l border-border pl-2.5">
      {entries.map((entry, i) => {
        if (!entry.tool) {
          return (
            <p key={i} className="text-xs text-muted-foreground italic">
              {entry.thought}
            </p>
          );
        }
        const { label, target } = describeStep(entry);
        return (
          <div key={i} className="flex flex-col gap-0.5 text-xs">
            <div className="flex flex-wrap items-baseline gap-1.5">
              <span className="font-medium text-foreground">{label}</span>
              {target && (
                <span className="rounded bg-muted px-1 py-0.5 text-muted-foreground">
                  {target}
                </span>
              )}
            </div>
            {entry.thought && (
              <p className="text-muted-foreground italic">{entry.thought}</p>
            )}
            {entry.result && (
              <pre className="mt-0.5 max-h-40 overflow-y-auto whitespace-pre-wrap rounded bg-muted/60 px-2 py-1 font-sans text-[0.6875rem] leading-snug text-muted-foreground">
                {entry.result}
              </pre>
            )}
          </div>
        );
      })}
    </div>
  );
}

interface ChatPanelProps {
  slug?: string;
  articleTitle?: string;
  onNavigateToArticle: (slugOrTitle: string, explicitTitle?: string) => void;
}

function AssistantContent({
  message,
  onNavigateToArticle,
}: {
  message: ChatUiMessage;
  onNavigateToArticle: (slugOrTitle: string, explicitTitle?: string) => void;
}) {
  const handleClick = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      const anchor = (e.target as HTMLElement).closest("a");
      const href = anchor?.getAttribute("href");
      if (!href?.startsWith("/wiki/")) return;
      e.preventDefault();
      onNavigateToArticle(href.slice("/wiki/".length));
    },
    [onNavigateToArticle],
  );

  const trace = message.trace;
  const steps = message.steps;
  const stepCount = trace?.length ?? steps?.length ?? 0;
  const hasReasoning = stepCount > 0;

  return (
    <div>
      {hasReasoning && (
        <Collapsible className="mb-1.5">
          <CollapsibleTrigger className="group flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground">
            <ChevronRightIcon className="size-3 shrink-0 transition-transform duration-150 data-panel-open:rotate-90" />
            {message.pending
              ? "Researching…"
              : `Reasoning & sources (${stepCount} step${stepCount === 1 ? "" : "s"})`}
          </CollapsibleTrigger>
          <CollapsibleContent>
            {trace?.length ? (
              <ResearchTrace entries={trace} />
            ) : (
              <div className="mt-1 flex flex-col gap-0.5 border-l border-border pl-2 text-xs text-muted-foreground italic">
                {steps!.map((step, i) => (
                  <div key={i}>{step}</div>
                ))}
              </div>
            )}
          </CollapsibleContent>
        </Collapsible>
      )}
      {message.content ? (
        <div
          className="prose prose-sm dark:prose-invert max-w-none [&_p:first-child]:mt-0 [&_p:last-child]:mb-0"
          onClick={handleClick}
          dangerouslySetInnerHTML={{
            __html: renderChatMarkdown(message.content, message.references),
          }}
        />
      ) : message.pending ? (
        <p className="text-sm text-muted-foreground italic">Thinking…</p>
      ) : null}
      {message.references && message.references.length > 0 && (
        <div className="mt-2 border-t border-border pt-2">
          <p className="mb-1 text-[0.6875rem] font-medium tracking-wide text-muted-foreground uppercase">
            Sources
          </p>
          <div className="flex flex-wrap gap-1.5">
            {message.references.map((ref) => (
              <a
                key={ref.slug}
                href={`/wiki/${toWikiSegment(ref.title)}`}
                onClick={(e) => {
                  e.preventDefault();
                  onNavigateToArticle(ref.title, ref.title);
                }}
                className="rounded-md bg-muted px-1.5 py-0.5 text-xs text-muted-foreground hover:text-foreground"
                title={ref.relevance}
              >
                {ref.title}
              </a>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

export function ChatPanel({ slug, articleTitle, onNavigateToArticle }: ChatPanelProps) {
  const { messages, send, busy } = useChatStream(slug);
  const [draft, setDraft] = useState("");
  const scrollRef = useRef<HTMLDivElement | null>(null);

  // When the chat is opened on an article, offer a one-tap prompt about it.
  // Hidden once the user starts typing so it never fights the draft.
  const showArticleSuggestion = !!articleTitle && !busy && !draft.trim();

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages]);

  const submit = useCallback(() => {
    if (!draft.trim() || busy) return;
    void send(draft);
    setDraft("");
  }, [draft, busy, send]);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div ref={scrollRef} className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-4">
        {messages.length === 0 && (
          <p className="text-sm text-muted-foreground">
            Ask a question about the wiki — I'll research it and answer in
            character.
          </p>
        )}
        {messages.map((message) =>
          message.role === "user" ? (
            <div
              key={message.id}
              className="ml-auto max-w-[85%] rounded-lg bg-primary px-3 py-2 text-sm text-primary-foreground"
            >
              {message.content}
            </div>
          ) : (
            <div
              key={message.id}
              className="mr-auto max-w-[90%] rounded-lg bg-muted px-3 py-2"
            >
              <AssistantContent
                message={message}
                onNavigateToArticle={onNavigateToArticle}
              />
            </div>
          ),
        )}
      </div>
      {showArticleSuggestion && (
        <div className="flex flex-wrap gap-1.5 px-3 pb-1">
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-auto py-1 text-xs font-normal"
            onClick={() => void send(`Tell me about ${articleTitle}.`)}
          >
            Ask about {articleTitle}
          </Button>
        </div>
      )}
      <div className="flex items-end gap-2 border-t border-border p-3">
        <Textarea
          value={draft}
          onChange={(e) => setDraft(e.currentTarget.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              submit();
            }
          }}
          placeholder="Ask about the wiki…"
          rows={1}
          spellCheck
          className="max-h-32 min-h-0 resize-none font-sans"
        />
        <Button
          type="button"
          size="icon"
          aria-label="Send"
          disabled={busy || !draft.trim()}
          onClick={submit}
        >
          <SendIcon />
        </Button>
      </div>
    </div>
  );
}
