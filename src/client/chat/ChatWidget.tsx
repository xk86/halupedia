import { useId, useState } from "react";
import { MessageCircleIcon, XIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { ChatPanel } from "./ChatPanel";

interface ChatWidgetProps {
  slug?: string;
  articleTitle?: string;
  onNavigateToArticle: (slugOrTitle: string, explicitTitle?: string) => void;
}

/** Persistent floating research-chat button, mounted once at the app shell
 *  level so it survives route changes. Toggled off entirely in user settings
 *  (see `Settings.tsx`'s "Research chat" field). */
export function ChatWidget({
  slug,
  articleTitle,
  onNavigateToArticle,
}: ChatWidgetProps) {
  const [open, setOpen] = useState(false);
  const titleId = useId();
  const descriptionId = useId();

  return (
    <div className="fixed right-4 bottom-4 z-40">
      {open ? (
        <Card
          role="dialog"
          aria-labelledby={titleId}
          aria-describedby={descriptionId}
          className="absolute right-0 bottom-16 h-[min(36rem,calc(100dvh-6rem))] w-[min(24rem,calc(100vw-2rem))] gap-0 py-0 shadow-lg"
        >
          <CardHeader className="border-b border-border py-4">
            <CardTitle id={titleId}>Research chat</CardTitle>
            <CardDescription id={descriptionId} className="text-xs">
              Answers grounded in your wiki
            </CardDescription>
            <CardAction>
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                aria-label="Close research chat"
                onClick={() => setOpen(false)}
              >
                <XIcon />
              </Button>
            </CardAction>
          </CardHeader>
          <CardContent className="flex min-h-0 flex-1 p-0">
            <ChatPanel
              slug={slug}
              articleTitle={articleTitle}
              onNavigateToArticle={onNavigateToArticle}
            />
          </CardContent>
        </Card>
      ) : (
        <Button
          type="button"
          size="icon"
          aria-label="Ask the research chat"
          title="Ask the research chat"
          className="size-12 rounded-full shadow-lg"
          onClick={() => setOpen(true)}
        >
          <MessageCircleIcon />
        </Button>
      )}
    </div>
  );
}
