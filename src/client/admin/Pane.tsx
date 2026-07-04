import { ReactNode, useCallback, useState } from "react";
import {
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  GripVertical,
} from "lucide-react";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useTileControls } from "./AdminLayout";

interface Props {
  id: string;
  title: string;
  description?: string;
  count?: string;
  actions?: ReactNode;
  defaultCollapsed?: boolean;
  wide?: boolean;
  children: ReactNode;
}

function readCollapsed(id: string, defaultCollapsed: boolean): boolean {
  try {
    const stored = localStorage.getItem(`admin:pane:v3:${id}`);
    if (stored !== null) return stored === "true";
  } catch {}
  return defaultCollapsed;
}

export function Pane({
  id,
  title,
  description,
  count,
  actions,
  defaultCollapsed = false,
  wide = false,
  children,
}: Props) {
  const [collapsed, setCollapsed] = useState(() =>
    readCollapsed(id, defaultCollapsed),
  );
  const tileControls = useTileControls(id);

  const setCollapsedPersist = useCallback(
    (next: boolean) => {
      setCollapsed(next);
      try {
        localStorage.setItem(`admin:pane:v3:${id}`, String(next));
      } catch {}
    },
    [id],
  );

  return (
    <Card
      size="sm"
      data-span={wide ? "wide" : undefined}
      className="gap-0 overflow-hidden py-0 font-sans data-[span=wide]:col-[1/-1]"
    >
      <Collapsible
        open={!collapsed}
        onOpenChange={(open) => setCollapsedPersist(!open)}
      >
        <CardHeader className="grid-cols-[minmax(0,1fr)_auto] border-b py-(--card-spacing)">
          <div className="flex min-w-0 items-start gap-1.5">
            {tileControls ? (
              <span
                draggable={tileControls.draggable}
                onDragStart={tileControls.onDragStart}
                onDragEnd={tileControls.onDragEnd}
                className="mt-0.5 inline-flex cursor-grab touch-none items-center text-muted-foreground active:cursor-grabbing"
                aria-label={`Drag ${title} to rearrange`}
                title="Drag to rearrange"
              >
                <GripVertical aria-hidden />
              </span>
            ) : null}
            <CollapsibleTrigger className="group/trigger flex min-w-0 cursor-pointer items-center gap-2 border-0 bg-transparent p-0 text-left">
              <ChevronDown
                data-icon="inline-start"
                aria-hidden
                className="shrink-0 text-muted-foreground transition-transform group-not-data-[panel-open]/trigger:-rotate-90"
              />
              <div className="min-w-0">
                <CardTitle>
                  <h3 className="font:inherit m-0 truncate">{title}</h3>
                </CardTitle>
                {description ? (
                  <CardDescription className="truncate">
                    {description}
                  </CardDescription>
                ) : null}
              </div>
            </CollapsibleTrigger>
          </div>
          {count !== undefined || actions ? (
            <CardAction className="flex items-center gap-2">
              {count !== undefined && (
                <Badge variant="secondary">{count}</Badge>
              )}
              {actions}
              {tileControls ? (
                <div className="flex items-center gap-0.5">
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    disabled={!tileControls.canMoveEarlier}
                    onClick={tileControls.moveEarlier}
                    aria-label={`Move ${title} earlier`}
                    title="Move earlier"
                  >
                    <ChevronLeft />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    disabled={!tileControls.canMoveLater}
                    onClick={tileControls.moveLater}
                    aria-label={`Move ${title} later`}
                    title="Move later"
                  >
                    <ChevronRight />
                  </Button>
                </div>
              ) : null}
            </CardAction>
          ) : tileControls ? (
            <CardAction className="flex items-center gap-0.5">
              <Button
                variant="ghost"
                size="icon-xs"
                disabled={!tileControls.canMoveEarlier}
                onClick={tileControls.moveEarlier}
                aria-label={`Move ${title} earlier`}
                title="Move earlier"
              >
                <ChevronLeft />
              </Button>
              <Button
                variant="ghost"
                size="icon-xs"
                disabled={!tileControls.canMoveLater}
                onClick={tileControls.moveLater}
                aria-label={`Move ${title} later`}
                title="Move later"
              >
                <ChevronRight />
              </Button>
            </CardAction>
          ) : null}
        </CardHeader>
        <CollapsibleContent>
          <CardContent className="min-w-0 py-(--card-spacing)">
            {children}
          </CardContent>
        </CollapsibleContent>
      </Collapsible>
    </Card>
  );
}
