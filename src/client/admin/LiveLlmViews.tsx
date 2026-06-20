import { useEffect, useRef, useState } from "react";
import { ChevronDown } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

export interface LiveLlmView {
  node: string;
  reasoning?: string;
  response?: string;
}

export function LiveLlmViews({ views }: { views: LiveLlmView[] }) {
  if (views.length === 0) {
    return (
      <p className="m-0 text-sm text-muted-foreground italic">
        Waiting for the first model token…
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      {views.map((view, index) => (
        <LiveLlmNode
          key={view.node}
          view={view}
          current={index === views.length - 1}
        />
      ))}
    </div>
  );
}

function LiveLlmNode({
  view,
  current,
}: {
  view: LiveLlmView;
  current: boolean;
}) {
  const [open, setOpen] = useState(current);
  const defaultTab = view.reasoning ? "reasoning" : "response";

  return (
    <Card size="sm">
      <Collapsible open={open} onOpenChange={setOpen}>
        <CardHeader>
          <CollapsibleTrigger className="group/trigger flex w-full cursor-pointer items-center gap-2 border-0 bg-transparent p-0 text-left">
            <ChevronDown
              aria-hidden
              className="shrink-0 text-muted-foreground transition-transform group-not-data-[panel-open]/trigger:-rotate-90"
            />
            <CardTitle className="min-w-0 flex-1 truncate font-mono">
              {view.node}
            </CardTitle>
            {current ? (
              <Badge>Live</Badge>
            ) : (
              <Badge variant="secondary">Complete</Badge>
            )}
          </CollapsibleTrigger>
        </CardHeader>
        <CollapsibleContent>
          <CardContent className="pt-2">
            <Tabs defaultValue={defaultTab}>
              <TabsList className="max-w-full">
                <TabsTrigger value="reasoning" disabled={!view.reasoning}>
                  Reasoning
                  {view.reasoning
                    ? ` (${view.reasoning.length.toLocaleString()})`
                    : ""}
                </TabsTrigger>
                <TabsTrigger value="response" disabled={!view.response}>
                  Response
                  {view.response
                    ? ` (${view.response.length.toLocaleString()})`
                    : ""}
                </TabsTrigger>
              </TabsList>
              <TabsContent value="reasoning">
                <LiveText text={view.reasoning ?? ""} />
              </TabsContent>
              <TabsContent value="response">
                <LiveText text={view.response ?? ""} />
              </TabsContent>
            </Tabs>
          </CardContent>
        </CollapsibleContent>
      </Collapsible>
    </Card>
  );
}

function LiveText({ text }: { text: string }) {
  const ref = useRef<HTMLPreElement>(null);
  const pinnedToBottom = useRef(true);

  useEffect(() => {
    const element = ref.current;
    if (!element || !pinnedToBottom.current) return;
    element.scrollTop = element.scrollHeight;
  }, [text]);

  return (
    <pre
      ref={ref}
      className="m-0 max-h-80 max-w-full overflow-auto rounded-lg bg-muted/50 p-3 font-mono text-xs leading-relaxed break-words whitespace-pre-wrap text-foreground"
      onScroll={(event) => {
        const element = event.currentTarget;
        pinnedToBottom.current =
          element.scrollHeight - element.scrollTop - element.clientHeight < 24;
      }}
    >
      {text}
    </pre>
  );
}
