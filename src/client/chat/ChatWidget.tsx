import { useState } from "react";
import { MessageCircleIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from "@/components/ui/sheet";
import { ChatPanel } from "./ChatPanel";

interface ChatWidgetProps {
  slug?: string;
  articleTitle?: string;
  onNavigateToArticle: (slugOrTitle: string, explicitTitle?: string) => void;
}

/** Persistent floating research-chat button, mounted once at the app shell
 *  level so it survives route changes. Toggled off entirely in user settings
 *  (see `Settings.tsx`'s "Research chat" field). */
export function ChatWidget({ slug, articleTitle, onNavigateToArticle }: ChatWidgetProps) {
  const [open, setOpen] = useState(false);

  return (
    <>
      <Button
        type="button"
        size="icon"
        aria-label="Ask the research chat"
        title="Ask the research chat"
        className="fixed right-4 bottom-4 z-40 size-12 rounded-full shadow-lg"
        onClick={() => setOpen(true)}
      >
        <MessageCircleIcon className="size-5" />
      </Button>
      <Sheet open={open} onOpenChange={setOpen}>
        <SheetContent side="right" className="w-full sm:max-w-md">
          <SheetHeader>
            <SheetTitle>Research chat</SheetTitle>
            <SheetDescription className="sr-only">
              Ask questions about the wiki and get answers grounded in its
              articles.
            </SheetDescription>
          </SheetHeader>
          <ChatPanel
            slug={slug}
            articleTitle={articleTitle}
            onNavigateToArticle={onNavigateToArticle}
          />
        </SheetContent>
      </Sheet>
    </>
  );
}
