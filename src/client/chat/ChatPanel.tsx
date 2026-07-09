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
import type { ChatUiMessage } from "./types";

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

  const hasSteps = !!message.steps?.length;

  return (
    <div>
      {hasSteps && (
        <Collapsible className="mb-1.5">
          <CollapsibleTrigger className="group flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground">
            <ChevronRightIcon className="size-3 shrink-0 transition-transform duration-150 data-panel-open:rotate-90" />
            {message.pending
              ? "Researching…"
              : `Research steps (${message.steps!.length})`}
          </CollapsibleTrigger>
          <CollapsibleContent className="mt-1 flex flex-col gap-0.5 border-l border-border pl-2 text-xs text-muted-foreground italic">
            {message.steps!.map((step, i) => (
              <div key={i}>{step}</div>
            ))}
          </CollapsibleContent>
        </Collapsible>
      )}
      {message.content ? (
        <div
          className="prose prose-sm dark:prose-invert max-w-none [&_p:first-child]:mt-0 [&_p:last-child]:mb-0"
          onClick={handleClick}
          dangerouslySetInnerHTML={{ __html: renderChatMarkdown(message.content) }}
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

export function ChatPanel({ slug, onNavigateToArticle }: ChatPanelProps) {
  const { messages, send, busy } = useChatStream(slug);
  const [draft, setDraft] = useState("");
  const scrollRef = useRef<HTMLDivElement | null>(null);

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
