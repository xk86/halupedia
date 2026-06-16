import { ReactNode, useCallback, useState } from "react";

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

  const toggle = useCallback(() => {
    setCollapsed((prev) => {
      const next = !prev;
      try {
        localStorage.setItem(`admin:pane:${id}`, String(next));
      } catch {}
      return next;
    });
  }, [id]);

  return (
    <div
      className="group overflow-hidden rounded-[6px] bg-[var(--bg)] [border:1px_solid_var(--rule)] data-[span=wide]:col-[1/-1]"
      data-collapsed={collapsed}
      data-span={wide ? "wide" : undefined}
    >
      <div
        className="flex cursor-pointer items-center justify-between gap-[0.5rem] bg-blockquote-bg px-[0.85rem] py-[0.6rem] select-none [border-bottom:1px_solid_var(--rule)] hover:bg-[var(--hover-bg,color-mix(in_srgb,var(--blockquote-bg)_85%,var(--ink)_15%))]"
        onClick={toggle}
        role="button"
        aria-expanded={!collapsed}
        aria-controls={`pane-body-${id}`}
      >
        <div className="flex min-w-0 flex-1 items-center gap-[0.5rem]">
          <span
            className="shrink-0 text-[0.75rem] text-ink-soft [transition:rotate_140ms_ease] group-data-[collapsed=true]:-rotate-90"
            aria-hidden
          >
            ▾
          </span>
          <h3 className="sb-heading m-0! text-[0.85rem]!">{title}</h3>
          {count !== undefined && (
            <span className="all-entries-count">{count}</span>
          )}
        </div>
        {actions && (
          <div
            className="flex shrink-0 items-center gap-[0.4rem]"
            onClick={(e) => e.stopPropagation()}
          >
            {actions}
          </div>
        )}
      </div>
      <div
        id={`pane-body-${id}`}
        className="p-[0.85rem] group-data-[collapsed=true]:hidden"
      >
        {children}
      </div>
    </div>
  );
}
