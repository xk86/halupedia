import { useId, useRef, useState } from "react";
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
import { usePersistentDragPosition } from "./usePersistentDragPosition";

const BUTTON_POSITION_STORAGE_KEY =
  "halupedia:research-chat-button-position:v1";
const PANEL_POSITION_STORAGE_KEY = "halupedia:research-chat-panel-position:v1";

function isHeaderDragTarget(target: EventTarget | null) {
  return !(
    target instanceof Element &&
    target.closest("button, a, input, textarea, select")
  );
}

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
  const buttonRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const descriptionId = useId();
  const buttonDrag = usePersistentDragPosition({
    storageKey: BUTTON_POSITION_STORAGE_KEY,
    elementRef: buttonRef,
    fallback: () => ({
      x: Math.max(0, window.innerWidth - 64),
      y: Math.max(0, window.innerHeight - 64),
    }),
    active: !open,
  });
  const panelDrag = usePersistentDragPosition({
    storageKey: PANEL_POSITION_STORAGE_KEY,
    elementRef: panelRef,
    fallback: () => ({
      x: Math.max(0, window.innerWidth - 400),
      y: Math.max(0, window.innerHeight - 640),
    }),
    active: open,
    shouldStartDrag: isHeaderDragTarget,
  });

  return (
    <div className="pointer-events-none fixed inset-0 z-40">
      {open ? (
        <div
          ref={panelRef}
          style={panelDrag.style}
          className="pointer-events-auto absolute"
        >
          <Card
            role="dialog"
            aria-labelledby={titleId}
            aria-describedby={descriptionId}
            className="h-[min(36rem,calc(100dvh-2rem))] w-[min(24rem,calc(100vw-2rem))] gap-0 py-0 shadow-lg"
          >
            <CardHeader
              {...panelDrag.dragHandleProps}
              className="cursor-grab touch-none border-b border-border py-4 select-none active:cursor-grabbing"
            >
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
        </div>
      ) : (
        <div
          ref={buttonRef}
          style={buttonDrag.style}
          className="pointer-events-auto absolute touch-none"
          onPointerDownCapture={buttonDrag.dragHandleProps.onPointerDown}
          onPointerMoveCapture={buttonDrag.dragHandleProps.onPointerMove}
          onPointerUpCapture={buttonDrag.dragHandleProps.onPointerUp}
          onPointerCancelCapture={buttonDrag.dragHandleProps.onPointerCancel}
          onMouseDownCapture={buttonDrag.mouseDragHandleProps.onMouseDown}
        >
          <Button
            type="button"
            size="icon"
            aria-label="Ask the research chat"
            title="Ask the research chat"
            className="size-12 rounded-full shadow-lg"
            onClick={() => {
              if (!buttonDrag.consumeDragClick()) setOpen(true);
            }}
          >
            <MessageCircleIcon />
          </Button>
        </div>
      )}
    </div>
  );
}
