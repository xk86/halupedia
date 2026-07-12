import { useState } from "react";
import { MessageCircleIcon, XIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverDescription,
  PopoverHeader,
  PopoverTitle,
  PopoverTrigger,
} from "@/components/ui/popover";
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

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <Button
            type="button"
            size="icon"
            aria-label="Ask the research chat"
            title="Ask the research chat"
            className="fixed right-4 bottom-4 size-12 rounded-full shadow-lg"
          />
        }
      >
        <MessageCircleIcon />
      </PopoverTrigger>
      <PopoverContent
        side="top"
        align="end"
        sideOffset={12}
        className="h-[min(36rem,calc(100dvh-6rem))] w-[min(24rem,calc(100vw-2rem))] gap-0 overflow-hidden p-0 shadow-lg"
      >
        <PopoverHeader className="grid grid-cols-[1fr_auto] items-start gap-x-3 border-b border-border p-4">
          <PopoverTitle className="text-base">Research chat</PopoverTitle>
          <PopoverDescription className="text-xs">
            Answers grounded in your wiki
          </PopoverDescription>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label="Close research chat"
            className="col-start-2 row-span-2 row-start-1"
            onClick={() => setOpen(false)}
          >
            <XIcon />
          </Button>
        </PopoverHeader>
        <ChatPanel
          slug={slug}
          articleTitle={articleTitle}
          onNavigateToArticle={onNavigateToArticle}
        />
      </PopoverContent>
    </Popover>
  );
}
