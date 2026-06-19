import { ReactNode, useCallback, useState } from "react";
import { ChevronDown } from "lucide-react";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";

interface Props {
  id: string;
  title: string;
  count?: string;
  actions?: ReactNode;
  defaultCollapsed?: boolean;
  wide?: boolean;
  children: ReactNode;
}

function readCollapsed(id: string, defaultCollapsed: boolean): boolean {
  try {
    const stored = localStorage.getItem(`admin:pane:${id}`);
    if (stored !== null) return stored === "true";
  } catch {}
  return defaultCollapsed;
}

export function Pane({
  id,
  title,
  count,
  actions,
  defaultCollapsed = false,
  wide = false,
  children,
}: Props) {
  const [collapsed, setCollapsed] = useState(() =>
    readCollapsed(id, defaultCollapsed),
  );

  const setCollapsedPersist = useCallback(
    (next: boolean) => {
      setCollapsed(next);
      try {
        localStorage.setItem(`admin:pane:${id}`, String(next));
      } catch {}
    },
    [id],
  );

  return (
    <Card
      data-span={wide ? "wide" : undefined}
      className="gap-0 overflow-hidden py-0 font-sans data-[span=wide]:col-[1/-1]"
    >
      <Collapsible
        open={!collapsed}
        onOpenChange={(open) => setCollapsedPersist(!open)}
      >
        <div className="flex items-center justify-between gap-2 border-b border-border bg-muted/40 px-4 py-2.5 transition-colors hover:bg-muted/70">
          <CollapsibleTrigger className="group/trigger flex min-w-0 flex-1 cursor-pointer appearance-none items-center gap-2 border-0 bg-transparent p-0 text-left select-none">
            <ChevronDown
              aria-hidden
              className="size-4 shrink-0 text-muted-foreground transition-transform duration-150 group-not-data-[panel-open]/trigger:-rotate-90"
            />
            <h3 className="m-0 truncate text-[0.92rem] leading-none font-semibold tracking-tight text-foreground">
              {title}
            </h3>
            {count !== undefined && (
              <Badge
                variant="secondary"
                className="ml-1 shrink-0 font-mono text-[0.68rem] font-normal tracking-wide text-muted-foreground tabular-nums uppercase"
              >
                {count}
              </Badge>
            )}
          </CollapsibleTrigger>
          {actions && (
            <div className="flex shrink-0 items-center gap-1.5">{actions}</div>
          )}
        </div>
        <CollapsibleContent>
          <CardContent className="min-w-0 px-4 py-4">{children}</CardContent>
        </CollapsibleContent>
      </Collapsible>
    </Card>
  );
}
