import { ReactNode, useCallback, useState } from "react";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { COUNT_LABEL } from "./ui";

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
    <Collapsible
      open={!collapsed}
      onOpenChange={(open) => setCollapsedPersist(!open)}
      className="overflow-hidden rounded-[6px] bg-[var(--bg)] [border:1px_solid_var(--rule)] data-[span=wide]:col-[1/-1]"
      data-span={wide ? "wide" : undefined}
    >
      <div className="flex items-center justify-between gap-[0.5rem] bg-blockquote-bg px-[0.85rem] py-[0.6rem] [border-bottom:1px_solid_var(--rule)] hover:bg-[var(--hover-bg,color-mix(in_srgb,var(--blockquote-bg)_85%,var(--ink)_15%))]">
        <CollapsibleTrigger className="group flex min-w-0 flex-1 cursor-pointer items-center gap-[0.5rem] text-left select-none">
          <span
            className="shrink-0 text-[0.75rem] text-ink-soft [transition:rotate_140ms_ease] group-not-data-[panel-open]:-rotate-90"
            aria-hidden
          >
            ▾
          </span>
          <h3 className="sb-heading m-0! text-[0.85rem]!">{title}</h3>
          {count !== undefined && <span className={COUNT_LABEL}>{count}</span>}
        </CollapsibleTrigger>
        {actions && (
          <div className="flex shrink-0 items-center gap-[0.4rem]">
            {actions}
          </div>
        )}
      </div>
      <CollapsibleContent>
        <div className="p-[0.85rem]">{children}</div>
      </CollapsibleContent>
    </Collapsible>
  );
}
